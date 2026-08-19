#!/usr/bin/env node
'use strict';
/*
 * telegram-agents — one Telegram bot, several coding-agent CLIs.
 * https://github.com/hhhai0304/telegram-agents
 *
 *   message  ->  <agent CLI in headless mode>  ->  text + progress back to Telegram
 *
 * Backends live in backends/ (Claude Code, OpenCode, Kilo CLI, Kiro CLI).
 * /agent switches between them per chat; every agent keeps its own session,
 * model and effort, so switching back resumes where you left off.
 *
 * Permissions: only Claude Code has a hookable tool gate. There, with the
 * default TGA_GUARD_MODE=bymode, a PreToolUse hook (approve-hook.js) asks for
 * approval through Telegram buttons, following the risk.js classification. Set
 * TGA_GUARD_MODE=none to run off the leash. The other agents have no such hook
 * and always run in their own "auto-approve" mode — see backends/*.js.
 *
 * No npm dependencies. Node >= 18.
 */

const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const risk = require('./risk.js');
const S = require('./strings');
const backends = require('./backends');

// ---------------------------------------------------------------- config ---

const HOME = os.homedir();
const APP_DIR = __dirname;
const HOOK_FILE = path.join(APP_DIR, 'approve-hook.js');

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadEnvFile(path.join(APP_DIR, 'config.env'));
loadEnvFile(path.join(HOME, '.config', 'telegram_secrets'));

/** TGA_<name>, falling back to the claude-telegram era CLAUDE_TG_<name>. */
function env(name, def) {
  const v = process.env[`TGA_${name}`];
  if (v !== undefined && v !== '') return v;
  const legacy = process.env[`CLAUDE_TG_${name}`];
  if (legacy !== undefined && legacy !== '') return legacy;
  return def;
}

const TOKEN = process.env.TG_BOT_TOKEN;
const ALLOWED = new Set(
  (env('ALLOWED_CHAT_IDS', '') || process.env.TG_CHAT_ID || '')
    .split(',').map((s) => s.trim()).filter(Boolean)
);
if (!TOKEN) fatal('TG_BOT_TOKEN is missing — copy config.env.example to config.env and fill it in.');
if (ALLOWED.size === 0) fatal('TGA_ALLOWED_CHAT_IDS is missing — put your chat id in config.env.');

// Override for tests or a Bot API proxy; normal use never sets it.
const API = `${env('TELEGRAM_API', 'https://api.telegram.org')}/bot${TOKEN}`;
// Where state.json and the generated claude-settings.json live. Default: next to bot.js.
const DATA_DIR = env('DATA_DIR', APP_DIR);
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'claude-settings.json');
const DEFAULT_CWD = env('DEFAULT_CWD', HOME);
const DEFAULT_MODE = env('MODE', 'smart');
// batch = buffer everything the agent says, send once when done (default — fewer buzzes)
// live  = send each chunk as it arrives
const DEFAULT_STREAM = env('STREAM', 'batch');
const TASK_TIMEOUT_MS = Number(env('TIMEOUT_SEC', 1800)) * 1000;
const APPROVE_TIMEOUT_SEC = Number(env('APPROVE_TIMEOUT_SEC', 300));
const APPROVE_PORT = Number(env('APPROVE_PORT', 18792));
const AUTO_ALLOW = env('AUTO_ALLOW', 'Read,Glob,Grep,TodoWrite');
// 'bymode' = default: ask -> prompt for everything, smart/auto -> risk.js decides.
// 'none'   = off the leash: the hook allows everything, in every mode. No buttons.
const GUARD_MODE = env('GUARD_MODE', 'bymode');
// Leave empty in config.env -> regenerated on every boot (recommended).
const APPROVE_TOKEN = env('APPROVE_TOKEN', '') || crypto.randomBytes(24).toString('hex');
const MAX_MSG = 3800;

const MODES = ['smart', 'ask', 'auto'];
const STREAMS = ['batch', 'live'];

// --- agents ---
// TGA_AGENTS limits which backends show up in /agent (comma list of ids).
const AGENT_IDS = (env('AGENTS', '') || backends.ALL.map((b) => b.id).join(','))
  .split(',').map((s) => s.trim()).filter((id) => backends.byId[id]);
if (!AGENT_IDS.length) fatal('TGA_AGENTS names no known agent. Known: ' + backends.ALL.map((b) => b.id).join(', '));
const DEFAULT_AGENT = AGENT_IDS.includes(env('AGENT', 'claude')) ? env('AGENT', 'claude') : AGENT_IDS[0];

function agentDefaults(id) {
  const b = backends.byId[id];
  // TGA_<ID>_MODEL / TGA_<ID>_EFFORT; the claude ones also read the legacy TGA_MODEL / TGA_EFFORT.
  let model = env(`${id.toUpperCase()}_MODEL`, undefined);
  if (model === undefined && id === 'claude') model = env('MODEL', undefined);
  if (model === undefined) model = b.defaultModel;
  let effort = env(`${id.toUpperCase()}_EFFORT`, undefined);
  if (effort === undefined && id === 'claude') effort = env('EFFORT', undefined);
  if (effort === undefined) effort = b.efforts ? (b.efforts.includes('high') ? 'high' : b.efforts[0]) : '';
  return { model, effort };
}

