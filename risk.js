'use strict';
/*
 * Risk classification for a single tool call.
 *
 *   classify(toolName, toolInput) -> { ask: boolean, why: string }
 *
 * Shared by approve-hook.js (decides whether to ask) and bot.js (turn recap).
 *
 * Principle: ASKING TOO OFTEN BEATS MISSING SOMETHING.
 *   - Matches no rule -> treated as safe, runs straight through.
 *   - Unknown tool (MCP, newly added) -> always asks.
 * Erring toward "asks too much" costs one tap; erring the other way costs data.
 */

const fs = require('fs');
const path = require('path');

const rx = (parts) => new RegExp(parts.join('|'), 'i');

/* --- Secrets: even READING them has to ask --------------------------------
 *
 * Split in two because the two are used in different places:
 *
 *   SECRET_FILE — only things that are unmistakably a PATH to a secret. Safe to
 *     apply to both shell commands and the contents of source files.
 *   SECRET_WORD — generic keywords. In a shell command `grep -r password` is
 *     worth asking about, but applied to source code it falls apart:
 *     `credentials: "include"` in a fetch, a variable named `token`... so it is
 *     NOT used when scanning file contents.
 *
 * `.env` needs a path-like character in front of it, otherwise `process.env.PORT`
 * matches too — that false positive is exactly what once flagged a harmless script.
 */
const SECRET_FILE = rx([
  '\\.ssh\\b', '\\.gnupg\\b', '\\.aws/', '\\.kube/config', '\\.docker/config\\.json',
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'authorized_keys',
  '\\.pem\\b', '\\.p12\\b', '\\.pfx\\b', '\\.jks\\b',
  '_secrets\\b', 'passphrase',
  '(?:^|[\\s"\'/=(])\\.env(?:\\.[\\w-]+)?\\b', '\\.envrc\\b',
  '/etc/shadow', '/etc/gshadow', '/etc/sudoers',
  '\\.netrc\\b', '\\.git-credentials', '\\.npmrc\\b', '\\.pypirc\\b', '\\.htpasswd\\b',
  '\\.claude\\.json', '\\.credentials\\.json',
  'rclone\\.conf', 'wg\\d*\\.conf', 'wireguard',
  '\\.bash_history', '\\.zsh_history',
]);

const SECRET_WORD = rx([
  '\\bsecret', '\\bpasswd\\b', 'password', 'credential',
  '\\btokens?\\b', 'api[_-]?key', '\\bapikey\\b', '\\.key\\b',
]);

const SECRET = { test: (s) => SECRET_FILE.test(s) || SECRET_WORD.test(s) };

/* --- System directories: WRITING asks, reading is free -------------------- */
const SYSTEM_PATH = rx([
  '^/etc/', '^/boot/', '^/usr/', '^/bin/', '^/sbin/', '^/lib', '^/opt/',
  '^/srv/', '^/proc/', '^/sys/', '^/dev/', '^/var/(?!tmp/)', '^/mnt/', '^/media/',
]);

/* Writing to system paths from a shell: `>` redirection or tee.
 * `/dev` is handled separately because `2>/dev/null` is the single most common
 * shell idiom there is — lumping it in would flag nearly every command. Writing
 * to `/dev/sda` still asks. */
const WRITE_TO_SYSTEM = rx([
  '>>?\\s*/(?:etc|boot|usr|bin|sbin|lib|opt|srv|proc|sys|var|mnt|media)\\b',
  '>>?\\s*/dev/(?!null|zero|stdout|stderr|full|tty|random|urandom|fd/)',
  '\\btee\\b[^|;&]*\\s/(?:etc|boot|usr|bin|sbin|lib|opt|srv|var|mnt)\\b',
  // rsync/cp/install landing in a system directory (e.g. deploying to /var/www)
  '\\b(?:rsync|cp|install)\\b[^|;&]*\\s/(?:etc|boot|usr|bin|sbin|lib|opt|srv|var|mnt)/',
]);

/* Files under $HOME whose contents drive startup or scheduled execution.
 *
 * The whole `~/.claude` tree belongs here, not just settings/hooks: skills,
 * agents, commands and plugins are all loaded by Claude itself — being able to
 * edit them means rewriting your own behaviour for the next turn. This used to
 * be unnecessary because Claude Code's built-in "sensitive file" guard covered
 * it; once the bridge started running with `--dangerously-skip-permissions`
 * (see bot.js) that guard is off and this hook is the only door left.
 *
 * `projects/<cwd>/memory/` is exempt — memory files are just notes, written
 * constantly, and prompting for each one would mean a button every turn. */
