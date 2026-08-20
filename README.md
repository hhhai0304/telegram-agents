# telegram-agents

One Telegram bot, several coding-agent CLIs. Message your bot and it runs
[Claude Code](https://claude.com/claude-code), [OpenCode](https://opencode.ai),
[Kilo CLI](https://kilo.ai) or [Kiro CLI](https://kiro.dev) on your machine, streams progress
back, and — for Claude Code — asks for permission with inline buttons before doing anything
dangerous. `/agent` switches between them; each keeps its own session.

**Zero npm dependencies.** Node builtins only. Successor of
[claude-telegram](https://github.com/hhhai0304/claude-telegram), which it can replace in place.

🇻🇳 [Tiếng Việt](README.vi.md)

```
you (Telegram) ──▶ bot.js ──▶ backends/claude.js    ──▶ claude -p --output-format stream-json
                     │         backends/opencode.js  ──▶ opencode run --format json --auto
                     │         backends/kilo.js      ──▶ kilo run --format json --auto
                     │         backends/kiro.js      ──▶ kiro-cli chat --no-interactive --trust-all-tools
                     ▲
                  buttons ◀── approve-hook.js ──▶ risk.js      (Claude Code only)
```

## What you get

- **The real CLIs**, not a chat wrapper — real tools, real files, real shell, on your box.
- **`/agent` to switch** between Claude Code, OpenCode, Kilo and Kiro per chat. Every agent keeps
  its own session, model and effort, so switching back resumes where you left off. Agents that
  aren't installed still show up, marked ✗, and refuse to run.
- **Sessions that persist.** `/sessions` lists recent ones for the current agent, tap to continue.
  Claude Code and OpenCode/Kilo resume by id; Kiro resumes the last conversation in the directory.
- **A permission layer built for a phone** — for Claude Code. `risk.js` classifies every tool call;
  risky ones turn into an Approve/Deny button in the chat. Approvals fail *closed*.
- **Live progress.** A status line ticks with elapsed time, tool count, and current tool. A recap
  of what was touched (files written, commands run) closes every turn, on every agent.
- **Only your chat ids** may talk to it. Everyone else is dropped.
- **Tests:** 71 on the risk classifier, 23 on the backend adapters, and an end-to-end run against a
  fake Telegram API with fake CLIs. `npm test`.

## Agents

| Agent | `/agent` id | Command it runs | Sessions | Approval buttons | Model / effort |
|---|---|---|---|---|---|
| Claude Code | `claude` | `claude -p --output-format stream-json` | list + resume by id | ✅ smart / ask / auto | buttons · low→max |
| OpenCode | `opencode` | `opencode run --format json --auto` | list + resume by id | ✅ with the guard plugin | `/model provider/model` |
| Kilo CLI | `kilo` | `kilo run --format json --auto` | same as OpenCode | ✅ with the guard plugin | buttons for a shortlist, `/model <any id>` for the rest |
| Kiro CLI | `kiro` | `kiro-cli chat --no-interactive --trust-all-tools` | one per directory, `--resume` | ✗ always trusts all tools | `/model <name>` |

Claude Code is gated through its `PreToolUse` hook. The OpenCode family has no such hook, but it
does have plugins, and a plugin's `tool.execute.before` can refuse a tool call — that is what
`plugin/telegram-agents-guard.mjs` does, reusing the same `risk.js` and the same Telegram buttons.
It is opt-in: install it per CLI (see [The permission model](#the-permission-model)) and the agent
switches from *off the leash* to guarded; without it these agents run `--auto` and the `/agent`
list says so. Kiro has neither hook nor plugin and is always unleashed. `/effort` is Claude-only.

Session lists come from whatever store the CLI uses: OpenCode writes JSON files, Kilo 7.x keeps
sessions in SQLite and only exposes them through `kilo session list --format json`; the adapter
tries the files first and falls back to the CLI.

Kiro prints plain text rather than events; the bot strips the colours and spinners and delivers
the answer when the turn ends, counting `Using tool:` lines for the progress ticker.

> The OpenCode, Kilo and Kiro adapters were written against their documented headless flags and
> tested against fakes, not against a machine with all four installed. If one of them misbehaves on
> your box, `journalctl` shows the exact command line and stderr — open an issue with that.

## Requirements

- Linux or macOS with **Node >= 18** (systemd optional but recommended)
- At least one agent CLI installed and logged in:
  `npm i -g @anthropic-ai/claude-code` · `npm i -g opencode-ai` · `npm i -g @kilocode/cli` · Kiro from kiro.dev
- A Telegram bot token from [@BotFather](https://t.me/BotFather)

## Install

```bash
git clone https://github.com/hhhai0304/telegram-agents.git
cd telegram-agents
./install.sh
```

The installer asks for your bot token, then tells you to message the bot and **detects your chat
id automatically**. It writes `config.env` (mode 600), generates a systemd unit, and starts it.

- `./install.sh` — systemd **user** scope, no sudo. Add `sudo loginctl enable-linger $USER` so it
  survives logout.
- `./install.sh --system` — `/etc/systemd/system`, starts at boot, needs sudo.
- `./install.sh --no-service` — just write `config.env`; run `node bot.js` yourself.

Then open Telegram and send `/help`.

**Coming from claude-telegram?** Stop that service first (one token, one poller), copy its
`config.env` over — every `CLAUDE_TG_*` variable is still read as a fallback for its `TGA_*` twin —
and its `state.json` if you want to keep sessions; it is migrated on first boot. The approval port
moved to 18792 so the two can coexist during the switch if you use different bots.

## Commands

| Command | What it does |
|---|---|
| *(any text)* | Sent to the current agent as a prompt in its current session |
| `/agent` | Show the agents with buttons to switch · `/agent <id>` switches directly |
| `/sessions` | Recent sessions of the current agent in the current directory, tap to resume |
| `/new` `/clear` | Start a fresh session (for the current agent) |
| `/resume <id>` | Resume a specific session id |
| `/status` | Agent, session, directory, model, effort, cost |
| `/model` | Buttons (Claude Code) or `/model <name>` free text; `/model -` lets the CLI pick |
| `/effort` | low → max (Claude Code) |
| `/mode` | smart · ask · auto (Claude Code; see below) |
| `/stream` | `batch` (one message at the end) or `live` (as it goes) |
| `/cd <path>` · `/pwd` | Change / show the working directory (resets every agent's session) |
| `/approvals` | View and revoke "allow for this session" grants (Claude Code) |
| `/topics` | List the topics of a forum group, with buttons to close, reopen or restore |
| `/close` · `/drop` | In a topic: archive it, or delete it. The session survives either way |
| `/rename <name>` | Rename the current topic |
| `/stop` | Kill the running job |

Switching agents while a job is queued does not reroute it: a message runs under the agent that
was selected when you sent it.

## Run several sessions at once

One chat = one conversation, so a second message waits for the first. Want two things running
side by side? Use a Telegram group with **Topics** on. **Each topic is its own session** — its own
folder, agent and memory — and topics run at the same time.

### Set it up once

1. **BotFather → `/setprivacy` → Disable.** Do this first, or the bot cannot read your messages in
   a group.
2. Make a **new group** and add your bot.
3. Group settings → turn **Topics** on.
4. Group settings → **Administrators** → add your bot → tick **Manage Topics** and **Delete Messages**.
5. Send any message in the group, then look at the bot's log for a line like
   `Blocked unknown chat -1001234567890`. That number is your group id — put it in `config.env`:

   ```
   TGA_ALLOWED_CHAT_IDS=<your private chat id>,<the group id>
   ```

Restart the bot. Done.

### Use it

**General** is the control room. Everything else is a session.

| In General | |
|---|---|
| `/new fix login` | opens a topic called "fix login" and starts a session there |
| `/topics` | lists every topic, with buttons |

| In a topic | |
|---|---|
| *(just type)* | talks to that session |
| *(a photo or file)* | fetched to disk and handed to the agent; the caption is your question |
| `/close` | done for now — stops what is running, keeps everything |
| `/drop` | delete the topic, **the session is still saved** |
| `/rename new name` | rename it |

Deleted a topic and want it back? `/topics` in General → **♻️ Restore**. A new topic opens and the
agent carries on where it left off.

A new topic copies General's folder, agent and model. Change anything inside the topic and only
that topic changes.

### Keep it yours

A group is a door: anyone in it can command the bot. Two things worth doing:

- Don't create an invite link, and turn off **Add Members** in the group permissions.
- Set `TGA_ALLOWED_USER_IDS` to your own id. Then even if someone does get in, the bot ignores
  them completely.

```
TGA_ALLOWED_USER_IDS=<your id>
```

Leave it empty and anyone in the group can use the bot.

## Sending files

Send a photo, a screenshot or a document and the bot fetches it to a temp file,
then hands the agent the path. The caption is your question; with no caption it
simply asks the agent to take a look. Send several photos at once and they
arrive as **one** message, not one turn per photo.

Editing a message you already sent counts as asking again.

Files land in `/tmp/telegram-agents-media` and are swept after a day. Telegram
caps a bot download at 20 MB — anything larger is refused with a message rather
than ignored.

## When a turn takes too long

A turn is killed after `TGA_TIMEOUT_SEC` (30 minutes by default) and says so,
along with anything it started — the agent runs in its own process group, so a
dev server or a daemon it launched goes with it rather than living on.

## The permission model

This is the part worth reading before you point it at a machine you care about.

Claude Code runs under a `PreToolUse` hook (`approve-hook.js`). Every tool call goes through
`risk.js`, which decides: run it, or ask you first. `TGA_MODE` picks the policy:

- **`smart`** (default) — only dangerous things ask: deleting or overwriting files, `sudo`,
  changing permissions, reading keys and secret files, destructive docker/git, writing to `/etc`,
  sending data off the box, unknown tools. Everything else just runs.
- **`ask`** — approve every tool call except those in `TGA_AUTO_ALLOW`.
- **`auto`** — never asks, but only read-only tools and a whitelist of harmless shell commands work.

`risk.js` also reads the *contents* of scripts before letting the agent execute them, so
`node deploy.mjs` is judged by what's inside `deploy.mjs`, not by the fact that it says "node".

### Gating OpenCode and Kilo

The plugin is not installed automatically — symlink it into the CLI's own config directory and
restart the bot:

```bash
mkdir -p ~/.config/kilo/plugin
ln -s ~/telegram-agents/plugin/telegram-agents-guard.mjs \
      ~/.config/kilo/plugin/telegram-agents-guard.js     # ~/.config/opencode/plugin/ for OpenCode
sudo systemctl restart telegram-agents
```

The backend looks for that file at startup and reports `guard` accordingly, so what `/agent` shows
is what actually runs — a backend never claims to be guarded with nothing enforcing it. The plugin
reads the same `TGA_*` variables as the Claude hook and fails closed the same way: once the guard
is on, a missing approval URL, an unreachable bot or a timeout all abort the tool call. With
`TGA_GUARD=none` it installs no hook at all, so running `kilo` yourself is unaffected.

The CLI still runs with `--auto`, on purpose: that answers *its own* permission prompts, which it
would otherwise reject outright in non-interactive mode. The gate is the plugin, not the CLI. Note
the scope — tool calls are covered, anything the CLI does outside a tool call is not.

### Off the leash

Setting `TGA_GUARD_MODE=none` in `config.env` runs Claude with `--dangerously-skip-permissions` and
makes the hook allow everything, in every mode. No buttons, nothing to tap, much faster. It also
means anyone who gets hold of your bot token gets a shell as your user: your SSH keys, your files,
your `sudo`. That is a real trade, not a formality — make it deliberately. The other three agents
are always in this state; see [Agents](#agents).

## Configuration

Everything lives in `config.env` next to `bot.js` (see
[`config.env.example`](config.env.example) for the annotated version). If you'd rather keep the
token out of the repo directory, `~/.config/telegram_secrets` is read as a second source.

| Variable | Default | Meaning |
|---|---|---|
| `TG_BOT_TOKEN` | — | Bot token from @BotFather |
| `TGA_ALLOWED_CHAT_IDS` | — | Comma-separated chat ids allowed to drive the bot |
| `TGA_ALLOWED_USER_IDS` | empty | Comma-separated user ids allowed to drive it; empty = anyone in those chats |
| `TGA_MAX_CONCURRENT` | `2` | Agents that may run at once; one topic still runs in order |
| `TGA_AGENTS` | all | Which agents `/agent` offers: `claude,opencode,kilo,kiro` |
| `TGA_AGENT` | `claude` | Agent a new chat starts with |
| `TGA_<AGENT>_BIN` | — | Executable override, e.g. `TGA_CLAUDE_BIN=/home/me/.local/bin/claude` |
| `TGA_<AGENT>_MODEL` | claude: `sonnet`, others: empty | Default model per agent; empty = CLI default |
| `TGA_FREE_MODELS` | empty | Ids or prefixes to label 🆓 in the turn header; `:free` ids need no entry |
| `TGA_CLAUDE_EFFORT` | `high` | Claude Code reasoning effort |
| `TGA_KIRO_AGENT` | — | Kiro agent profile (`kiro-cli chat --agent`) |
| `TGA_LANG` | `en` | UI language: `en` or `vi` |
| `TGA_DEFAULT_CWD` | `$HOME` | Starting working directory |
| `TGA_MODE` | `smart` | Claude Code permission policy (above) |
| `TGA_STREAM` | `batch` | `batch` or `live` |
| `TGA_GUARD_MODE` | `bymode` | `bymode` = enforce policy, `none` = off the leash (Claude Code) |
| `TGA_AUTO_ALLOW` | `Read,Glob,Grep,TodoWrite` | Auto-approved tools in `ask` mode |
| `TGA_APPROVE_TIMEOUT_SEC` | `300` | Unanswered approval → deny |
| `TGA_APPROVE_PORT` | `18792` | Internal approval endpoint, bound to 127.0.0.1 |
| `TGA_TIMEOUT_SEC` | `1800` | Hard kill for a single job |
| `TGA_DATA_DIR` | next to `bot.js` | Where `state.json` lives |

Restart after editing: `systemctl --user restart telegram-agents`.

## Adding an agent

Drop a file in `backends/`, register it in `backends/index.js`. The interface is a dozen lines and
documented at the top of `backends/index.js`; `backends/claude.js` is the reference, `kiro.js`
shows how a text-only CLI fits. `bot.js` never touches CLI flags or output formats. Add a couple of
parser cases to `test-backends.js` and a fake binary under `test/fakebin/` if you want the
end-to-end test to cover it.

## Security notes

- **The bot token is a password to your machine.** Telegram has no second factor here. `config.env`
  is chmod 600; keep it that way, and never commit it.
- **Chat-id allowlisting is the whole gate.** Messages are accepted only from listed chat ids; for
  button presses, both the presser's user id *and* the chat id must be listed. Listing a group chat
  id therefore hands the group a shell — don't, unless that is exactly what you mean.
- **Three of the four agents have no approval gate at all.** With them enabled, the bot token is a
  shell without even the smart-mode speed bump. `TGA_AGENTS=claude` turns them off entirely.
- The approval endpoint binds `127.0.0.1` only and is guarded by a random per-boot token.
- Approvals **fail closed**: the buttons expire after `TGA_APPROVE_TIMEOUT_SEC` and deny.
- `risk.js` is a heuristic, not a sandbox. It raises the cost of a mistake; it does not make one
  impossible. If you need a real boundary, run this in a VM or container.

## Troubleshooting

**`getUpdates conflict` / 409 in the logs** — two processes are polling the same bot token. One
token, one running bot. Check for a stray `node bot.js`, a still-running `claude-telegram`, or both
a user-scope and system-scope unit.

**"not installed here (no "opencode" on PATH)"** — systemd's `PATH` doesn't include that CLI's
prefix. The installer bakes your current `PATH` into the unit; if you installed a CLI afterwards,
run `./install.sh` again, or set `TGA_<AGENT>_BIN` to the absolute path.

**The bot dies when I log out** — user-scope units stop with your session. `sudo loginctl enable-linger $USER`.

**Nothing happens when I message it** — your chat id probably isn't in `TGA_ALLOWED_CHAT_IDS`.
The logs say `Blocked unknown chat <id>` with the id it saw.

**Where are the logs** — `journalctl --user -u telegram-agents -f`, or `sudo journalctl -u telegram-agents -f`
for system scope. Every turn logs the agent, the working directory and the resume id; unparsed CLI
output lines are logged as `unparsed line`.

## Languages

Every string the bot sends lives in `strings/`, keyed rather than inlined. English (`strings/en.js`)
is the default and the fallback; Vietnamese (`strings/vi.js`) ships with it. Pick one with
`TGA_LANG` in `config.env`.

To add a language: copy `strings/en.js` to `strings/<code>.js`, translate the values, set
`TGA_LANG=<code>`. Keys you skip keep their English text instead of breaking, so a partial
translation is a perfectly good first PR. Risk reasons from `risk.js` are translated through the
`reasons` map in the same file.

MIT.
