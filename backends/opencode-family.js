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
 * REJECTS every ask in non-interactive mode, so the run is useless. There is
 * no hook we can plug the Telegram approval gate into, which is why these
 * backends report guard: false and always run unleashed.
 *
 * Sessions are tracked from the events (`sessionID`) and resumed with
 * `--session`. listSessions() is best-effort: it scans the CLI's storage
 * directory for session JSON files and keeps the ones whose `directory` matches.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

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

function make({ id, name, bin, dataDir }) {
  const storageDir = path.join(dataDir, 'storage', 'session');

  return {
    id, name, bin,
    models: [],
    defaultModel: '',
    efforts: null,
    guard: false,
    sessions: true,
    stdinPrompt: false,

    buildArgs(ctx) {
      const args = ['run', '--format', 'json', '--auto'];
      if (ctx.model) args.push('--model', ctx.model);
      if (ctx.sessionId) args.push('--session', ctx.sessionId);
      args.push('--', ctx.prompt);
      return { args, env: {} };
    },

    listSessions(cwd, limit = 8) {
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
