'use strict';
/*
 * Backend: Pi CLI (`pi`, pi-coding-agent — the renamed OMP lineage).
 *
 *   pi -p --mode json [--model M] [--thinking L] [--session SID] -- "<prompt>"
 *
 * `--mode json` prints one NDJSON event per line. Verified shapes (v1.1.0):
 *   { type: 'session',  id, cwd }
 *   { type: 'message_update', assistantMessageEvent: { type: 'text_end',
 *        contentIndex, content } }
 *   { type: 'message_update', assistantMessageEvent: { type: 'toolcall_end',
 *        contentIndex, toolCall: { name, arguments } } }
 *   { type: 'message_end', message: { role: 'assistant', usage: { cost: { total } },
 *        stopReason } }
 *   { type: 'agent_end', messages: [...], isTerminal: true }
 * (`text_delta`/`thinking_*`/`tool_execution_*`/`turn_*` events are ignored —
 * `text_end` carries the complete block, `message_end` the settled usage.)
 *
 * No approval flag is needed: `-p` runs tools straight through (verified live —
 * bash executed with no prompt). Pi has no approval hook the bot's gate could
 * ride on anyway, so the backend honestly reports guard: false.
 *
 * Sessions: the `session` event id is a UUID; `--session <id>` resumes by id
 * prefix (verified live). Transcripts live at
 * ~/.pi/agent/sessions/<encoded-cwd>/<ts>_<id>.jsonl (dir overridable via
 * PI_CODING_AGENT_SESSION_DIR / PI_CODING_AGENT_DIR) — the dir name encoding is
 * not public, so listSessions() scans recent .jsonl files and matches the
 * `cwd` field inside each, instead of trusting names.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { normalizeTool } = require('./opencode-family.js');

const DATA_DIR = process.env.TGA_PI_DATA_DIR || process.env.PI_CODING_AGENT_DIR ||
  path.join(os.homedir(), '.pi', 'agent');
const SESSIONS_DIR = process.env.PI_CODING_AGENT_SESSION_DIR || path.join(DATA_DIR, 'sessions');

/* /model buttons: a short pin list of the daily drivers, provider-qualified.
 * DeepSeek V4.1 Flash is pinned under `opencode-go` only: the DeepSeek platform
 * serves the same model as `deepseek/deepseek-flash`, and two buttons for one
 * model — one of which never says "v4.1" — is how you pick the wrong one.
 * `/model <any id>` still works (fuzzy match, see `pi --list-models`), and the
 * last button, 'adaptive', is the bot's own "no opinion" marker — not a model id. */
const MODELS = [
  'opencode-go/deepseek-v4.1-flash',
  'deepseek/deepseek-v4-pro',
  'opencode-go/deepseek-v4-pro',
  'opencode-go/kimi-k3',
  'opencode-go/glm-5.3',
  'opencode-go/gpt-6-luna',
  'opencode-go/claude-haiku-5-5',
  'opencode-go/grok-4.7',
  'adaptive',
];

module.exports = {
  id: 'pi',
  name: 'Pi',
  bin: 'pi',
  models: MODELS,
  defaultModel: '',
  modelsOpen: true,
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  guard: false,
  sessions: true,
  stdinPrompt: false,

  buildArgs(ctx) {
    const args = ['-p', '--mode', 'json'];
    // 'adaptive' is the marker for "let pi decide", never a model id: omitting
    // --model makes pi use the default provider/model from its settings.json.
    // Passing it through verbatim used to make every tap fail with
    // "no models matching adaptive".
    if (ctx.model && ctx.model !== 'adaptive') args.push('--model', ctx.model);
    if (ctx.effort) args.push('--thinking', ctx.effort);
    if (ctx.sessionId) args.push('--session', ctx.sessionId);
    args.push('--', ctx.prompt);
    return { args, env: { NO_COLOR: '1', TERM: 'dumb' } };
  },

  listSessions(cwd, limit = 8) {
    let files;
    try {
      files = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .flatMap((d) => {
          const dir = path.join(SESSIONS_DIR, d.name);
          try {
            return fs.readdirSync(dir)
              .filter((f) => f.endsWith('.jsonl'))
              .map((f) => path.join(dir, f));
          } catch (_) { return []; }
        });
    } catch (_) { return []; }
    // Newest first, capped, then filter by the cwd recorded inside each file.
    files = files
      .map((f) => { try { return { f, mtime: fs.statSync(f).mtimeMs }; } catch (_) { return null; } })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 200);
    const rows = [];
    for (const { f, mtime } of files) {
      let head;
      try {
        const fd = fs.openSync(f, 'r');
        const b = Buffer.alloc(16384);
        const n = fs.readSync(fd, b, 0, b.length, 0);
        fs.closeSync(fd);
        head = b.toString('utf8', 0, n);
      } catch (_) { continue; }
      let id = '', fileCwd = '', title = '';
      for (const line of head.split('\n')) {
        if (!line) continue;
        let j;
        try { j = JSON.parse(line); } catch (_) { break; }
        if (j.type === 'title' && j.title) title = j.title;
        if (j.type === 'session') { id = j.id || ''; fileCwd = j.cwd || ''; }
        if (id && fileCwd) break;
      }
      if (!id || !fileCwd || path.resolve(fileCwd) !== path.resolve(cwd)) continue;
      rows.push({ id, mtime, title: title.slice(0, 55) });
      if (rows.length >= limit) break;
    }
    return rows;
  },

  createParser(emit) {
    let buf = '';
    let cost = 0, sawError = null;
    const handle = (evt) => {
      if (evt.type === 'session' && evt.id) { emit({ type: 'session', id: evt.id }); return; }
      if (evt.type === 'message_update') {
        const e = evt.assistantMessageEvent || {};
        if (e.type === 'text_end' && e.content && e.content.trim()) {
          emit({ type: 'text', text: e.content.trim() });
        } else if (e.type === 'toolcall_end' && e.toolCall) {
          const t = normalizeTool(e.toolCall.name, e.toolCall.arguments);
          emit({ type: 'tool', name: t.name, input: t.input });
        }
        return;
      }
      if (evt.type === 'message_end') {
        const m = evt.message || {};
        if (m.role === 'assistant') {
          const c = m.usage && m.usage.cost && m.usage.cost.total;
          if (typeof c === 'number') cost += c;
          if (m.stopReason === 'error') sawError = m.error || 'model error';
        }
        if (m.role === 'toolResult' && m.isError) sawError = sawError || `tool ${m.toolName || ''} failed`;
        return;
      }
      if (evt.type === 'error') {
        sawError = evt.error && (evt.error.message || evt.error) || 'agent error';
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
    return code !== 0 && /session.*(not found|does not exist)|no session to resume|Nothing to resume/i.test(stderr);
  },

  sessionLabel(id) { return id ? String(id).slice(0, 8) : ''; },
};
