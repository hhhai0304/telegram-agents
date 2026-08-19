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
| OpenCode | `opencode` | `opencode run --format json --auto` | list + resume by id (best-effort scan of `~/.local/share/opencode`) | ✗ always `--auto` | `/model provider/model` |
| Kilo CLI | `kilo` | `kilo run --format json --auto` | same as OpenCode | ✗ always `--auto` | `/model provider/model` |
| Kiro CLI | `kiro` | `kiro-cli chat --no-interactive --trust-all-tools` | one per directory, `--resume` | ✗ always trusts all tools | `/model <name>` |

Only Claude Code exposes a hook the bot can put a gate on. OpenCode, Kilo and Kiro reject every
permission prompt in non-interactive mode unless told to auto-approve, so that is how they run —
treat them as *off the leash* by design. `/mode`, `/approvals` and `/effort` only apply to Claude
Code and say so.

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
| `/stop` | Kill the running job |

Switching agents while a job is queued does not reroute it: a message runs under the agent that
was selected when you sent it.

## The permission model (Claude Code)

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
| `TGA_AGENTS` | all | Which agents `/agent` offers: `claude,opencode,kilo,kiro` |
| `TGA_AGENT` | `claude` | Agent a new chat starts with |
| `TGA_<AGENT>_BIN` | — | Executable override, e.g. `TGA_CLAUDE_BIN=/home/me/.local/bin/claude` |
| `TGA_<AGENT>_MODEL` | claude: `sonnet`, others: empty | Default model per agent; empty = CLI default |
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
