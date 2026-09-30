'use strict';
/*
 * herdr.js — optional Herdr bridge for agent runs (TGA_HERDR=1).
 *
 * Instead of an invisible detached spawn, each turn runs inside a pane of the
 * "telegram" herdr workspace (TGA_HERDR_WS overrides the label), so it shows
 * up in the herdr TUI — and on ssh-pi.haiho.net — while it works.
 *
 * The pane is a VIEWER, not the result pipe. run.sh tees stdout to a capture
 * file the bot tails and feeds to the same backend parser; stderr and the
 * exit code land in sibling files. Cancel = ctrl+c into the pane; force =
 * pane close. Any launch failure falls back to the normal spawn in bot.js.
 *
 * env vars: TGA_HERDR=1 · TGA_HERDR_WS=<workspace label or id> ·
 *           TGA_HERDR_BIN=<herdr executable> (default "herdr" on PATH)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { EventEmitter } = require('events');

function env(name, def) {
  const v = process.env[`TGA_${name}`];
  if (v !== undefined && v !== '') return v;
  const legacy = process.env[`CLAUDE_TG_${name}`];
  if (legacy !== undefined && legacy !== '') return legacy;
  return def;
}

const enabled = () => /^(1|true|yes|on)$/i.test(env('HERDR', ''));
const BIN = () => env('HERDR_BIN', 'herdr');
const WS_NAME = () => env('HERDR_WS', 'telegram');
const POLL_MS = 400;
// If the pane's shell dies without writing `code`, this is how long we still
// wait for the file before declaring the run dead — covers the race where the
// pid check observes the dying shell a tick before bash writes the code.
const CODE_GRACE_MS = 2500;
// A pid file that never appears means `pane run` never reached a shell.
const START_GRACE_MS = 15000;

function cli(args, timeout = 15000) {
  return new Promise((resolve, reject) => {
    execFile(BIN(), args, { timeout, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((String(stderr || '').trim() || err.message)));
      resolve(stdout);
    });
  });
}

const cliJson = async (args) => JSON.parse(await cli(args));

/** Workspace id for TGA_HERDR_WS, creating the workspace on first use. */
let wsPromise = null;
function workspaceId() {
  if (!wsPromise) {
    wsPromise = (async () => {
      const want = WS_NAME();
      const list = await cliJson(['workspace', 'list']);
      const hit = ((list.result || {}).workspaces || [])
        .find((w) => w.label === want || w.workspace_id === want);
      if (hit) return hit.workspace_id;
      const made = await cliJson(['workspace', 'create', '--cwd', os.homedir(), '--label', want, '--no-focus']);
      return made.result.workspace.workspace_id;
    })().catch((e) => { wsPromise = null; throw e; });
  }
  return wsPromise;
}

/** POSIX-safe single-quote. */
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function buildRunScript(h) {
  const cmd = [h.bin, ...h.args].map(shq).join(' ');
  return [
    '#!/bin/bash',
    `echo $$ > ${shq(h.files.pid)}`,
    `cd ${shq(h.cwd)} || exit 125`,
    // tee via process substitution, agent backgrounded + waited: the run's exit
    // code follows the AGENT, never the pipeline. A grandchild still holding the
    // stdout pipe keeps tee (not the turn) waiting — the orphan trap from
    // bot.js's 'close'-vs-'exit' note applies here too.
    `${cmd} < ${shq(h.files.stdin)} 2> ${shq(h.files.err)} > >(tee ${shq(h.files.out)}) &`,
    'apid=$!',
    'wait $apid',
    `printf '%s' "$?" > ${shq(h.files.code)}`,
    '',
  ].join('\n');
}

/** Read the bytes appended to `file` since `off`; returns the new offset. */
function drain(file, off, emit) {
  let st;
  try { st = fs.statSync(file); } catch (_) { return off; }
  if (st.size <= off) return off;
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(st.size - off);
    fs.readSync(fd, buf, 0, buf.length, off);
    fs.closeSync(fd);
    emit(buf.toString('utf8'));
  } catch (_) {}
  return st.size;
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };

/**
 * Launch {bin,args} inside a new herdr tab in `cwd`. `env` is the FULL env map
 * the process must see (same map spawn() would get) — it reaches the pane via
 * `tab create --env`, so nothing secret is written into the run directory.
 * `prompt` is used only when `stdinPrompt` is set (fed via a file redirect).
 *
 * Resolves to a child_process-shaped EventEmitter: stdin/stdout/stderr
 * streams, 'exit'/'close'/'error' events, kill() — so runJob's pipeline
 * (parser feed, /stop, timeout) works unchanged.
 */
