'use strict';
/*
 * Backend: Antigravity CLI (`agy`, Google Antigravity).
 *
 *   agy --print "<prompt>" --output-format stream-json --print-timeout 1h
 *       --dangerously-skip-permissions [--model M] [--effort L] [--conversation ID]
 *
 * Two argument quirks are load-bearing:
 *   - `--print` consumes the NEXT TOKEN as the prompt (it is not a boolean
 *     flag), so the prompt must immediately follow it -- putting another flag
 *     in between makes that flag the prompt.
 *   - Without `--dangerously-skip-permissions`, headless agy auto-DENIES every
 *     tool that needs permission; there is no hook for the Telegram gate, so
 *     skipping is required and guard stays honestly false.
 *
 * `--output-format stream-json` emits one NDJSON object per line, enveloped by
 * `event` (documented + cross-checked against live captures):
 *   { event: 'init',        conversation_id, init: { cwd, tools, ... } }
 *   { event: 'step_update', step_update: { step_index, state: 'ACTIVE'|'DONE',
 *        step_type: 'agent_response'|'tool'|..., text_delta?, ... } }
 *   { event: 'result',      result: { status: 'SUCCESS'|'OK'|..., response,
 *        error?, usage: { input_tokens, output_tokens, ... } } }
 * `result` is terminal; a failed `-p` run exits non-zero with an AGY_ERROR line
 * and the result's `error` field. A stdout line that is not JSON is plain
 * assistant text (older agy builds), so it is forwarded as a delta.
 *
 * Resume: `--conversation <id>` with the id from `init`; `--continue` continues
 * the most recent one. Conversation store layout is not documented, so
 * sessions: false — the id captured in state still resumes the next turn.
 */

module.exports = {
  id: 'antigravity',
  name: 'Antigravity',
  bin: 'agy',
  models: [],
  defaultModel: '',
  efforts: ['low', 'medium', 'high'],
  guard: false,
  sessions: false,
  stdinPrompt: false,

  buildArgs(ctx) {
    // --print FIRST: it eats the next token as the prompt value.
    const args = ['--print', ctx.prompt,
      '--output-format', 'stream-json',
      '--print-timeout', '1h',
      '--dangerously-skip-permissions'];
    if (ctx.model) args.push('--model', ctx.model);
    if (ctx.effort) args.push('--effort', ctx.effort);
    if (ctx.sessionId) args.push('--conversation', ctx.sessionId);
    return { args, env: { NO_COLOR: '1', TERM: 'dumb' } };
  },

  listSessions() { return []; },

  createParser(emit) {
    let buf = '';
    let sawError = null, gotText = false;
    const seenTools = new Set();
    const stepText = new Map();   // step_index -> accumulated delta text

    /* The bot joins text events with blank lines, so one event per delta would
     * render every chunk as its own paragraph — mid-word breaks included.
     * Deltas are held per step and emitted as a single block once the step is
     * done: when a later step_update arrives, and finally at result/end(). */
    const flushSteps = (below = Infinity) => {
      const ready = [...stepText.keys()].filter((i) => i < below).sort((a, b) => a - b);
      for (const i of ready) {
        const t = stepText.get(i);
        stepText.delete(i);
        if (t.trim()) emit({ type: 'text', text: t.trim() });
      }
    };

    const handle = (evt) => {
      switch (evt.event) {
        case 'init':
          if (evt.conversation_id) emit({ type: 'session', id: evt.conversation_id });
          return;
        case 'step_update': {
          const s = evt.step_update || {};
          // A later step means every earlier text step is finished — flush
          // them first so message order matches the agent's.
          if (typeof s.step_index === 'number') flushSteps(s.step_index);
          if (s.step_type === 'tool' || s.tool_name || s.tool) {
            if (seenTools.has(s.step_index)) return;
            seenTools.add(s.step_index);
            const ti = s.tool_info || {};
            const name = ti.name || s.tool_name || s.tool || 'tool';
            const input = ti.parameters || s.input || s.args || s.arguments || s.parameters || {};
            emit({ type: 'tool', name: String(name), input });
            return;
          }
          // Agent text: prefer deltas; on DONE fall back to a whole-step field
          // if no deltas ever arrived for it.
          const delta = s.text_delta || s.delta;
          if (typeof delta === 'string' && delta) {
            stepText.set(s.step_index, (stepText.get(s.step_index) || '') + delta);
            gotText = true;
            return;
          }
          if (s.state === 'DONE' && !stepText.has(s.step_index)) {
            const t = s.text || s.content || s.output;
            if (typeof t === 'string' && t.trim()) { emit({ type: 'text', text: t.trim() }); gotText = true; }
          }
          return;
        }
        case 'result': {
          flushSteps();
          const r = evt.result || {};
          const status = String(r.status || '').toUpperCase();
          if (r.error) sawError = typeof r.error === 'string' ? r.error : JSON.stringify(r.error);
          if (!sawError && status && status !== 'SUCCESS' && status !== 'OK') sawError = `status ${status}`;
          if (typeof r.response === 'string' && r.response.trim() && !gotText) {
            emit({ type: 'text', text: r.response.trim() });
            gotText = true;
          }
          return;
        }
        case 'error':
          sawError = evt.error && (evt.error.message || evt.error) || 'agent error';
          return;
        default:
          return;
      }
    };

    const onLine = (line) => {
      if (!line) return;
      let j;
      try { j = JSON.parse(line); } catch (_) {
        // Plain stdout line = assistant text on older agy builds.
        emit({ type: 'text', text: line });
        gotText = true;
        return;
      }
      handle(j);
    };

    return {
      feed(str) {
        buf += str;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          onLine(line);
        }
      },
      end() {
        const line = buf.trim(); buf = '';
        if (line) onLine(line);
        flushSteps();
        emit({ type: 'result', costUsd: 0, isError: !!sawError, text: sawError || '', denials: [] });
      },
    };
  },

  isSessionGone(stderr, code) {
    return code !== 0 && /conversation.*(not found|does not exist)|no conversation/i.test(stderr);
  },

  sessionLabel(id) { return id ? String(id).slice(0, 8) : ''; },
};
