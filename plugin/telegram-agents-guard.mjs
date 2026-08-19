/*
 * Telegram approval gate for the OpenCode family (OpenCode, Kilo CLI).
 *
 * These CLIs have no PreToolUse hook like Claude Code, so the gate lives in a
 * plugin instead: `tool.execute.before` runs before every tool call and a THROW
 * aborts that call. The bot passes the same TGA_* environment the Claude hook
 * gets (approve-hook.js), and the verdict comes from the same loopback endpoint
 * and the same risk.js classifier, so both agents behave identically.
 *
 * Install (per CLI, the directory is the CLI's own config dir):
 *   ln -s ~/telegram-agents/plugin/telegram-agents-guard.js \
 *         ~/.config/kilo/plugin/telegram-agents-guard.js
 *
 * FAIL CLOSED. Once TGA_GUARD is smart|all, anything that goes wrong — no
 * approval URL, risk.js missing, bot down, timeout — denies the call. The one
 * exception is TGA_GUARD=none (or unset), which makes the plugin inert so a
 * human running `kilo` by hand keeps the CLI's own permission prompts.
 *
 * NOTE: this gate covers tool calls, which is where the damage is, but the CLI
 * still runs with --auto, so anything it does OUTSIDE a tool call is ungated.
 */

import { createRequire } from 'node:module';

// Everything is read once, at load: the CLI is spawned per turn with these
// already in its environment, and a value that can change under the gate's feet
// is a value the gate cannot be reasoned about.
const GUARD = process.env.TGA_GUARD || 'none';
const APP_DIR = process.env.TGA_APP_DIR || '';
const APPROVE_URL = process.env.TGA_APPROVE_URL || '';
const APPROVE_TOKEN = process.env.TGA_APPROVE_TOKEN || '';
const CHAT_ID = process.env.TGA_CHAT || '';
// Wait slightly longer than the bot's own deadline so the bot owns it.
const WAIT_MS = (Number(process.env.TGA_APPROVE_TIMEOUT_SEC || 300) + 20) * 1000;
const AUTO_ALLOW = new Set(
  (process.env.TGA_AUTO_ALLOW || 'Read,Glob,Grep,TodoWrite')
    .split(',').map((s) => s.trim()).filter(Boolean)
);

/** Load risk.js and the tool-name mapping from the bot's directory.
 *  Deliberately lazy: a throw at plugin-load time may only be logged, which
 *  would leave the CLI running unguarded. A throw inside the hook denies. */
function load() {
  if (!APP_DIR) throw new Error('TGA_APP_DIR is not set');
  const require = createRequire(`${APP_DIR}/`);
  return {
    risk: require(`${APP_DIR}/risk.js`),
    normalizeTool: require(`${APP_DIR}/backends/opencode-family.js`).normalizeTool,
  };
}

// The default `= {}` is load-bearing: kilo 7.4.22 calls the plugin factory at
// least once with NO context, so `async ({ directory }) =>` throws a TypeError
// on undefined -- and a factory that throws is dropped SILENTLY, no warning in
// the log, no hooks installed, the CLI just runs unguarded. Measured.
export const TelegramAgentsGuard = async (ctx = {}) => {
  if (GUARD === 'none') return {};

  let mods = null;
  let loadError = null;
  try { mods = load(); } catch (e) { loadError = e; }

  return {
    'tool.execute.before': async (input, output) => {
      if (loadError) throw new Error(`approval gate broken: ${loadError.message}`);

      const { name, input: args } = mods.normalizeTool(input.tool, (output && output.args) || {});
      // Resolved per call, not captured: the context-less factory call above
      // would otherwise pin cwd to undefined for the whole run.
      const cwd = (ctx && ctx.directory) || process.cwd();

      let why = '';
      if (GUARD === 'smart') {
        // risk.js is the single arbiter, exactly as in approve-hook.js.
        // AUTO_ALLOW is ignored here on purpose: "Read" in that list would
        // silently open ~/.ssh/id_ed25519.
        const v = mods.risk.classify(name, args, cwd);
        if (!v.ask) return;
        why = v.why;
      } else if (AUTO_ALLOW.has(name)) {
        return;
      }

      if (!APPROVE_URL || !APPROVE_TOKEN || !CHAT_ID) throw new Error('approval gate not configured — cannot reach the owner');

      let verdict;
      try {
        const res = await fetch(APPROVE_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            token: APPROVE_TOKEN, chatId: CHAT_ID, why,
            payload: { tool_name: name, tool_input: args, cwd },
          }),
          signal: AbortSignal.timeout(WAIT_MS),
        });
        if (!res.ok) throw new Error(`bot returned HTTP ${res.status}`);
        verdict = await res.json();
      } catch (e) {
        throw new Error(`denied — could not reach the owner (${e.name === 'TimeoutError' ? 'timed out' : e.message})`);
      }

      if (verdict.decision !== 'allow') throw new Error(verdict.reason || 'denied by the owner');
    },
  };
};
