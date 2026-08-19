'use strict';
/*
 * Backend: Claude Code (`claude`).
 *
 *   claude -p --output-format stream-json --verbose [--resume ID] ...
 *
 * The only backend with a working approval gate: a PreToolUse hook
 * (approve-hook.js) calls back into the bot before every tool call.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

// Mode "auto": never asks, and only read-only tools plus harmless bash are allowed.
const SAFE_TOOLS = [
  'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite',
  'Bash(ls:*)', 'Bash(cat:*)', 'Bash(head:*)', 'Bash(tail:*)', 'Bash(wc:*)',
  'Bash(grep:*)', 'Bash(find:*)', 'Bash(stat:*)', 'Bash(file:*)',
  'Bash(df:*)', 'Bash(du:*)', 'Bash(free:*)', 'Bash(uptime:*)', 'Bash(uname:*)',
  'Bash(date:*)', 'Bash(whoami:*)', 'Bash(id:*)', 'Bash(ps:*)',
  'Bash(docker ps:*)', 'Bash(docker logs:*)', 'Bash(docker inspect:*)',
  'Bash(docker stats:*)', 'Bash(docker images:*)',
  'Bash(systemctl status:*)', 'Bash(journalctl:*)', 'Bash(ip:*)', 'Bash(ss:*)',
  'Bash(ping:*)', 'Bash(dig:*)', 'Bash(git status:*)', 'Bash(git log:*)',
  'Bash(git diff:*)', 'Bash(vcgencmd:*)',
].join(',');

function projectDirFor(cwd) {
  return path.join(PROJECTS_DIR, cwd.replace(/[^a-zA-Z0-9]/g, '-'));
}

/** Use the user's first prompt as the session title. */
function sessionTitle(file) {
  try {
    // Read only the first 64KB — transcripts can be megabytes; never slurp the file.
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(65536);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    for (const line of buf.slice(0, n).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      let j;
      try { j = JSON.parse(line); } catch (_) { continue; }
      if (j.type !== 'user' || !j.message) continue;
      const c = j.message.content;
      let t = typeof c === 'string' ? c
        : Array.isArray(c) ? (c.find((b) => b.type === 'text') || {}).text || '' : '';
      t = String(t).replace(/\s+/g, ' ').trim();
      if (t) return t.length > 55 ? t.slice(0, 52) + '…' : t;
    }
  } catch (_) {}
  return '';
}

module.exports = {
  id: 'claude',
  name: 'Claude Code',
  bin: 'claude',
  models: ['sonnet', 'opus', 'haiku', 'fable'],
  defaultModel: 'sonnet',
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  guard: true,
  sessions: true,
  stdinPrompt: true,

  /**
   * ctx: { model, effort, sessionId, guardMode ('bymode'|'none'), mode
   *        ('smart'|'ask'|'auto'), settingsFile, hookEnv }
   */
  buildArgs(ctx) {
    const args = ['-p', '--output-format', 'stream-json', '--verbose'];
    if (ctx.model) args.push('--model', ctx.model);
    if (ctx.effort) args.push('--effort', ctx.effort);
    if (ctx.guardMode === 'none') {
      // Off the leash: EVERY mode bypasses, including 'auto'. Measured: under
      // `--dangerously-skip-permissions`, `--allowedTools` is ignored (running
      // with --allowedTools=Read still lets Bash through), so keeping SAFE_TOOLS
      // here would only create a false sense of safety.
      args.push('--dangerously-skip-permissions', '--settings', ctx.settingsFile);
    } else if (ctx.mode === 'auto') {
      args.push('--permission-mode', 'acceptEdits', '--allowedTools', SAFE_TOOLS);
    } else {
      // `--dangerously-skip-permissions`, not `default`, on purpose.
      //
      // Claude Code has a "sensitive file" guard that blocks writes to the whole
      // `~/.claude/**` tree (except the memory directory). That guard runs AFTER
      // the hook, so approve-hook.js returning `permissionDecision: "allow"` gets
      // overridden, and under `-p` there is no dialog left to grant it -> the
      // error reads "you haven't granted it yet". Neither `acceptEdits` nor an
      // `Edit(/~/.claude/**)` settings rule opens it; only the bypass does.
      //
      // This stays safe because the hook STILL RUNS under bypass and its `deny`
      // STILL BLOCKS (verified with a stub deny hook). All authority therefore
      // funnels into risk.js plus the Telegram buttons, which is the intended
      // design: risk.js is the single arbiter.
      args.push('--dangerously-skip-permissions', '--settings', ctx.settingsFile);
    }
    if (ctx.sessionId) args.push('--resume', ctx.sessionId);
    return { args, env: ctx.hookEnv };
  },

  listSessions(cwd, limit = 8) {
    const dir = projectDirFor(cwd);
    if (!fs.existsSync(dir)) return [];
    let files;
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); }
    catch (_) { return []; }
    const rows = files.map((f) => {
      const full = path.join(dir, f);
      let mtime = 0;
      try { mtime = fs.statSync(full).mtimeMs; } catch (_) {}
      return { id: f.replace(/\.jsonl$/, ''), file: full, mtime };
    });
    rows.sort((a, b) => b.mtime - a.mtime);
    return rows.slice(0, limit).map((r) => ({ id: r.id, mtime: r.mtime, title: sessionTitle(r.file) }));
  },

  /** stream-json: one JSON object per line. */
  createParser(emit) {
    let buf = '';
    const handle = (evt) => {
      if (evt.type === 'system' && evt.subtype === 'init') {
        if (evt.session_id) emit({ type: 'session', id: evt.session_id });
        return;
      }
      if (evt.type === 'assistant' && evt.message && Array.isArray(evt.message.content)) {
        for (const block of evt.message.content) {
          if (block.type === 'text' && block.text && block.text.trim()) {
            emit({ type: 'text', text: block.text.trim() });
          } else if (block.type === 'tool_use') {
            emit({ type: 'tool', name: block.name, input: block.input || {} });
          }
        }
        return;
      }
      if (evt.type === 'result') {
        if (evt.session_id) emit({ type: 'session', id: evt.session_id });
        emit({
          type: 'result',
          costUsd: typeof evt.total_cost_usd === 'number' ? evt.total_cost_usd : 0,
          isError: !!evt.is_error,
          text: evt.result || '',
          denials: (evt.permission_denials || []).map((d) => d.tool_name || 'tool'),
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
    return code !== 0 && /No conversation found|session .* not found/i.test(stderr);
  },

  sessionLabel(id) { return id ? id.slice(0, 8) : ''; },
};