const HOME_SENSITIVE = rx([
  '\\.bashrc', '\\.bash_profile', '\\.profile\\b', '\\.zshrc', '\\.zprofile',
  '\\.config/systemd', '\\.config/autostart', 'crontab',
  '\\.claude/(?!projects/[^/]*/memory/)',
  // `.claude.json` is not needed here — SECRET_FILE already covers it, including READS.
]);

/* --- Dangerous shell commands --------------------------------------------- */
const DANGEROUS_CMD = [
  [rx(['\\brm\\b', '\\brmdir\\b', '\\bshred\\b', '\\bwipefs\\b', '\\bunlink\\b',
       '\\bfind\\b[^|;&]*\\s-delete\\b',
       '\\brsync\\b[^|;&]*--delete']), 'delete files'],
  // find -exec / eval can run arbitrary commands the regex cannot see in advance.
  [rx(['\\bfind\\b[^|;&]*\\s-(?:exec|execdir|ok)\\b', '\\beval\\b']), 'run arbitrary commands'],
  [rx(['\\bmv\\b']), 'move / overwrite files'],
  [rx(['\\btruncate\\b', '\\bmkfs', '\\bfdisk\\b', '\\bparted\\b', '\\bmkswap\\b', '\\bdd\\b']),
    'overwrite a disk'],
  [rx(['\\bchmod\\b', '\\bchown\\b', '\\bchattr\\b', '\\bsetfacl\\b']), 'change file permissions'],
  [rx(['\\bsudo\\b', '\\bdoas\\b', '\\bpkexec\\b', '(?:^|[;&|]\\s*)su\\b']), 'run as root'],
  [rx(['\\bkillall\\b', '\\bpkill\\b', '(?:^|[;&|]\\s*)kill\\b']), 'kill processes'],
  [rx(['\\breboot\\b', '\\bshutdown\\b', '\\bpoweroff\\b', '\\bhalt\\b']), 'shut down / reboot the machine'],
  [rx(['\\bmount\\b', '\\bumount\\b']), 'mount / unmount a filesystem'],
  [rx(['\\bufw\\b', '\\biptables\\b', '\\bip6tables\\b', '\\bnft\\b']), 'change firewall rules'],
  [rx(['\\bcrontab\\b']), 'change cron schedules'],
  [rx(['\\buseradd\\b', '\\buserdel\\b', '\\busermod\\b', '\\bgroupadd\\b', '\\bvisudo\\b']),
    'change system accounts'],
  [rx(['systemctl(?:\\s+--user)?\\s+(?:stop|disable|mask|kill|revert|edit)']),
    'stop / disable a service'],
  [rx(['docker\\s+(?:compose\\s+)?(?:down|rm|rmi|kill|stop|prune)',
       'docker\\s+\\w+\\s+(?:rm|prune)', 'docker\\s+exec',
       'docker-compose\\s+(?:down|rm|stop)']), 'docker operation that can destroy data'],
  [rx(['\\bapt(?:-get)?\\s+(?:remove|purge|autoremove)', '\\bdpkg\\s+-r',
       '\\bsnap\\s+remove', '\\bpip3?\\s+uninstall', '\\bnpm\\s+(?:uninstall|rm|prune)']),
    'uninstall packages'],
  [rx(['\\bgit\\s+push', '\\bgit\\s+reset', '\\bgit\\s+clean', '\\bgit\\s+checkout',
       '\\bgit\\s+restore', '\\bgit\\s+rebase', '\\bgit\\s+filter-branch',
       '\\bgit\\s+branch\\s+-D', '\\bgit\\s+stash\\s+(?:drop|clear)']),
    'git operation that can lose or publish changes'],
  // LOCAL rsync (deploying to /var/www, copying to an external drive) is not
  // "to another machine" — only count user@host:, host::module or rsync:// targets.
  [rx(['\\bssh\\b', '\\bscp\\b', '\\bsftp\\b', '\\bnc\\b', '\\bncat\\b', '\\bsocat\\b',
       '\\btelnet\\b', '\\brsync\\b[^|;&]*(?:\\S+@\\S+:|\\S+::|rsync://)']),
    'connect to / push data to another machine'],
  [rx(['curl[^|;&]*(?:-d\\b|--data|-F\\b|--form|-T\\b|--upload-file|-X\\s*(?:POST|PUT|PATCH|DELETE))',
       'wget[^|;&]*--post', '(?:curl|wget)[^|]*\\|\\s*(?:sudo\\s+)?(?:ba)?sh']),
    'send data out / run a downloaded script'],
  [rx(['\\bprintenv\\b', '(?:^|[;&|]\\s*)env\\s*(?:$|\\||>)']), 'dump every environment variable'],
  [rx(['os\\.remove', 'os\\.unlink', 'shutil\\.rmtree', 'os\\.system', 'subprocess\\.',
       'fs\\.unlink', 'fs\\.rmSync', 'fs\\.rm\\b', 'child_process']),
    'script calls destructive commands'],
];

