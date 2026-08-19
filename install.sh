#!/usr/bin/env bash
# telegram-agents installer.
#   ./install.sh              -> install into the systemd user scope (no sudo)
#   ./install.sh --system     -> install into /etc/systemd/system (needs sudo)
#   ./install.sh --no-service -> only write config.env, leave systemd alone
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCOPE=user
DO_SERVICE=1
for a in "$@"; do
  case "$a" in
    --system) SCOPE=system ;;
    --user) SCOPE=user ;;
    --no-service) DO_SERVICE=0 ;;
    -h|--help) sed -n '2,5p' "$0"; exit 0 ;;
    *) echo "Unknown argument: $a"; exit 1 ;;
  esac
done

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m  %s\n' "$*"; }
die()  { printf '\033[1;31mXX\033[0m  %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- checks ---

command -v node >/dev/null || die "node not found. Node >= 18 required: https://nodejs.org"
NODE="$(command -v node)"
NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "Node $($NODE -v) is too old, need >= 18."
command -v curl >/dev/null || die "curl not found."
say "Node $($NODE -v) at $NODE"

FOUND=0
for pair in "claude:Claude Code" "opencode:OpenCode" "kilo:Kilo CLI" "kiro-cli:Kiro CLI"; do
  bin="${pair%%:*}"; label="${pair#*:}"
  if command -v "$bin" >/dev/null; then say "$label: $(command -v "$bin")"; FOUND=1; fi
done
if [ "$FOUND" -eq 0 ]; then
  warn "No agent CLI found on PATH (claude / opencode / kilo / kiro-cli)."
  warn "Install and log in to at least one, or every turn will fail. For example:"
  warn "  npm install -g @anthropic-ai/claude-code   then run 'claude' once to log in."
fi

# ------------------------------------------------------------ config.env ---

CONF="$DIR/config.env"
if [ ! -f "$CONF" ]; then
  cp "$DIR/config.env.example" "$CONF"
  say "Created config.env from the example."
fi
chmod 600 "$CONF"

getconf_val() { sed -n "s/^$1=//p" "$CONF" | tail -1; }
setconf_val() {
  local k="$1" v="$2"
  if grep -q "^$k=" "$CONF"; then
    local tmp; tmp="$(mktemp)"
    awk -v k="$k" -v v="$v" 'BEGIN{FS=OFS="="} $1==k {print k "=" v; next} {print}' "$CONF" > "$tmp"
    cat "$tmp" > "$CONF"; rm -f "$tmp"
  else
    printf '%s=%s\n' "$k" "$v" >> "$CONF"
  fi
}

TOKEN="$(getconf_val TG_BOT_TOKEN)"
if [ -z "$TOKEN" ] && [ -f "$HOME/.config/telegram_secrets" ]; then
  TOKEN="$(sed -n 's/^TG_BOT_TOKEN=//p' "$HOME/.config/telegram_secrets" | tail -1 | tr -d '\047"')"
  [ -n "$TOKEN" ] && say "Using TG_BOT_TOKEN from ~/.config/telegram_secrets."
fi

if [ -z "$TOKEN" ]; then
  if [ -t 0 ]; then
    echo
    echo "No bot token yet. Open Telegram, talk to @BotFather, send /newbot,"
    echo "then paste the token it gives you (looks like 123456789:AA...)."
    read -r -p "TG_BOT_TOKEN: " TOKEN
    [ -n "$TOKEN" ] || die "Without a token there is nothing to run."
    setconf_val TG_BOT_TOKEN "$TOKEN"
  else
    die "TG_BOT_TOKEN missing from config.env (run ./install.sh in a terminal to enter it)."
  fi
fi

BOTNAME="$(curl -sf "https://api.telegram.org/bot$TOKEN/getMe" \
  | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(j.ok?j.result.username:"")}catch(_){}})' || true)"
[ -n "$BOTNAME" ] || die "Telegram rejected that token. Check it and try again."
say "Bot: @$BOTNAME"

# ----------------------------------------------------------- chat id ---

CHATIDS="$(getconf_val TGA_ALLOWED_CHAT_IDS)"
if [ -z "$CHATIDS" ]; then
  if [ -t 0 ]; then
    echo
    echo "Now open Telegram and send anything at all to @$BOTNAME (e.g. hi)."
    read -r -p "Press Enter once you have (or type your chat id if you know it): " MANUAL
    if [ -n "$MANUAL" ]; then
      CHATIDS="$MANUAL"
    else
      say "Looking..."
      CHATIDS="$(curl -sf "https://api.telegram.org/bot$TOKEN/getUpdates?limit=20&timeout=25" \
        | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{
            const j=JSON.parse(s), ids=new Set();
            for(const u of (j.result||[])){const m=u.message||u.edited_message;if(m&&m.chat)ids.add(String(m.chat.id));}
            process.stdout.write([...ids].join(","));
          }catch(_){}})' || true)"
      [ -n "$CHATIDS" ] || die "No messages found. Message @$BOTNAME, then run ./install.sh again."
      say "Found chat id: $CHATIDS"
    fi
    setconf_val TGA_ALLOWED_CHAT_IDS "$CHATIDS"
  else
    die "TGA_ALLOWED_CHAT_IDS missing from config.env."
  fi
fi
say "Only these chat ids may drive the bot: $CHATIDS"

GUARD="$(getconf_val TGA_GUARD_MODE)"
[ "$GUARD" = "none" ] && warn "TGA_GUARD_MODE=none — the bot will NEVER ask. On your head."

# ----------------------------------------------------------------- service ---

if [ "$DO_SERVICE" -eq 0 ]; then
  say "Config done. Try it with: node $DIR/bot.js"
  exit 0
fi

if ! command -v systemctl >/dev/null; then
  warn "No systemd here. Keep it running however you prefer:"
  warn "  node $DIR/bot.js"
  exit 0
fi

UNIT="$(sed -e "s|__USER__|$USER|g" -e "s|__DIR__|$DIR|g" -e "s|__HOME__|$HOME|g" \
            -e "s|__NODE__|$NODE|g" -e "s|__PATH__|$PATH|g" \
            "$DIR/systemd/telegram-agents.service.template")"

if [ "$SCOPE" = user ]; then
  UNIT="$(printf '%s\n' "$UNIT" | sed -e '/^User=/d' -e '/^Group=/d' -e "s|__WANTEDBY__|default.target|")"
  mkdir -p "$HOME/.config/systemd/user"
  printf '%s\n' "$UNIT" > "$HOME/.config/systemd/user/telegram-agents.service"
  systemctl --user daemon-reload
  systemctl --user enable --now telegram-agents.service
  say "Installed (user scope). Logs: journalctl --user -u telegram-agents -f"
  if command -v loginctl >/dev/null && [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || echo no)" != "yes" ]; then
    warn "The bot will stop when you log out. To keep it running:"
    warn "  sudo loginctl enable-linger $USER"
  fi
  sleep 2; systemctl --user --no-pager status telegram-agents.service | head -12 || true
else
  UNIT="$(printf '%s\n' "$UNIT" | sed -e "s|__WANTEDBY__|multi-user.target|")"
  printf '%s\n' "$UNIT" | sudo tee /etc/systemd/system/telegram-agents.service >/dev/null
  sudo systemctl daemon-reload
  sudo systemctl enable --now telegram-agents.service
  say "Installed (system scope). Logs: sudo journalctl -u telegram-agents -f"
  sleep 2; sudo systemctl --no-pager status telegram-agents.service | head -12 || true
fi

echo
say "Done. Open Telegram and send /help to @$BOTNAME."
