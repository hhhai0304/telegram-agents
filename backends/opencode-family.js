'use strict';
/*
 * Shared implementation for OpenCode and its forks (Kilo CLI).
 *
 *   <bin> run --format json --auto [--session ID] [--model provider/model] "<prompt>"
 *
 * `--format json` prints one JSON object per line, every one carrying
 * `sessionID`; the ones we care about:
 *   { type: 'text',      part: { text } }               (only when the part is complete)
 *   { type: 'tool_use',  part: { tool, state: { input, status } } }
 *   { type: 'step_finish', part: { cost, tokens } }
 *   { type: 'error',     error }
 *
 * `--auto` answers every permission prompt with "once". Without it the CLI
 * REJECTS every ask in non-interactive mode, so the run is useless -- it stays
 * on even when guarded, because the gate is not the CLI's own prompt.
 *
 * The gate is plugin/telegram-agents-guard.js: these CLIs have no PreToolUse
 * hook, but a plugin's `tool.execute.before` runs before every tool call and a
 * throw aborts it, which is enough to reuse risk.js and the Telegram buttons.
 * The plugin is NOT installed by default, so `guard` is decided per backend at
 * load time by looking for it in the CLI's config dir -- claiming guard: true
 * with no plugin behind it would be a lie the /status line repeats. Symlink it
 * in and restart the bot to switch a backend from unleashed to guarded.
 *
 * Sessions are tracked from the events (`sessionID`) and resumed with
 * `--session`. listSessions() is best-effort and tries two stores, because the
 * forks disagree: OpenCode writes one JSON file per session under
 * storage/session/, while Kilo CLI 7.x keeps them in SQLite (kilo.db) and only
 * exposes them through `<bin> session list --format json`. Files first (no
 * subprocess), then the CLI, then give up quietly.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

/** Map OpenCode tool names/inputs onto Claude Code vocabulary so risk.js and
 *  the audit/labels in bot.js work unchanged. */
function normalizeTool(name, input) {
  const i = input || {};
  switch (String(name || '').toLowerCase()) {
    case 'bash':     return { name: 'Bash',  input: { command: i.command || '', description: i.description } };
    case 'edit':     return { name: 'Edit',  input: { file_path: i.filePath || i.file_path || i.path } };
    case 'write':    return { name: 'Write', input: { file_path: i.filePath || i.file_path || i.path } };
    case 'read':     return { name: 'Read',  input: { file_path: i.filePath || i.file_path || i.path } };
    case 'glob':     return { name: 'Glob',  input: { pattern: i.pattern } };
    case 'grep':     return { name: 'Grep',  input: { pattern: i.pattern } };
    case 'webfetch': return { name: 'WebFetch', input: { url: i.url } };
    case 'list':     return { name: 'Glob',  input: { path: i.path } };
    default:         return { name: String(name || 'tool'), input: i };
  }
}

/** The bot's own directory: the plugin loads risk.js from here. */
const APP_DIR = path.join(__dirname, '..');

/** Is the approval-gate plugin installed for this CLI? Both spellings of the
 *  plugin directory are loaded by kilo 7.4.22, so accept either. */
function hasGuardPlugin(id) {
  const base = path.join(os.homedir(), '.config', id);
  return ['plugin', 'plugins'].some((d) =>
    fs.existsSync(path.join(base, d, 'telegram-agents-guard.js')));
}

/** Executable for a backend id, honouring the TGA_<ID>_BIN override. */
function binOf(id, fallback) {
  return process.env[`TGA_${id.toUpperCase()}_BIN`] || fallback;
}

/** OpenCode-style store: one JSON file per session under storage/session/. */
function sessionsFromFiles(storageDir, cwd, limit) {
  if (!fs.existsSync(storageDir)) return [];
  const rows = [];
  let projects;
  try { projects = fs.readdirSync(storageDir); } catch (_) { return []; }
  for (const p of projects.slice(0, 200)) {
    const dir = path.join(storageDir, p);
    let files;
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch (_) { continue; }
    for (const f of files.slice(0, 500)) {
      const full = path.join(dir, f);
      try {
        const st = fs.statSync(full);
        if (st.size > 65536) continue;           // session meta files are tiny
        const j = JSON.parse(fs.readFileSync(full, 'utf8'));
        if (!j || !j.id) continue;
        if (j.parentID) continue;                // sub-agent sessions
        if (j.directory && path.resolve(j.directory) !== path.resolve(cwd)) continue;
        const t = (j.time && (j.time.updated || j.time.created)) || st.mtimeMs;
        rows.push({ id: j.id, mtime: t, title: String(j.title || '').slice(0, 55) });
      } catch (_) {}
    }
  }
  rows.sort((a, b) => b.mtime - a.mtime);
  return rows.slice(0, limit);
}