/* --- Read-only tools ------------------------------------------------------ */
const READ_ONLY = new Set([
  'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite', 'NotebookRead',
  'BashOutput', 'Task', 'Agent', 'ExitPlanMode', 'TaskList', 'TaskGet', 'TaskOutput',
  'ListMcpResourcesTool', 'ReadMcpResourceTool', 'Skill',
]);

/* --- File-writing tools: safe as long as they stay in the workspace -------- */
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/* --- Commands that change something: used for the turn recap, not to ask ---- */
const WRITES_IN_CMD = rx([
  '\\bmkdir\\b', '\\btouch\\b', '\\bcp\\b', '\\btar\\b', '\\bzip\\b', '\\bgzip\\b',
  '\\bgunzip\\b', '\\bunzip\\b', '\\bln\\b', '\\btee\\b', '\\bsed\\s+-i', '\\binstall\\b',
  '(?<![0-9&])>>?\\s*(?!&)',
  'systemctl(?:\\s+--user)?\\s+(?:start|restart|enable|daemon-reload|reload)',
  'docker\\s+(?:run|start|restart|build|create|load|import|tag|push|pull)',
  'docker\\s+compose\\s+(?:up|build|pull)', 'docker-compose\\s+(?:up|build)',
  '\\bapt(?:-get)?\\s+(?:install|upgrade|update)', '\\bnpm\\s+(?:i\\b|install|ci)',
  '\\bpip3?\\s+install', '\\bgit\\s+(?:add|commit|init|merge|pull|fetch|tag)',
  '\\bcurl\\b[^|;&]*-[oO]\\b', '\\bwget\\b',
]);

const ok = (why) => ({ ask: false, why });
const ask = (why) => ({ ask: true, why });

/* --- Deleting inside /tmp never asks --------------------------------------
 * `/tmp` is the junk drawer: throwaway scripts, temp logs, screenshots. Asking
 * for approval every time it is cleaned out is exactly the kind of prompt
 * fatigue that trains people to tap Approve without reading.
 * Only `rm`/`rmdir`/`unlink` are exempt, and only when EVERY target is in /tmp.
 * `shred`, `wipefs`, `find -delete` and `rsync --delete` are never exempt.
 */
const SCRATCH_TARGET = /^['"]?\/(?:tmp|var\/tmp)\/[^\s'"]*['"]?$/;

function deletesOnlyScratch(cmd) {
  if (/\bfind\b[^|;&]*\s-delete\b|\brsync\b[^|;&]*--delete|\bshred\b|\bwipefs\b/i.test(cmd)) return false;
  if (cmd.includes('..')) return false;           // e.g. /tmp/../home
  const segments = cmd.split(/;|&&|\|\||\||\n/);
  let sawDelete = false;
  for (const seg of segments) {
    const tokens = seg.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) continue;
    const cmdIdx = tokens.findIndex((t) => /^(?:rm|rmdir|unlink)$/i.test(t));
    if (cmdIdx < 0) continue;
    // Anything other than a timeout wrapper in front of `rm`? Stop guessing, ask.
    if (tokens.slice(0, cmdIdx).some((t) => !/^(?:timeout|\d+)$/i.test(t))) return false;
    sawDelete = true;
    const args = tokens.slice(cmdIdx + 1).filter((t) => !t.startsWith('-'));
    if (!args.length) return false;
    if (!args.every((a) => SCRATCH_TARGET.test(a))) return false;
  }
  return sawDelete;
}

