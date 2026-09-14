'use strict';
/*
 * Backend: Devin CLI (`devin`).
 *
 *   devin -p "<prompt>" --respect-workspace-trust false
 *         --permission-mode <auto|dangerous> [--model M] [-r SESSION]
 *         --export <per-chat tmp file>
 *
 * `-p` prints only the final answer on stdout — there is no machine-readable
 * stream — so this is the one-shot template: accumulate everything, hand it
 * over at end(). The session id never reaches stdout either; `--export`
 * writes the conversation (ATIF JSON, `session_id` on top) after every turn,
 * and the parser reads it back from a per-chat temp path it derives from
 * createParser's ctx (bot.js passes the chat key). The mtime check rejects an
 * export left behind by a previous crashed run.
 *
 * Approvals: Devin has real hooks — PreToolUse and PermissionRequest, the same
 * events Claude's gate rides on. approve-hook-devin.js speaks Devin's
 * protocol ({decision: approve|block}) and stays inert without TGA_GUARD, so
 * it can sit in ~/.config/devin/config.json permanently without touching
 * interactive runs. `guard` mirrors whether that hook is registered, the same
 * way the OpenCode family mirrors its plugin.
 *
 * Permission mapping (bot mode -> devin --permission-mode):
 *   auto   -> 'auto'      read-only tools auto-approve; the rest fires
 *                         PermissionRequest, which the hook answers under
 *                         TGA_GUARD=auto — approve safe, block risky, never
 *                         wait on Telegram.
 *   others -> 'dangerous' the CLI approves everything itself, but PreToolUse
 *                         still runs and still blocks (verified), so
 *                         smart/ask gate through Telegram exactly like the
 *                         Claude bypass + hook design.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const CONFIG_FILE = path.join(os.homedir(), '.config', 'devin', 'config.json');
const HOOK_MARKER = 'approve-hook-devin.js';

/* /model buttons are a shortlist of family slugs/aliases; `devin models list`
 * shows everything and /model <any id> still works. Variants carry the effort
 * suffix (swe-2-max = swe-2 @ max), so there is no separate effort knob. */
const MODELS = [
  'adaptive',           // let Devin pick
  'swe-2-max',          // SWE-2 Max — user's configured default
  'deepseek-v4.1-flash',
  'glm-5.3-flash',
];

/** The gate is real only when the Devin hook is registered in the user config. */
function hasGuardHook() {
  try { return fs.readFileSync(CONFIG_FILE, 'utf8').includes(HOOK_MARKER); }
  catch (_) { return false; }
}

function devinBin() {
  return process.env.TGA_DEVIN_BIN || 'devin';
}

/** Per-chat path for `--export`. Same derivation in buildArgs and createParser. */
function exportFileFor(chatId) {
  const key = String(chatId == null ? 'x' : chatId).replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(os.tmpdir(), `tga-devin-${key}.json`);
}

module.exports = {
  id: 'devin',
  name: 'Devin',
  bin: 'devin',
  models: MODELS,
  modelsOpen: true,
  defaultModel: '',          // '' = no --model flag: the CLI's own config decides
  efforts: null,             // effort is baked into the model variant (swe-2-max)
  guard: hasGuardHook(),
  sessions: true,
  stdinPrompt: false,

  /**
   * ctx: { prompt, model, sessionId, guardMode ('bymode'|'none'),
   *        mode ('smart'|'ask'|'auto'), hookEnv, chatId }
   */
  buildArgs(ctx) {
    const args = ['-p', ctx.prompt, '--respect-workspace-trust', 'false'];

    let guard = (ctx.hookEnv && ctx.hookEnv.TGA_GUARD) || 'none';
    if (ctx.guardMode === 'none') {
      args.push('--permission-mode', 'dangerous');
      guard = 'none';
    } else if (ctx.mode === 'auto') {
      args.push('--permission-mode', 'auto');
      guard = 'auto';
    } else {
      args.push('--permission-mode', 'dangerous');
    }
    if (ctx.model) args.push('--model', ctx.model);
    if (ctx.sessionId) args.push('-r', ctx.sessionId);
    args.push('--export', exportFileFor(ctx.chatId));
    return { args, env: { ...(ctx.hookEnv || {}), TGA_GUARD: guard } };
  },

  listSessions(cwd, limit = 8) {
    let out;
    try {
      out = execFileSync(devinBin(), ['list', '--format', 'json'],
        { cwd, encoding: 'utf8', timeout: 20000, maxBuffer: 4 << 20, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (_) { return []; }
    let list;
    try { list = JSON.parse(out); } catch (_) { return []; }
    if (!Array.isArray(list)) return [];
    return list
      .filter((j) => j && j.id)
      .map((j) => ({
        id: j.id,
        mtime: typeof j.last_activity_at === 'number' ? j.last_activity_at * 1000 : 0,
        title: String(j.title || '').slice(0, 55),
      }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit);
  },

  /** Plain final-text stdout; the session id arrives via the --export file. */
  createParser(emit, ctx) {
    const exportFile = exportFileFor(ctx && ctx.chatId);
    const started = Date.now();
    let buf = '';
    return {
      feed(str) { buf += str; },
      end() {
        const text = buf.trim(); buf = '';
        try {
          if (fs.statSync(exportFile).mtimeMs >= started - 10000) {
            const j = JSON.parse(fs.readFileSync(exportFile, 'utf8'));
            if (j.session_id) emit({ type: 'session', id: j.session_id });
          }
        } catch (_) {}
        if (text) emit({ type: 'text', text });
        emit({ type: 'result', costUsd: 0, isError: false, text: '', denials: [] });
      },
    };
  },

  isSessionGone(stderr, code) {
    return code !== 0 && /no session found|session .* not found/i.test(stderr);
  },

  // Session ids are already short slugs ('zigzag-throne').
  sessionLabel(id) { return id || ''; },
};