/** Kilo-style store: sessions live in SQLite, readable only via the CLI.
 *  Costs one subprocess (~1-2s on a Pi), so it runs only when the file scan
 *  came up empty, i.e. on /sessions. `-a` is deliberately not passed: it
 *  crashes on kilo 7.4.22, and we want this directory anyway. */
function sessionsFromCli(bin, cwd, limit) {
  let out;
  try {
    out = execFileSync(bin, ['session', 'list', '--format', 'json', '-n', String(limit)],
      { cwd, encoding: 'utf8', timeout: 20000, maxBuffer: 4 << 20, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (_) { return []; }
  let list;
  try { list = JSON.parse(out); } catch (_) { return []; }
  if (!Array.isArray(list)) return [];
  return list
    .filter((j) => j && j.id && (!j.directory || path.resolve(j.directory) === path.resolve(cwd)))
    .map((j) => ({ id: j.id, mtime: j.updated || j.created || 0, title: String(j.title || '').slice(0, 55) }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit);
}

function make({ id, name, bin, dataDir, models = [], defaultModel = '' }) {
  const storageDir = path.join(dataDir, 'storage', 'session');

  return {
    id, name, bin,
    // These CLIs reach hundreds of models through their provider, so `models`
    // is a shortlist of buttons, not an allowlist: modelsOpen lets /model take
    // any string the CLI will accept.
    models, defaultModel, modelsOpen: true,
    efforts: null,
    guard: hasGuardPlugin(id),
    sessions: true,
    stdinPrompt: false,

    buildArgs(ctx) {
      const args = ['run', '--format', 'json', '--auto'];
      if (ctx.model) args.push('--model', ctx.model);
      if (ctx.sessionId) args.push('--session', ctx.sessionId);
      args.push('--', ctx.prompt);
      // The plugin reads the same TGA_* variables the Claude Code hook does;
      // with TGA_GUARD=none it makes itself inert, so this is safe to always pass.
      return { args, env: { ...(ctx.hookEnv || {}), TGA_APP_DIR: APP_DIR } };
    },

    listSessions(cwd, limit = 8) {
      const fromFiles = sessionsFromFiles(storageDir, cwd, limit);
      return fromFiles.length ? fromFiles : sessionsFromCli(binOf(id, bin), cwd, limit);
    },


    createParser(emit) {
      let buf = '';
      let cost = 0, sawError = null;
      const seen = new Set();
      const handle = (evt) => {
        if (evt.sessionID) emit({ type: 'session', id: evt.sessionID });
        const part = evt.part || {};
        switch (evt.type) {
          case 'text':
            if (part.text && part.text.trim()) emit({ type: 'text', text: part.text.trim() });
            break;
          case 'tool_use': {
            const st = part.state || {};
            // Emit once per tool call: on the first status we see for it.
            if (st.status && st.status !== 'pending' && !seen.has(part.id || part.callID)) {
              seen.add(part.id || part.callID);
              const t = normalizeTool(part.tool, st.input);
              emit({ type: 'tool', name: t.name, input: t.input });
            }
            break;
          }
          case 'step_finish':
            if (typeof part.cost === 'number') cost += part.cost;
            break;
          case 'error':
            sawError = evt.error && (evt.error.message || evt.error.name || JSON.stringify(evt.error));
            break;
          default:
            break;
        }
      };
      return {
        feed(str) {
          buf += str;
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            try { handle(JSON.parse(line)); }
            catch (_) { emit({ type: 'noise', text: line }); }
          }
        },
        end() {
          const line = buf.trim(); buf = '';
          if (line) { try { handle(JSON.parse(line)); } catch (_) { emit({ type: 'noise', text: line }); } }
          emit({ type: 'result', costUsd: cost, isError: !!sawError, text: sawError || '', denials: [] });
        },
      };
    },

    isSessionGone(stderr, code) {
      return code !== 0 && /session.*(not found|does not exist)|NotFound/i.test(stderr);
    },

    sessionLabel(id) { return id ? id.replace(/^ses_/, '').slice(0, 8) : ''; },
  };
}

module.exports = { make, normalizeTool, defaultDataDir: (n) => path.join(os.homedir(), '.local', 'share', n) };