// ----------------------------------------------------------------- state ---

let state = { offset: 0, chats: {} };
try {
  if (fs.existsSync(STATE_FILE)) {
    state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    state.chats = state.chats || {};
  }
} catch (e) { log('warn', `state.json is corrupt (${e.message}), starting fresh.`); }

// v3: per-agent session/model/effort. A state.json copied over from
// claude-telegram has them at the top level; move them under per.claude once.
if (state.v !== 3) {
  for (const c of Object.values(state.chats)) {
    if (c.mode === 'ask' && (state.v || 0) < 2) c.mode = 'smart';
    c.per = c.per || {};
    if ('sessionId' in c || 'model' in c || 'effort' in c) {
      c.per.claude = { sessionId: c.sessionId || null, model: c.model, effort: c.effort, ...(c.per.claude || {}) };
      delete c.sessionId; delete c.model; delete c.effort;
    }
    if (!c.agent) c.agent = 'claude';
  }
  state.v = 3;
}

let saveTimer = null;
function saveState() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 }); }
    catch (e) { log('warn', `could not write state: ${e.message}`); }
  }, 300);
}

function chatState(id) {
  const k = String(id);
  const c = state.chats[k] || (state.chats[k] = {});
  if (!c.cwd) c.cwd = DEFAULT_CWD;
  if (!c.mode) c.mode = DEFAULT_MODE;
  if (!c.stream) c.stream = DEFAULT_STREAM;
  if (!c.agent || !AGENT_IDS.includes(c.agent)) c.agent = DEFAULT_AGENT;
  if (!c.per) c.per = {};
  if (typeof c.costUsd !== 'number') c.costUsd = 0;
  if (typeof c.turns !== 'number') c.turns = 0;
  return c;
}

/** Per-agent record of a chat: { sessionId, model, effort }. */
function agentState(cs, id = cs.agent) {
  const a = cs.per[id] || (cs.per[id] = {});
  const d = agentDefaults(id);
  if (a.sessionId === undefined) a.sessionId = null;
  if (a.model === undefined) a.model = d.model;
  if (a.effort === undefined) a.effort = d.effort;
  return a;
}

const backendOf = (cs) => backends.byId[cs.agent];

/** "Allow for this session" grants: Map(sessionKey -> Set(signature)). In memory only. */
const sessionGrants = new Map();
function grantKey(chatId) {
  const cs = chatState(chatId);
  return `${chatId}:${cs.agent}:${agentState(cs).sessionId || 'new'}`;
}
function grantsFor(chatId) {
  const key = grantKey(chatId);
  if (!sessionGrants.has(key)) sessionGrants.set(key, new Set());
  return sessionGrants.get(key);
}
function clearGrants(chatId) { sessionGrants.delete(grantKey(chatId)); }

// -------------------------------------------------------------- telegram ---

async function tg(method, body, { retries = 3 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${API}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(70000),
      });
      const json = await res.json();
      if (!json.ok) {
        const after = json.parameters && json.parameters.retry_after;
        if (after && attempt < retries) { await sleep((after + 1) * 1000); continue; }
        throw new Error(`${method}: ${json.description}`);
      }
      return json.result;
    } catch (e) {
      if (attempt >= retries) throw e;
      await sleep(1000 * (attempt + 1));
    }
  }
}

function chunk(text, size = MAX_MSG) {
  const out = [];
  let rest = String(text);
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size);
    if (cut < size * 0.5) cut = size;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest.length) out.push(rest);
  return out;
}

/**
 * silent         — deliver without a notification (Telegram: disable_notification)
 * notifyOnlyLast — when a long reply is split, only the last chunk notifies
 */
async function send(chatId, text, { silent = false, notifyOnlyLast = false, ...extra } = {}) {
  const parts = chunk(text).filter((p) => p.trim());
  let last = null;
  for (let i = 0; i < parts.length; i++) {
    const isLast = i === parts.length - 1;
    last = await tg('sendMessage', {
      chat_id: chatId, text: parts[i], disable_web_page_preview: true,
      disable_notification: silent || (notifyOnlyLast && !isLast),
      ...extra,
    });
  }
  return last;
}

const kb = (rows) => ({ reply_markup: { inline_keyboard: rows } });

// ---------------------------------------------------------- approval gate ---

let reqCounter = 0;
const pendingApprovals = new Map(); // id -> { resolve, chatId, msgId, timer, sig, label }

/**
 * Signature used to group "allow for this session" grants.
 *
 * In smart mode, group by the RISK REASON rather than by the leading command:
 * real commands often start with `cd`, `for`, `(timeout`, `BK=...`, so granting
 * "Bash:cd" would be both meaningless and far too broad. Grouping by "delete
 * files" at least matches what the person actually approved.
 */
function signature(toolName, input, why) {
  if (why) return `⚠️ ${why}`;
  if (toolName === 'Bash') {
    const cmd = String((input && input.command) || '').trim();
    const first = cmd.split(/\s+/)[0] || '?';
    const second = cmd.split(/\s+/)[1] || '';
    // docker/systemctl/git: group down to the subcommand so it stays narrow
    if (['docker', 'systemctl', 'git', 'npm', 'apt', 'sudo'].includes(first) && second) {
      return `Bash:${first} ${second}`;
    }
    return `Bash:${first}`;
  }
  return toolName;
}

