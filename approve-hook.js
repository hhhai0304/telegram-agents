#!/usr/bin/env node
'use strict';
/*
 * PreToolUse hook — the approval gate.
 *
 * Claude Code runs this file BEFORE every tool call. It asks the bot over loopback
 * HTTP; the bot puts buttons in Telegram, waits for the owner to decide, and
 * sends the verdict back here.
 *
 * Principle: FAIL CLOSED. Any malfunction (bot down, timeout, bad token)
 * returns "deny" — it never allows on its own when it cannot reach a human.
 *
 * TGA_GUARD:
 *   none  — off the leash: allow everything, never ask
 *   smart — only ask about dangerous calls, as classified by risk.js
 *   all   — ask about everything except TGA_AUTO_ALLOW
 *
 * Under 'none' the fail-closed principle below is moot (there is no prompt left
 * to close). Put the leash back on with TGA_GUARD_MODE=bymode in
 * config.env — see bot.js. Only the Claude Code backend uses this hook.
 */

const path = require('path');
const risk = require(path.join(__dirname, 'risk.js'));

const GUARD = process.env.TGA_GUARD || 'smart';
const AUTO_ALLOW = new Set(
  (process.env.TGA_AUTO_ALLOW || 'Read,Glob,Grep,TodoWrite')
    .split(',').map((s) => s.trim()).filter(Boolean)
);

function emit(decision, reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', async () => {
  let payload;
  try { payload = JSON.parse(raw); }
  catch (e) { return emit('deny', 'hook: could not parse input'); }

  let why = '';
  if (GUARD === 'none') {
    // Off the leash: no classification, no prompt, no waiting on the bot. The
    // hook stays in place so the leash is one environment variable away.
    return emit('allow', 'off the leash (guard=none)');
  }
  if (GUARD === 'smart') {
    // risk.js is the single arbiter here — AUTO_ALLOW is deliberately NOT used,
    // because "Read" in AUTO_ALLOW would silently open up ~/.ssh/id_ed25519.
    const v = risk.classify(payload.tool_name, payload.tool_input, payload.cwd);
    if (!v.ask) return emit('allow', `auto-allowed — ${v.why}`);
    why = v.why;
  } else if (AUTO_ALLOW.has(payload.tool_name)) {
    return emit('allow', 'auto-allowed (read-only tool)');
  }

  const url = process.env.TGA_APPROVE_URL;
  const token = process.env.TGA_APPROVE_TOKEN;
  const chatId = process.env.TGA_CHAT;
  if (!url || !token || !chatId) {
    return emit('deny', 'hook: approval gate not configured — cannot reach the owner');
  }

  // Wait slightly longer than the bot's own timeout so the bot owns the deadline.
  const waitMs = (Number(process.env.TGA_APPROVE_TIMEOUT_SEC || 300) + 20) * 1000;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, chatId, payload, why }),
      signal: AbortSignal.timeout(waitMs),
    });
    if (!res.ok) return emit('deny', `hook: bot returned HTTP ${res.status}`);
    const j = await res.json();
    return emit(j.decision === 'allow' ? 'allow' : 'deny', j.reason || 'no reason given');
  } catch (e) {
    return emit('deny', `hook: could not reach the owner (${e.name === 'TimeoutError' ? 'timed out' : e.message})`);
  }
});
