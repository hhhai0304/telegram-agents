'use strict';
/*
 * Backend: Command Code (`command-code`).
 *
 *   command-code -p "<prompt>" --output-format json --tools-all [--resume ID]
 *
 * `--output-format json` is an NDJSON event stream: wrapped
 * `{"type":"event","event":{...}}` lines plus one final
 * `{"type":"result",...}` line with `finalText`. No PreToolUse-style hook,
 * so guard:false — the CLI runs with `--tools-all` (headless -p withholds
 * some tools without it), same off-the-leash model as the OpenCode family.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECTS_DIR = path.join(os.homedir(), '.commandcode', 'projects');

function projectDirFor(cwd) {
  return path.join(PROJECTS_DIR, cwd.replace(/[^a-zA-Z0-9]/g, '-'));
}

/* /model buttons are a shortlist; any other id from --list-models still works. */
const MODELS = [
  'deepseek/deepseek-v4-flash',   // default
  'deepseek/deepseek-v4-pro',     // việc nặng, lên plan
  'deepseek/deepseek-v4.1-flash', // V4.1, vision
  'moonshotai/kimi-k3',           // context 1M
  'z-ai/glm-5.3-flash',           // fast, rẻ
];

module.exports = {
  id: 'commandcode',
  name: 'Command Code',
  bin: 'command-code',
  models: MODELS,
  modelsOpen: true,
  defaultModel: MODELS[0],
  efforts: ['low', 'medium', 'high'],
  guard: false,
  sessions: true,
  stdinPrompt: false,

  /**
   * ctx: { model, effort, sessionId, guardMode, mode, settingsFile, hookEnv }
   * guardMode/mode/settingsFile/hookEnv are unused: no approval hook exists.
   */
  buildArgs(ctx) {
    const args = ['-p', ctx.prompt, '--output-format', 'json', '--tools-all', '--trust', '--skip-onboarding'];
    if (ctx.model) args.push('--model', ctx.model);
    if (ctx.effort) args.push('--effort', ctx.effort);
    if (ctx.sessionId) args.push('--resume', ctx.sessionId);
    return { args, env: {} };
  },

  listSessions(cwd, limit = 8) {
    const dir = projectDirFor(cwd);
    if (!fs.existsSync(dir)) return [];
    let files;
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl') && !f.includes('.checkpoints.'));
    } catch (_) { return []; }
    const rows = files.map((f) => {
      const full = path.join(dir, f);
      const id = f.replace(/\.jsonl$/, '');
      let mtime = 0, title = '';
      try { mtime = fs.statSync(full).mtimeMs; } catch (_) {}
      try { title = JSON.parse(fs.readFileSync(full.replace(/\.jsonl$/, '.meta.json'), 'utf8')).title || ''; }
      catch (_) {}
      return { id, mtime, title };
    });
    rows.sort((a, b) => b.mtime - a.mtime);
    return rows.slice(0, limit);
  },

  createParser(emit) {
    let buf = '';
    const handle = (j) => {
      // Unwrap {"type":"event","event":{...}} envelopes.
      if (j.type === 'event' && j.event && typeof j.event === 'object') {
        const e = j.event;
        if (e.type === 'run_start' && e.sessionId) emit({ type: 'session', id: e.sessionId });
        else if (e.type === 'message_end' && Array.isArray(e.content)) {
          for (const block of e.content) {
            if (block.type === 'text' && block.text && block.text.trim()) {
              emit({ type: 'text', text: block.text.trim() });
            } else if (block.type === 'tool_use' && block.name) {
              emit({ type: 'tool', name: block.name, input: block.input || {} });
            }
          }
        }
        return;
      }
      // Final line: {"type":"result","subtype":"success","sessionId":...,"finalText":...}
      if (j.type === 'result') {
        if (j.sessionId) emit({ type: 'session', id: j.sessionId });
        emit({
          type: 'result',
          costUsd: 0,
          isError: j.subtype !== 'success',
          text: j.finalText || '',
          denials: [],
        });
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
        if (!line) return;
        try { handle(JSON.parse(line)); } catch (_) { emit({ type: 'noise', text: line }); }
      },
    };
  },

  isSessionGone(stderr, code) {
    return code !== 0 && /not found|no session/i.test(stderr);
  },

  sessionLabel(id) { return id ? id.slice(0, 8) : ''; },
};