async function launch({ bin, args, cwd, env: fullEnv, prompt, stdinPrompt, label }) {
  const ws = await workspaceId();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tga-herdr-'));
  const h = {
    dir, cwd, bin, args,
    paneId: null, tabId: null, label: String(label || 'tg').replace(/[^\w:.-]+/g, '_').slice(0, 48),
    files: {
      pid: path.join(dir, 'pid'),
      out: path.join(dir, 'out'),
      err: path.join(dir, 'err'),
      code: path.join(dir, 'code'),
      stdin: path.join(dir, 'prompt.txt'),
    },
    done: false, interrupted: false,
  };
  if (!stdinPrompt) h.files.stdin = '/dev/null';
  else fs.writeFileSync(h.files.stdin, prompt == null ? '' : String(prompt));
  fs.writeFileSync(path.join(dir, 'run.sh'), buildRunScript(h), { mode: 0o700 });

  const envArgs = [];
  for (const [k, v] of Object.entries(fullEnv || {})) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) envArgs.push('--env', `${k}=${v}`);
  }
  const t = await cliJson(['tab', 'create', '--workspace', ws, '--cwd', cwd,
    '--label', h.label, '--no-focus', ...envArgs]);
  h.tabId = t.result.tab.tab_id;
  h.paneId = t.result.root_pane.pane_id;
  try {
    await cli(['pane', 'run', h.paneId, `bash ${shq(path.join(dir, 'run.sh'))}`]);
  } catch (e) {
    cli(['tab', 'close', h.tabId]).catch(() => {});
    fs.rm(dir, { recursive: true, force: true }, () => {});
    throw e;
  }
  return makeChild(h);
}

function makeChild(h) {
  const child = new EventEmitter();
  child._herdr = h;
  child.stdin = new EventEmitter();
  child.stdin.end = () => {};
  child.stdin.write = () => true;
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  child.kill = (signal) => { kill(child, signal); return true; };

  let offOut = 0, offErr = 0, shellPid = null, deadSince = 0;
  const startedAt = Date.now();
  const pump = () => {
    if (h.done) return;
    if (shellPid === null) {
      try { shellPid = parseInt(fs.readFileSync(h.files.pid, 'utf8').trim(), 10) || null; } catch (_) {}
      if (shellPid === null && Date.now() - startedAt > START_GRACE_MS) return finish(-1);
    }
    offOut = drain(h.files.out, offOut, (d) => child.stdout.emit('data', d));
    offErr = drain(h.files.err, offErr, (d) => child.stderr.emit('data', d));

    let codeTxt = null;
    try { codeTxt = fs.readFileSync(h.files.code, 'utf8').trim(); } catch (_) {}
    if (codeTxt !== null && codeTxt !== '') {
      // One more drain on the next line so the tail of the pipe lands first.
      offOut = drain(h.files.out, offOut, (d) => child.stdout.emit('data', d));
      offErr = drain(h.files.err, offErr, (d) => child.stderr.emit('data', d));
      const c = parseInt(codeTxt, 10);
      return finish(Number.isFinite(c) ? c : -1);
    }
    if (shellPid !== null && !alive(shellPid)) {
      if (!deadSince) deadSince = Date.now();
      if (Date.now() - deadSince > CODE_GRACE_MS) return finish(-1);
    }
  };
  const timer = setInterval(pump, POLL_MS);
  function finish(code) {
    if (h.done) return;
    h.done = true;
    clearInterval(timer);
    child.emit('exit', code);
    // 'close' trails 'exit' by a beat so tee can flush the agent's last bytes
    // into `out` first — same role as PIPE_GRACE_MS for real pipes.
    setTimeout(() => {
      offOut = drain(h.files.out, offOut, (d) => child.stdout.emit('data', d));
      offErr = drain(h.files.err, offErr, (d) => child.stderr.emit('data', d));
      child.emit('close', code);
      fs.rm(h.dir, { recursive: true, force: true }, () => {});
    }, 600);
  }
  return child;
}

/**
 * killTree() counterpart for pane runs. SIGTERM -> ctrl+c into the pane (the
 * agent and run.sh share a process group, so bash still writes `code` and the
 * turn ends through the normal path). SIGKILL / a second call -> pane close.
 * No-op once the run finished, so the post-exit cleanup in runJob leaves the
 * transcript tab alone.
 */
function kill(child, signal) {
  const h = child && child._herdr;
  if (!h || h.done || !h.paneId) return;
  if (signal !== 'SIGKILL' && !h.interrupted) {
    h.interrupted = true;
    cli(['pane', 'send-keys', h.paneId, 'ctrl+c'], 8000).catch(() => {});
    return;
  }
  cli(['pane', 'close', h.paneId], 8000).catch(() => {});
}

module.exports = { enabled, launch, kill };
