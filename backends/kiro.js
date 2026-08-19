'use strict';
/*
 * Backend: Kiro CLI (`kiro-cli`, the successor of Amazon Q Developer CLI).
 *
 *   kiro-cli chat --no-interactive --trust-all-tools [--resume] [--model M] [--agent A] "<prompt>"
 *
 * Kiro has no machine-readable output for `chat`: stdout is the rendered
 * conversation (with ANSI colours and spinner frames). This backend strips the
 * escape codes, drops spinner/tool-status chatter, and hands the whole answer
 * over once the process exits. Tool calls are counted from the
 * "Using tool: <name>" lines Kiro prints, so the progress ticker still moves.
 *
 * Sessions: Kiro keeps ONE conversation per directory and `--resume` continues
 * it. There is nothing to list, so `sessions: false` and the session id is the
 * marker string 'last' — /new drops it (fresh conversation), a finished turn
 * sets it (next turn resumes).
 *
 * `--trust-all-tools` is required in non-interactive mode; there is no hook to
 * plug the Telegram approval gate into, so guard: false.
 */

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][A-Za-z0-9]/g;
const TOOL_LINE = /Using tool:\s*([A-Za-z0-9_.-]+)/;
const NOISE = /^(\s*[⠁-⣿◐◓◑◒|/\\-]\s*)?(Thinking|Working|Loading|Waiting)\b/i;

const KIRO_TOOL_NAMES = {
  fs_read: 'Read', fs_write: 'Write', execute_bash: 'Bash', use_aws: 'use_aws',
};

module.exports = {
  id: 'kiro',
  name: 'Kiro CLI',
  bin: 'kiro-cli',
  models: [],
  defaultModel: '',
  efforts: null,
  guard: false,
  sessions: false,
  stdinPrompt: false,

  buildArgs(ctx) {
    const args = ['chat', '--no-interactive', '--trust-all-tools'];
    if (ctx.model) args.push('--model', ctx.model);
    if (process.env.TGA_KIRO_AGENT) args.push('--agent', process.env.TGA_KIRO_AGENT);
    if (ctx.sessionId) args.push('--resume');
    args.push('--', ctx.prompt);
    return { args, env: { NO_COLOR: '1', TERM: 'dumb' } };
  },

  listSessions() { return []; },

  createParser(emit) {
    let buf = '';
    const out = [];
    const line = (raw) => {
      const l = raw.replace(ANSI, '');
      const m = TOOL_LINE.exec(l);
      if (m) { emit({ type: 'tool', name: KIRO_TOOL_NAMES[m[1]] || m[1], input: {} }); return; }
      if (NOISE.test(l)) return;
      out.push(l.replace(/\s+$/, ''));
    };
    return {
      feed(str) {
        buf += str;
        // Spinners redraw with \r; keep only the last thing written on the line.
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const seg = buf.slice(0, nl); buf = buf.slice(nl + 1);
          line(seg.slice(seg.lastIndexOf('\r') + 1));
        }
      },
      end() {
        if (buf.trim()) line(buf.slice(buf.lastIndexOf('\r') + 1));
        buf = '';
        const text = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
        if (text) emit({ type: 'text', text });
        emit({ type: 'session', id: 'last' });
        emit({ type: 'result', costUsd: 0, isError: false, text: '', denials: [] });
      },
    };
  },

  isSessionGone(stderr, code) {
    return code !== 0 && /no (previous )?conversation|nothing to resume/i.test(stderr);
  },

  sessionLabel(id) { return id ? 'last' : ''; },
};