/* --- Running a script file: open it and inspect the contents ---------------
 * Blindly blocking every `node x.mjs` would be annoying and pointless: `Write`
 * inside the workspace already runs without asking, and so does `node -e "..."`,
 * so anyone wanting to route around it can. Instead of blocking, open the file
 * and scan it with the same rules as above.
 * Unreadable / too large / calls another script -> ask.
 */
const SCRIPT_RUN = [
  /(?:^|[;&|]\s*)(?:sudo\s+)?(?:ba|z|k|d)?sh\s+(?!-)([^\s;&|>]+)/i,
  /(?:^|[;&|]\s*)(\.\/[^\s;&|>]+)/,
  /\b(?:python3?|node|perl|ruby)\s+(?!-)([^\s;&|>]+\.(?:py|[cm]?js|pl|rb))/i,
];
const MAX_SCRIPT_BYTES = 262144;

function inspectScript(p, cwd) {
  const raw = p.replace(/^['"]|['"]$/g, '');
  const abs = path.isAbsolute(raw) ? raw : path.resolve(cwd || '/', raw);
  const name = path.basename(abs);
  let body;
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) return null;                    // not a file -> ignore
    if (st.size > MAX_SCRIPT_BYTES) {
      return ask(`script ${name} too large to inspect (${Math.round(st.size / 1024)}KB)`);
    }
    body = fs.readFileSync(abs, 'utf8');
  } catch (e) {
    // File does not exist yet: either the command will fail on its own, or the
    // file is created by this very command (heredoc) — and that text was already
    // scanned above.
    if (e.code === 'ENOENT') return null;
    return ask(`cannot open ${raw} to inspect it`);
  }
  // SECRET_FILE only — SECRET_WORD would flag nearly every source file.
  if (SECRET_FILE.test(body)) return ask(`${name}: touches a secret file or key`);
  if (WRITE_TO_SYSTEM.test(body)) return ask(`${name}: write to a system directory`);
  for (const [re, why] of DANGEROUS_CMD) {
    if (!re.test(body)) continue;
    if (why === 'delete files' && deletesOnlyScratch(body)) continue;
    return ask(`${name}: ${why}`);
  }
  // Exactly one level deep. A script calling another script stops here and asks.
  for (const re of SCRIPT_RUN) if (re.test(body)) return ask(`${name}: calls another script`);
  return null;
}

function classify(tool, input, cwd) {
  const i = input || {};

  if (tool === 'Bash') {
    const cmd = String(i.command || '');
    if (SECRET.test(cmd)) return ask('touches a secret file or key');
    for (const [re, why] of DANGEROUS_CMD) {
      if (!re.test(cmd)) continue;
      if (why === 'delete files' && deletesOnlyScratch(cmd)) continue;
      return ask(why);
    }
    if (WRITE_TO_SYSTEM.test(cmd)) return ask('write to a system directory');
    if (HOME_SENSITIVE.test(cmd)) return ask('edit startup / cron configuration');
    for (const re of SCRIPT_RUN) {
      const m = cmd.match(re);
      if (!m) continue;
      const v = inspectScript(m[1], cwd);
      if (v) return v;
    }
    return ok('read-only / harmless command');
  }

  if (READ_ONLY.has(tool)) {
    const target = [i.file_path, i.path, i.pattern, i.glob, i.url, i.query]
      .filter(Boolean).join(' ');
    if (SECRET.test(target)) return ask('read sensitive content');
    return ok('read-only');
  }

  if (WRITE_TOOLS.has(tool)) {
    const p = String(i.file_path || i.notebook_path || i.path || '');
    if (SECRET.test(p)) return ask('overwrite a secret file or key');
    if (SYSTEM_PATH.test(p)) return ask('write to a system directory');
    if (HOME_SENSITIVE.test(p)) return ask('edit startup / cron configuration');
    return ok('edit a file inside the workspace');
  }

  return ask(`tool "${tool}" is not classified`);
}

/** Did this call change anything? Used for the end-of-turn recap. */
function mutates(tool, input) {
  const i = input || {};
  if (WRITE_TOOLS.has(tool)) return true;
  if (tool === 'Bash') {
    const cmd = String(i.command || '');
    if (WRITES_IN_CMD.test(cmd)) return true;
    for (const [re] of DANGEROUS_CMD) if (re.test(cmd)) return true;
    return false;
  }
  return classify(tool, input).ask;
}

module.exports = { classify, mutates };