function describe(toolName, input) {
  const i = input || {};
  let d = '';
  if (toolName === 'Bash') d = i.command || '';
  else if (i.file_path) d = i.file_path;
  else if (i.path) d = i.path;
  else if (i.url) d = i.url;
  else if (i.pattern) d = i.pattern;
  else if (i.query) d = i.query;
  else if (i.prompt) d = i.prompt;
  else if (Object.keys(i).length) d = JSON.stringify(i);
  d = String(d);
  if (d.length > 600) d = d.slice(0, 597) + '…';
  return d;
}

async function askApproval(chatId, payload, why) {
  const toolName = payload.tool_name || 'tool';
  const input = payload.tool_input || {};
  const sig = signature(toolName, input, why);

  if (grantsFor(chatId).has(sig)) {
    return { decision: 'allow', reason: `"${sig}" was granted for this session` };
  }

  // Flush whatever the agent has said before asking — otherwise whoever taps the
  // button has no context. Flush silently; let the approval message notify.
  if (running && running.chatId === chatId && running.flushText) {
    await running.flushText({ silent: true }).catch(() => {});
  }

  const id = String(++reqCounter);
  const detail = describe(toolName, input);
  const text =
    `${S.approvalTitle}\n\n` +
    `${S.approvalTool(toolName)}\n` +
    (why ? `${S.approvalWhy(S.reason(why))}\n` : '') +
    (input.description ? `${S.approvalIntent(input.description)}\n` : '') +
    `\n${detail}\n\n` +
    S.approvalDeadline(APPROVE_TIMEOUT_SEC);

  let msg;
  try {
    msg = await tg('sendMessage', {
      chat_id: chatId,
      text: chunk(text)[0],
      disable_web_page_preview: true,
      ...kb([
        [{ text: S.btnAllow, callback_data: `a:${id}` }],
        [{ text: S.btnAllowSession(S.reason(sig)).slice(0, 60), callback_data: `s:${id}` }],
        [{ text: S.btnDeny, callback_data: `d:${id}` }],
      ]),
    });
  } catch (e) {
    return { decision: 'deny', reason: `could not deliver the approval request: ${e.message}` };
  }

  return await new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingApprovals.delete(id);
      tg('editMessageText', {
        chat_id: chatId, message_id: msg.message_id,
        text: S.approvalTimedOut(toolName, detail.slice(0, 300)),
      }).catch(() => {});
      resolve({ decision: 'deny', reason: 'the owner did not answer in time' });
    }, APPROVE_TIMEOUT_SEC * 1000);

    pendingApprovals.set(id, {
      resolve, chatId, msgId: msg.message_id, timer, sig,
      label: `${toolName} — ${detail.slice(0, 200)}`,
    });
  });
}

function startApprovalServer() {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/approve') {
      res.writeHead(404).end('nope');
      return;
    }
    let body = '';
    req.on('data', (d) => {
      body += d;
      if (body.length > 1e6) { req.destroy(); }
    });
    req.on('end', async () => {
      let j;
      try { j = JSON.parse(body); } catch (_) { res.writeHead(400).end('bad json'); return; }
      // Timing-safe comparison
      const ok = typeof j.token === 'string' &&
        j.token.length === APPROVE_TOKEN.length &&
        crypto.timingSafeEqual(Buffer.from(j.token), Buffer.from(APPROVE_TOKEN));
      if (!ok) { res.writeHead(403).end('bad token'); return; }
      if (!ALLOWED.has(String(j.chatId))) { res.writeHead(403).end('bad chat'); return; }

      let verdict;
      try { verdict = await askApproval(String(j.chatId), j.payload || {}, j.why); }
      catch (e) { verdict = { decision: 'deny', reason: `approval gate error: ${e.message}` }; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(verdict));
    });
  });
  server.listen(APPROVE_PORT, '127.0.0.1', () => {
    log('info', `Approval gate: http://127.0.0.1:${APPROVE_PORT} (loopback only)`);
  });
  server.on('error', (e) => fatal(`Could not open approval port ${APPROVE_PORT}: ${e.message}`));
}

function writeClaudeSettings() {
  const settings = {
    hooks: {
      PreToolUse: [{
        matcher: '*',
        hooks: [{
          type: 'command',
          command: `${process.execPath} ${HOOK_FILE}`,
          timeout: APPROVE_TIMEOUT_SEC + 60,
        }],
      }],
    },
  };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), { mode: 0o600 });
}

// ----------------------------------------------------- session management ---

function ago(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 90) return S.agoSeconds(s);
  if (s < 5400) return S.agoMinutes(Math.round(s / 60));
  if (s < 172800) return S.agoHours(Math.round(s / 3600));
  return S.agoDays(Math.round(s / 86400));
}

function listSessions(cs, limit) {
  const b = backendOf(cs);
  if (!b.sessions) return [];
  try { return b.listSessions(cs.cwd, limit).map((r) => ({ ...r, title: r.title || S.unknownContent })); }
  catch (e) { log('warn', `listSessions(${b.id}) failed: ${e.message}`); return []; }
}

