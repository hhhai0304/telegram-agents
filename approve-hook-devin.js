#!/usr/bin/env node
'use strict';
/*
 * PreToolUse / PermissionRequest hook for Devin CLI — the approval gate.
 *
 * Same job as approve-hook.js (which speaks Claude Code's protocol), but emits
 * Devin's decision format on stdout: {"decision":"approve"|"block","reason"}.
 * Exit 2 would also block; the JSON form carries the reason through.
 *
 * Registered globally in ~/.config/devin/config.json, so it fires in EVERY
 * devin run — including interactive ones the bot has nothing to do with. It
 * therefore stays INERT unless TGA_GUARD is set: no env, no output, exit 0.
 *
 * TGA_GUARD:
 *   none  — off the leash: approve everything, never ask
 *   auto  — never ask: approve what risk.js calls safe, block the rest
 *   smart — ask about dangerous calls only (Telegram buttons)
 *   all   — ask about everything except TGA_AUTO_ALLOW
 *
 * FAIL CLOSED, same as the Claude hook: if the owner cannot be reached the
 * answer is block, never a silent pass.
 */

const path = require('path');

const GUARD = process.env.TGA_GUARD || '';
if (!GUARD) process.exit(0);          // not a bot run — leave interactive sessions alone

const risk = require(path.join(__dirname, 'risk.js'));

const AUTO_ALLOW = new Set(
  (process.env.TGA_AUTO_ALLOW || 'Read,Glob,Grep,TodoWrite')
    .split(',').map((s) => s.trim()).filter(Boolean)
);

/* Devin's tool names are lowercase; risk.js and the Telegram labels speak the
 * Claude Code vocabulary. Unknown names pass through unchanged — risk.js asks
 * about anything it does not classify. */
const NAME_MAP = {
  exec: 'Bash',
  read: 'Read', write: 'Write', edit: 'Edit', apply_patch: 'Edit',
  multiedit: 'MultiEdit', notebook_edit: 'NotebookEdit',
  grep: 'Grep', glob: 'Glob', find_file_by_name: 'Glob', list: 'Glob',
  webfetch: 'WebFetch', web_search: 'WebSearch',
  todo_write: 'TodoWrite', skill: 'Skill',
  run_subagent: 'Task', read_subagent: 'TaskOutput',
};

function emit(decision, reason) {
  process.stdout.write(JSON.stringify({ decision, reason: String(reason || '') }));
  process.exit(0);
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', async () => {
  let payload;
  try { payload = JSON.parse(raw); }
  catch (e) { return emit('block', 'hook: could not parse input'); }

  const tool = NAME_MAP[payload.tool_name] || payload.tool_name || 'tool';
  const input = payload.tool_input || {};
  const cwd = process.env.DEVIN_PROJECT_DIR || payload.cwd;
  const why = { v: '' };

  if (GUARD === 'none') {
    return emit('approve', 'off the leash (guard=none)');
  }
  if (GUARD === 'auto' || GUARD === 'smart') {
    const v = risk.classify(tool, input, cwd);
    if (!v.ask) return emit('approve', `auto-allowed — ${v.why}`);
    if (GUARD === 'auto') return emit('block', `auto mode, cannot ask: ${v.why}`);
    why.v = v.why;
  } else if (AUTO_ALLOW.has(tool)) {
    return emit('approve', 'auto-allowed (read-only tool)');
  }

  const url = process.env.TGA_APPROVE_URL;
  const token = process.env.TGA_APPROVE_TOKEN;
  const chatId = process.env.TGA_CHAT;
  if (!url || !token || !chatId) {
    return emit('block', 'hook: approval gate not configured — cannot reach the owner');
  }

  // Wait slightly longer than the bot's own timeout so the bot owns the deadline.
  const waitMs = (Number(process.env.TGA_APPROVE_TIMEOUT_SEC || 300) + 20) * 1000;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token, chatId,
        payload: { ...payload, tool_name: tool },
        why: why.v,
      }),
      signal: AbortSignal.timeout(waitMs),
    });
    if (!res.ok) return emit('block', `hook: bot returned HTTP ${res.status}`);
    const j = await res.json();
    return emit(j.decision === 'allow' ? 'approve' : 'block', j.reason || 'no reason given');
  } catch (e) {
    return emit('block', `hook: could not reach the owner (${e.name === 'TimeoutError' ? 'timed out' : e.message})`);
  }
});
