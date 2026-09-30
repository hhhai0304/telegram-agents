'use strict';
/*
 * Backend: OMP CLI (`omp`, oh-my-pi / pi-coding-agent lineage).
 *
 *   omp -p --mode json --auto-approve [--model M] [--thinking L] [-r SID] -- "<prompt>"
 *
 * `--mode json` prints one NDJSON event per line. Verified shapes (v18.4.1):
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
 * `--auto-approve` is required: without it `-p` keeps asking on stdout where
 * nobody can answer. OMP has a `--hook` extension mechanism that could later
 * host the approval gate; until one is written the backend honestly reports
 * guard: false.
 *
 * Sessions: `--session`/`init` id is a UUID; `-r <id>` resumes by id prefix.
 * Transcripts live at ~/.omp/agent/sessions/<encoded-cwd>/<ts>_<id>.jsonl —
 * the dir name encoding is not public, so listSessions() scans recent .jsonl
 * files and matches the `cwd` field inside each, instead of trusting names.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { normalizeTool } = require('./opencode-family.js');

const DATA_DIR = process.env.TGA_OMP_DATA_DIR || path.join(os.homedir(), '.omp', 'agent');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');

/* /model buttons: 'adaptive' lets OMP's provider pick; `omp models` shows the
 * rest and /model <any id> still works (fuzzy match). */
const MODELS = ['adaptive'];

module.exports = {
  id: 'omp',
  name: 'OMP',
  bin: 'omp',
  models: MODELS,
  defaultModel: '',
  modelsOpen: true,
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  guard: false,
  sessions: true,
  stdinPrompt: false,

  buildArgs(ctx) {
    const args = ['-p', '--mode', 'json', '--auto-approve'];
    if (ctx.model) args.push('--model', ctx.model);
    if (ctx.effort) args.push('--thinking', ctx.effort);
    if (ctx.sessionId) args.push('-r', ctx.sessionId);
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