// --------------------------------------------------------------- run job ---

let running = null;
let active = false;
const queue = [];
const busy = () => active || queue.length > 0;

function enqueue(job) { queue.push(job); pump(); }

async function pump() {
  if (active || queue.length === 0) return;
  active = true;
  const job = queue.shift();
  try { await runJob(job); }
  catch (e) {
    log('error', `job failed: ${e.stack || e.message}`);
    try { await send(job.chatId, S.internalError(e.message)); } catch (_) {}
  }
  active = false;
  pump();
}

function toolLabel(name, input) {
  const d = describe(name, input).replace(/\s+/g, ' ').trim();
  return d ? `${name}: ${d.length > 110 ? d.slice(0, 107) + '…' : d}` : name;
}

/** Effective guard for a chat: only Claude Code has a gate; the rest are unleashed. */
function guardFor(cs, b = backendOf(cs)) {
  if (!b.guard || GUARD_MODE === 'none') return 'none';
  return cs.mode === 'ask' ? 'all' : 'smart';
}

async function runJob(job) {
  const { chatId, prompt } = job;
  const cs = chatState(chatId);
  // The agent is pinned when the message was sent: switching with /agent while
  // a job is queued must not reroute it.
  const b = backends.byId[job.agent] || backendOf(cs);
  const as = agentState(cs, b.id);

  if (!fs.existsSync(cs.cwd)) {
    await send(chatId, S.missingDirectory(cs.cwd));
    return;
  }
  if (!backends.isInstalled(b)) {
    await send(chatId, S.agentNotInstalled(b.name, backends.binFor(b)));
    return;
  }

  const guard = guardFor(cs, b);
  const { args, env: extraEnv } = b.buildArgs({
    prompt, model: as.model, effort: as.effort, sessionId: as.sessionId,
    guardMode: GUARD_MODE, mode: cs.mode, settingsFile: SETTINGS_FILE,
    hookEnv: {
      TGA_APPROVE_URL: `http://127.0.0.1:${APPROVE_PORT}/approve`,
      TGA_APPROVE_TOKEN: APPROVE_TOKEN,
      TGA_APPROVE_TIMEOUT_SEC: String(APPROVE_TIMEOUT_SEC),
      TGA_AUTO_ALLOW: AUTO_ALLOW,
      TGA_GUARD: guard,
      TGA_CHAT: String(chatId),
    },
  });

  // Tag showing whether this turn CONTINUES an old session or STARTS a new one.
  // Shown in the "working" message so nobody has to run /status to guess.
  const resumedFrom = as.sessionId;
  const sessionTag = (resumedFrom ? S.tagResumed(b.sessionLabel(resumedFrom)) : S.tagNew) + ` · ${b.name}`;

  log('info', `[${chatId}] agent=${b.id} cwd=${cs.cwd} mode=${cs.mode} guard=${guard} model=${as.model || '-'} effort=${as.effort || '-'} resume=${as.sessionId || '-'}`);

  const child = spawn(backends.binFor(b), args, {
    cwd: cs.cwd,
    env: { ...process.env, ...(extraEnv || {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const status = await tg('sendMessage', {
    chat_id: chatId, text: S.working(sessionTag), disable_notification: true,
  }).catch(() => null);
  const started = Date.now();
  running = { child, chatId, statusMsgId: status ? status.message_id : null, killedByUser: false };

  let lastStatusText = '', lastEdit = 0, toolCount = 0, currentTool = '';
  let sentAnything = false, stderr = '', finalResult = null;
  // Has anything NOTIFIED this turn yet? If not, the closing summary must be the
  // one that notifies, otherwise the job finishes in total silence.
  let notified = false;

  const refreshStatus = async () => {
    if (!running || !running.statusMsgId) return;
    const secs = Math.round((Date.now() - started) / 1000);
    const text = S.progress(sessionTag, secs, toolCount, currentTool);
    if (Date.now() - lastEdit < 3000 || text === lastStatusText) return;
    lastEdit = Date.now(); lastStatusText = text;
    try {
      await tg('editMessageText', { chat_id: chatId, message_id: running.statusMsgId, text }, { retries: 0 });
    } catch (_) {}
  };
  const ticker = setInterval(() => { refreshStatus().catch(() => {}); }, 3000);

  const timer = setTimeout(() => {
    log('warn', `[${chatId}] timed out, killing.`);
    try { child.kill('SIGTERM'); } catch (_) {}
    setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 5000);
  }, TASK_TIMEOUT_MS);

  // --- buffering the agent's text ------------------------------------------
  // A single turn usually produces several chunks of text interleaved with tool
  // calls. Sending each one immediately buzzes the phone constantly. Batch mode
  // holds them and flushes only when (a) the turn is done, or (b) an approval is
  // about to be asked — at which point the person tapping needs the context.
  const buffer = [];
  const audit = [];
  let sendChain = Promise.resolve();

  const flushText = ({ silent = false } = {}) => {
    if (!buffer.length) return sendChain;
    const text = buffer.join('\n\n').trim();
    buffer.length = 0;
    if (!text) return sendChain;
    sentAnything = true;
    if (!silent) notified = true;
    sendChain = sendChain.then(() =>
      send(chatId, text, { silent, notifyOnlyLast: !silent })
        .catch((e) => log('warn', `send failed: ${e.message}`)));
    return sendChain;
  };
  running.flushText = flushText;

  const sendOrdered = (text) => {
    notified = true;
    sendChain = sendChain.then(() =>
      send(chatId, text).catch((e) => log('warn', `send failed: ${e.message}`)));
    return sendChain;
  };

  // Normalized events from the backend parser (see backends/index.js).
  const handleEvent = (evt) => {
    switch (evt.type) {
      case 'session':
        if (evt.id && evt.id !== as.sessionId) { as.sessionId = evt.id; saveState(); }
        break;
      case 'text':
        if (cs.stream === 'live') { sentAnything = true; sendOrdered(evt.text); }
        else buffer.push(evt.text);
        break;
      case 'tool':
        toolCount++;
        currentTool = toolLabel(evt.name, evt.input);
        try { if (risk.mutates(evt.name, evt.input)) audit.push(currentTool); } catch (_) {}
        refreshStatus().catch(() => {});
        break;
      case 'result':
        finalResult = evt;
        break;
      case 'noise':
        log('warn', `[${b.id}] unparsed line: ${String(evt.text).slice(0, 160)}`);
        break;
      default:
        break;
    }
  };

  const parser = b.createParser(handleEvent);
  child.stdin.on('error', () => {});
  child.stdin.end(b.stdinPrompt ? prompt : '');
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => { try { parser.feed(d); } catch (e) { log('warn', `parser: ${e.message}`); } });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => { stderr += d; if (stderr.length > 8000) stderr = stderr.slice(-8000); });

  const code = await new Promise((resolve) => {
    child.on('close', resolve);
    child.on('error', (e) => { stderr += `\nspawn: ${e.message}`; resolve(-1); });
  });
  try { parser.end(); } catch (e) { log('warn', `parser end: ${e.message}`); }

  const killedByUser = running && running.killedByUser;
  clearInterval(ticker); clearTimeout(timer);
  running = null;
  await flushText().catch(() => {});   // flush the buffer — this one may notify
  await sendChain.catch(() => {});

  const secs = Math.round((Date.now() - started) / 1000);
  cs.turns++;
  if (finalResult && typeof finalResult.costUsd === 'number') cs.costUsd += finalResult.costUsd;
  saveState();

  if (b.isSessionGone(stderr, code)) { as.sessionId = null; saveState(); }

  // Session id AFTER the run: for a new session this is the first time we know it.
  const endTag = as.sessionId
    ? S.sessionEnded(resumedFrom ? '↩️' : '🆕', b.sessionLabel(as.sessionId))
    : S.sessionUnknown;

  let footer = S.footerDone(secs, toolCount, endTag);
  if (killedByUser) footer = S.footerStopped(secs, toolCount, endTag);
  else if (code !== 0 || (finalResult && finalResult.isError)) footer = S.footerFailed(secs, endTag);

  const denials = (finalResult && finalResult.denials) || [];
  if (denials.length) footer += S.footerDenied([...new Set(denials)].join(', '));

  // Smart mode / unleashed agents run a lot without asking -> recap what was touched.
  if (audit.length) {
    const shown = audit.slice(0, 10).map((a) => `• ${a}`);
    if (audit.length > 10) shown.push(S.auditMore(audit.length - 10));
    footer += S.auditHeader(shown.join('\n'));
  }

  // No text at all -> push the raw result FIRST, so we know if a ping is still owed.
  if (!sentAnything) {
    const fallback = (finalResult && finalResult.text) ||
      (stderr.trim() ? `stderr:\n${stderr.trim().slice(-1500)}` : S.noOutput);
    notified = true;
    await send(chatId, fallback, { notifyOnlyLast: true }).catch(() => {});
  } else if (code !== 0 && stderr.trim() && !killedByUser) {
    // Text came out but the process still failed: append the tail of stderr, silently.
    await send(chatId, `stderr:\n${stderr.trim().slice(-1500)}`, { silent: true }).catch(() => {});
  }

  footer = chunk(footer)[0];
  if (notified) {
    // The reply already notified -> edit the summary in place, silently.
    if (status) {
      try { await tg('editMessageText', { chat_id: chatId, message_id: status.message_id, text: footer }); }
      catch (_) { await send(chatId, footer, { silent: true }).catch(() => {}); }
    } else { await send(chatId, footer, { silent: true }).catch(() => {}); }
  } else {
    // Nothing notified all turn (the text was flushed early for an approval) ->
    // the summary is the "done" message and must notify. Drop the "⏳" bubble.
    if (status) await tg('deleteMessage', { chat_id: chatId, message_id: status.message_id }).catch(() => {});
    await send(chatId, footer).catch(() => {});
  }
}

// -------------------------------------------------------------- commands ---

const HELP = S.help(GUARD_MODE === 'none', AGENT_IDS.map((id) => backends.byId[id].name));

function agentKeyboard(cs) {
  return kb(AGENT_IDS.map((id) => {
    const b = backends.byId[id];
    const inst = backends.isInstalled(b);
    const label = `${id === cs.agent ? '● ' : ''}${b.name}${inst ? '' : ' ✗'}`;
    return [{ text: label, callback_data: `A:${id}` }];
  }));
}

function agentSummary(cs, id = cs.agent) {
  const b = backends.byId[id];
  const as = agentState(cs, id);
  return S.agentLine({
    name: b.name, installed: backends.isInstalled(b),
    session: as.sessionId ? b.sessionLabel(as.sessionId) : '',
    model: as.model || S.agentDefault, guard: b.guard,
  });
}

function modelKeyboard(b, current) {
  if (!b.models.length) return {};
  return kb([b.models.map((m) => ({ text: m === current ? `● ${m}` : m, callback_data: `m:${m}` }))]);
}

async function sendSessionList(chatId) {
  const cs = chatState(chatId);
  const b = backendOf(cs);
  const as = agentState(cs);
  if (!b.sessions) {
    await send(chatId, S.sessionsUnsupported(b.name, !!as.sessionId));
    return;
  }
  const rows = listSessions(cs);
  if (!rows.length) {
    await send(chatId, S.noSessions(cs.cwd, b.name));
    return;
  }
  const lines = [S.sessionsHeader(cs.cwd, b.name), ''];
  const buttons = [];
  rows.forEach((r, i) => {
    const cur = r.id === as.sessionId ? S.sessionCurrent : '';
    lines.push(`${i + 1}. ${r.title}\n   ${ago(r.mtime)} · ${b.sessionLabel(r.id)}${cur}`);
    buttons.push([{ text: `${i + 1}. ${r.title}`.slice(0, 60), callback_data: `r:${r.id}` }]);
  });
  buttons.push([{ text: S.btnNewSession, callback_data: 'r:NEW' }]);
  await tg('sendMessage', {
    chat_id: chatId, text: chunk(lines.join('\n'))[0],
    disable_web_page_preview: true, ...kb(buttons),
  });
}

async function handleCommand(chatId, text) {
  const cs = chatState(chatId);
  const b = backendOf(cs);
  const as = agentState(cs);
  const [cmdRaw, ...rest] = text.trim().split(/\s+/);
  const cmd = cmdRaw.split('@')[0].toLowerCase();
  const arg = rest.join(' ').trim();

  switch (cmd) {
    case '/start': case '/help':
      await send(chatId, HELP); return true;

    case '/agent': case '/agents': {
      if (arg) {
        const id = arg.toLowerCase();
        if (!AGENT_IDS.includes(id)) { await send(chatId, S.agentUnknown(arg, AGENT_IDS)); return true; }
        cs.agent = id; saveState();
        await send(chatId, S.agentSwitched(agentSummary(cs)));
        return true;
      }
      const lines = [S.agentCurrent(b.name), ''];
      for (const id of AGENT_IDS) lines.push(agentSummary(cs, id));
      lines.push('', S.agentHint);
      await tg('sendMessage', { chat_id: chatId, text: lines.join('\n'), ...agentKeyboard(cs) });
      return true;
    }

    case '/new': case '/clear':
      clearGrants(chatId);
      as.sessionId = null; saveState();
      await send(chatId, S.newSession);
      return true;

    case '/sessions':
      await sendSessionList(chatId); return true;

    case '/resume': {
      if (!arg) { await sendSessionList(chatId); return true; }
      if (!b.sessions) { await send(chatId, S.sessionsUnsupported(b.name, !!as.sessionId)); return true; }
      const rows = listSessions(cs, 50);
      const hit = rows.find((r) => r.id === arg || r.id.startsWith(arg) || b.sessionLabel(r.id) === arg);
      if (!hit) { await send(chatId, S.sessionNotFound(arg, cs.cwd)); return true; }
      clearGrants(chatId);
      as.sessionId = hit.id; saveState();
      await send(chatId, `↩️ Resume: ${hit.title}\n${hit.id}`);
      return true;
    }

    case '/pwd':
      await send(chatId, `📁 ${cs.cwd}`); return true;

    case '/cd': {
      if (!arg) { await send(chatId, S.cdUsage); return true; }
      const target = arg.startsWith('~') ? path.join(HOME, arg.slice(1)) : path.resolve(cs.cwd, arg);
      if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
        await send(chatId, S.notADirectory(target)); return true;
      }
      clearGrants(chatId);
      cs.cwd = target;
      // Sessions belong to a directory: reset every agent's, not just the current one.
      for (const id of Object.keys(cs.per)) cs.per[id].sessionId = null;
      saveState();
      await send(chatId, S.cdDone(target));
      return true;
    }

    case '/model': {
      if (arg) {
        if (b.models.length && !b.models.includes(arg)) { await send(chatId, S.ackUnknownModel + `: ${b.models.join(' / ')}`); return true; }
        as.model = arg === '-' ? '' : arg; saveState();
        await send(chatId, `🤖 ${b.name} · model: ${as.model || S.agentDefault}`);
        return true;
      }
      await tg('sendMessage', {
        chat_id: chatId,
        text: S.modelCurrent(as.model || S.agentDefault, b.name) + (b.models.length ? '' : `\n${S.modelFreeText}`),
        ...modelKeyboard(b, as.model),
      });
      return true;
    }

    case '/effort':
      if (!b.efforts) { await send(chatId, S.effortUnsupported(b.name)); return true; }
      if (arg) {
        if (!b.efforts.includes(arg)) { await send(chatId, S.ackUnknownEffort + `: ${b.efforts.join(' / ')}`); return true; }
        as.effort = arg; saveState();
        await send(chatId, `🎚 Effort: ${arg}`);
        return true;
      }
      await tg('sendMessage', {
        chat_id: chatId,
        text: S.effortCurrent(as.effort),
        ...kb([b.efforts.map((e) => ({ text: e === as.effort ? `● ${e}` : e, callback_data: `e:${e}` }))]),
      });
      return true;

    case '/mode':
      await tg('sendMessage', {
        chat_id: chatId,
        text: (!b.guard ? S.agentNoGuard(b.name) : GUARD_MODE === 'none' ? S.unleashedNotice : '') +
              S.modeCurrent(cs.mode, AUTO_ALLOW),
        ...kb([MODES.map((m) => ({
          text: m === cs.mode ? `● ${m}` : m, callback_data: `k:${m}`,
        }))]),
      });
      return true;

    case '/stream':
      await tg('sendMessage', {
        chat_id: chatId,
        text: S.streamCurrent(cs.stream),
        ...kb([STREAMS.map((s) => ({
          text: s === cs.stream ? `● ${s}` : s, callback_data: `t:${s}`,
        }))]),
      });
      return true;

    case '/approvals': {
      const g = [...grantsFor(chatId)];
      if (!g.length) { await send(chatId, S.grantsNone); return true; }
      await tg('sendMessage', {
        chat_id: chatId,
        text: S.grantsList(g.map((x) => S.reason(x))),
        ...kb([[{ text: S.btnRevokeAll, callback_data: 'g:clear' }]]),
      });
      return true;
    }

    case '/status': {
      const q = queue.filter((j) => j.chatId === chatId).length;
      await send(chatId, S.status({
        agent: b.name,
        cwd: cs.cwd,
        session: as.sessionId ? b.sessionLabel(as.sessionId) + '…' : S.statusNewSession,
        model: as.model || S.agentDefault, effort: as.effort || '-',
        guard: guardFor(cs) === 'none' ? 'none' : GUARD_MODE, mode: cs.mode, stream: cs.stream,
        grants: grantsFor(chatId).size, turns: cs.turns, cost: cs.costUsd.toFixed(3),
        active, queued: q,
      }));
      return true;
    }

    case '/stop':
      if (running && running.chatId === chatId) {
        running.killedByUser = true;
        try { running.child.kill('SIGTERM'); } catch (_) {}
        setTimeout(() => { try { running && running.child.kill('SIGKILL'); } catch (_) {} }, 5000);
        await send(chatId, S.stopping);
      } else {
        const before = queue.length;
        for (let i = queue.length - 1; i >= 0; i--) if (queue[i].chatId === chatId) queue.splice(i, 1);
        await send(chatId, before > queue.length ? S.queueCleared : S.nothingRunning);
      }
      return true;

    default:
      return false;
  }
}

// --------------------------------------------------------- callback query ---

async function handleCallback(q) {
  const chatId = String(q.message.chat.id);
  const data = String(q.data || '');
  const cs = chatState(chatId);
  const b = backendOf(cs);
  const as = agentState(cs);
  const ack = (text) => tg('answerCallbackQuery', { callback_query_id: q.id, text }).catch(() => {});
  const edit = (text, extra = {}) => tg('editMessageText', {
    chat_id: chatId, message_id: q.message.message_id, text, ...extra,
  }).catch(() => {});

  // Approval decision
  if (/^[asd]:/.test(data)) {
    const [kind, id] = [data[0], data.slice(2)];
    const pend = pendingApprovals.get(id);
    if (!pend) { await ack(S.ackExpired); return; }
    pendingApprovals.delete(id);
    clearTimeout(pend.timer);

    let verdict, note;
    if (kind === 'a') { verdict = { decision: 'allow', reason: 'approved by the owner' }; note = S.noteAllowed; }
    else if (kind === 's') {
      grantsFor(chatId).add(pend.sig);
      verdict = { decision: 'allow', reason: `approved, and "${pend.sig}" granted for this session` };
      note = S.noteAllowedSession(S.reason(pend.sig));
    } else { verdict = { decision: 'deny', reason: 'denied by the owner' }; note = S.noteDenied; }

    pend.resolve(verdict);
    await ack(note);
    await edit(`${note}\n\n${pend.label}`);
    return;
  }

  if (data.startsWith('A:')) {
    const id = data.slice(2);
    if (!AGENT_IDS.includes(id)) { await ack(S.ackUnknownAgent); return; }
    const nb = backends.byId[id];
    if (!backends.isInstalled(nb)) { await ack(S.ackAgentNotInstalled(nb.name)); return; }
    cs.agent = id; saveState();
    await ack(`Agent: ${nb.name}`);
    await edit(S.agentSwitched(agentSummary(cs)), agentKeyboard(cs));
    return;
  }

  if (data.startsWith('m:')) {
    const m = data.slice(2);
    if (b.models.length && !b.models.includes(m)) { await ack(S.ackUnknownModel); return; }
    as.model = m; saveState();
    await ack(`Model: ${m}`);
    await edit(`🤖 ${b.name} · model: ${m}`, modelKeyboard(b, m));
    return;
  }

  if (data.startsWith('e:')) {
    const e = data.slice(2);
    if (!b.efforts || !b.efforts.includes(e)) { await ack(S.ackUnknownEffort); return; }
    as.effort = e; saveState();
    await ack(`Effort: ${e}`);
    await edit(`🎚 Effort: ${e}`,
      kb([b.efforts.map((x) => ({ text: x === e ? `● ${x}` : x, callback_data: `e:${x}` }))]));
    return;
  }

  if (data.startsWith('k:')) {
    const m = data.slice(2);
    if (!MODES.includes(m)) { await ack(S.ackUnknownMode); return; }
    cs.mode = m; saveState();
    await ack(S.ackMode(m));
    await edit(S.modeExplain[m]);
    return;
  }

  if (data.startsWith('t:')) {
    const s = data.slice(2);
    if (!STREAMS.includes(s)) { await ack(S.ackUnknownStream); return; }
    cs.stream = s; saveState();
    await ack(S.ackStream(s));
    await edit(S.streamExplain[s]);
    return;
  }

  if (data.startsWith('r:')) {
    const id = data.slice(2);
    clearGrants(chatId);
    if (id === 'NEW') {
      as.sessionId = null; saveState();
      await ack(S.ackNewSession);
      await edit(S.newSessionShort);
      return;
    }
    as.sessionId = id; saveState();
    await ack(S.ackResumed);
    await edit(S.resumedInto(b.sessionLabel(id)));
    return;
  }

  if (data === 'g:clear') {
    clearGrants(chatId);
    await ack(S.ackRevoked);
    await edit(S.revokedAll);
    return;
  }

  await ack('');
}

// ------------------------------------------------------------- long poll ---

async function poll() {
  let conflicts = 0;
  for (;;) {
    let updates;
    try {
      updates = await tg('getUpdates', {
        offset: state.offset, timeout: 50,
        allowed_updates: ['message', 'callback_query'],
      }, { retries: 0 });
      conflicts = 0;
    } catch (e) {
      if (/terminated by other getUpdates/i.test(e.message)) {
        conflicts++;
        const wait = Math.min(5000 * conflicts, 30000);
        log('warn', `getUpdates conflict (#${conflicts}) — another process on the same bot? Waiting ${wait / 1000}s.`);
        await sleep(wait); continue;
      }
      log('warn', `getUpdates failed: ${e.message}`);
      await sleep(5000); continue;
    }

    for (const u of updates) {
      state.offset = u.update_id + 1;
      saveState();
      try {
        if (u.callback_query) {
          const from = String(u.callback_query.from && u.callback_query.from.id);
          const chat = String(u.callback_query.message && u.callback_query.message.chat.id);
          if (!ALLOWED.has(from) || !ALLOWED.has(chat)) {
            log('warn', `Blocked callback from ${from}`);
            await tg('answerCallbackQuery', { callback_query_id: u.callback_query.id, text: S.ackNotAllowed }).catch(() => {});
            continue;
          }
          await handleCallback(u.callback_query);
          continue;
        }

        const msg = u.message;
        if (!msg || !msg.text) continue;
        const chatId = String(msg.chat.id);
        if (!ALLOWED.has(chatId)) {
          log('warn', `Blocked unknown chat ${chatId}: ${msg.text.slice(0, 80)}`);
          continue;
        }
        const text = msg.text.trim();
        if (text.startsWith('/') && await handleCommand(chatId, text)) continue;

        const wasBusy = busy();
        enqueue({ chatId, prompt: text, agent: chatState(chatId).agent });
        if (wasBusy) await send(chatId, S.queued(queue.length), { silent: true });
      } catch (e) {
        log('error', `failed to handle update: ${e.stack || e.message}`);
      }
    }
  }
}

// ----------------------------------------------------------------- utils ---

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function log(level, msg) { console.log(`[${new Date().toISOString()}] ${level.toUpperCase()} ${msg}`); }
function fatal(msg) { console.error(`FATAL ${msg}`); process.exit(1); }

process.on('SIGTERM', () => { if (running) { try { running.child.kill('SIGTERM'); } catch (_) {} } process.exit(0); });
process.on('unhandledRejection', (e) => log('error', `unhandledRejection: ${(e && e.stack) || e}`));

writeClaudeSettings();
startApprovalServer();
saveState();
const inventory = AGENT_IDS.map((id) => `${id}${backends.isInstalled(backends.byId[id]) ? '' : '(missing)'}`).join(', ');
log('info', `Started. Chats: ${[...ALLOWED].join(', ')} · agents: ${inventory} · default: ${DEFAULT_AGENT} · cwd: ${DEFAULT_CWD} · mode: ${DEFAULT_MODE} · guard: ${GUARD_MODE} · stream: ${DEFAULT_STREAM} · lang: ${S.lang}`);
poll();
