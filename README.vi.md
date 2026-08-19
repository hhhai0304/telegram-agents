# telegram-agents

Một bot Telegram, nhiều CLI coding agent. Nhắn cho bot, nó chạy
[Claude Code](https://claude.com/claude-code), [OpenCode](https://opencode.ai),
[Kilo CLI](https://kilo.ai) hoặc [Kiro CLI](https://kiro.dev) trên máy bạn, bắn tiến độ về, và —
với Claude Code — hỏi duyệt bằng nút bấm trước khi làm việc nguy hiểm. `/agent` để chuyển qua lại;
mỗi agent giữ phiên riêng.

**Không phụ thuộc npm package nào.** Chỉ dùng builtin của Node. Là bản kế nhiệm của
[claude-telegram](https://github.com/hhhai0304/claude-telegram), thay thế tại chỗ được.

🇬🇧 [English](README.md)

```
bạn (Telegram) ──▶ bot.js ──▶ backends/claude.js    ──▶ claude -p --output-format stream-json
                     │         backends/opencode.js  ──▶ opencode run --format json --auto
                     │         backends/kilo.js      ──▶ kilo run --format json --auto
                     │         backends/kiro.js      ──▶ kiro-cli chat --no-interactive --trust-all-tools
                     ▲
                  nút bấm ◀── approve-hook.js ──▶ risk.js      (chỉ Claude Code)
```

## Được gì

- **CLI thật**, không phải vỏ chat — tool thật, file thật, shell thật, trên máy bạn.
- **`/agent` để chuyển** giữa Claude Code, OpenCode, Kilo, Kiro theo từng chat. Mỗi agent giữ
  phiên, model, effort riêng, chuyển lại là chạy tiếp chỗ cũ. Agent chưa cài vẫn hiện, đánh dấu ✗,
  và từ chối chạy.
- **Phiên nối tiếp.** `/sessions` liệt kê phiên gần đây của agent hiện tại, bấm để chạy tiếp.
  Claude Code và OpenCode/Kilo resume theo id; Kiro resume cuộc trò chuyện gần nhất trong thư mục.
- **Lớp duyệt quyền làm cho điện thoại** — với Claude Code. `risk.js` phân loại từng tool call; việc
  nguy hiểm biến thành nút Cho phép / Từ chối ngay trong chat. Không bấm = **từ chối**.
- **Tiến độ trực tiếp.** Dòng trạng thái đếm giây, đếm tool, hiện tool đang chạy. Cuối mỗi lượt có
  bản tóm tắt đã đụng vào gì (file ghi, lệnh chạy), agent nào cũng có.
- **Chỉ chat id của bạn** ra lệnh được. Người lạ bị bỏ qua.
- **Test:** 71 ca cho bộ phân loại rủi ro, 23 ca cho adapter backend, và một lượt end-to-end với
  Telegram API giả + CLI giả. `npm test`.

## Các agent

| Agent | id `/agent` | Lệnh chạy bên dưới | Phiên | Nút duyệt | Model / effort |
|---|---|---|---|---|---|
| Claude Code | `claude` | `claude -p --output-format stream-json` | liệt kê + resume theo id | ✅ smart / ask / auto | nút bấm · low→max |
| OpenCode | `opencode` | `opencode run --format json --auto` | liệt kê + resume theo id | ✅ nếu cài plugin cổng duyệt | `/model provider/model` |
| Kilo CLI | `kilo` | `kilo run --format json --auto` | như OpenCode | ✅ nếu cài plugin cổng duyệt | nút chọn sẵn vài model, `/model <id bất kỳ>` cho phần còn lại |
| Kiro CLI | `kiro` | `kiro-cli chat --no-interactive --trust-all-tools` | mỗi thư mục một cuộc, `--resume` | ✗ luôn trust hết tool | `/model <tên>` |

Claude Code được xích bằng hook `PreToolUse`. Họ OpenCode không có hook đó, nhưng có plugin, và
`tool.execute.before` của plugin có quyền chặn một tool call — đó là việc của
`plugin/telegram-agents-guard.mjs`, dùng lại đúng `risk.js` và đúng mấy cái nút Telegram. Phải tự
bật: cài plugin cho từng CLI (xem [Mô hình quyền](#mô-hình-quyền)) thì agent chuyển từ *thả xích*
sang có xích; không cài thì chúng chạy `--auto` và danh sách `/agent` ghi rõ. Kiro không có cả hook
lẫn plugin nên luôn thả xích. `/effort` chỉ Claude Code mới có.

Danh sách phiên lấy theo kho của từng CLI: OpenCode ghi ra file JSON, còn Kilo 7.x cất phiên trong
SQLite và chỉ lộ ra qua `kilo session list --format json`; adapter thử file trước, hụt thì gọi CLI.

Kiro in chữ thường chứ không có event; bot lột màu và spinner, gửi câu trả lời khi lượt kết thúc,
đếm dòng `Using tool:` để dòng tiến độ vẫn nhúc nhích.

> Adapter OpenCode, Kilo, Kiro viết theo cờ headless trong tài liệu của họ và test bằng CLI giả,
> chưa chạy trên máy có đủ cả bốn. Nếu cái nào trục trặc trên máy bạn, `journalctl` có nguyên dòng
> lệnh và stderr — mở issue kèm cái đó.

## Cần gì

- Linux hoặc macOS, **Node >= 18** (có systemd thì tiện hơn)
- Ít nhất một CLI agent đã cài và đăng nhập:
  `npm i -g @anthropic-ai/claude-code` · `npm i -g opencode-ai` · `npm i -g @kilocode/cli` · Kiro từ kiro.dev
- Bot token lấy từ [@BotFather](https://t.me/BotFather)

## Cài

```bash
git clone https://github.com/hhhai0304/telegram-agents.git
cd telegram-agents
./install.sh
```

Trình cài hỏi bot token, rồi bảo bạn nhắn cho bot để **tự dò chat id**. Nó ghi `config.env`
(chmod 600), sinh unit systemd và khởi động.

- `./install.sh` — systemd **user** scope, không cần sudo. Thêm `sudo loginctl enable-linger $USER`
  để bot sống qua logout.
- `./install.sh --system` — `/etc/systemd/system`, khởi động cùng máy, cần sudo.
- `./install.sh --no-service` — chỉ ghi `config.env`; tự chạy `node bot.js`.

Rồi mở Telegram gửi `/help`.

**Đang dùng claude-telegram?** Dừng service đó trước (một token, một tiến trình poll), chép
`config.env` của nó sang — mọi biến `CLAUDE_TG_*` vẫn được đọc như dự phòng cho biến `TGA_*` tương
ứng — và cả `state.json` nếu muốn giữ phiên; nó tự chuyển đổi ở lần khởi động đầu. Cổng duyệt đổi
sang 18792 để hai bên chạy song song được trong lúc chuyển, nếu dùng hai bot khác nhau.

## Lệnh

| Lệnh | Làm gì |
|---|---|
| *(chữ bất kỳ)* | Gửi cho agent hiện tại làm prompt trong phiên hiện tại của nó |
| `/agent` | Hiện các agent kèm nút chuyển · `/agent <id>` chuyển thẳng |
| `/sessions` | Phiên gần đây của agent hiện tại trong thư mục hiện tại, bấm để resume |
| `/new` `/clear` | Bắt đầu phiên mới (cho agent hiện tại) |
| `/resume <id>` | Resume theo id |
| `/status` | Agent, phiên, thư mục, model, effort, chi phí |
| `/model` | Nút bấm (Claude Code) hoặc gõ `/model <tên>`; `/model -` để CLI tự chọn |
| `/effort` | low → max (Claude Code) |
| `/mode` | smart · ask · auto (Claude Code; xem dưới) |
| `/stream` | `batch` (gom 1 cục cuối lượt) hoặc `live` (gửi từng đoạn) |
| `/cd <đường dẫn>` · `/pwd` | Đổi / xem thư mục làm việc (reset phiên của mọi agent) |
| `/approvals` | Xem & thu hồi quyền "cả phiên" (Claude Code) |
| `/stop` | Dừng job đang chạy |

Đổi agent khi job còn xếp hàng không đổi hướng job đó: tin nhắn chạy bằng agent đang chọn **lúc
bạn gửi**.

## Mô hình quyền

Phần này nên đọc trước khi chĩa bot vào một cái máy bạn còn quý.

Claude Code chạy dưới hook `PreToolUse` (`approve-hook.js`). Mọi tool call đi qua `risk.js` để nó
quyết định: chạy thẳng, hay hỏi bạn. `TGA_MODE` chọn chính sách:

- **`smart`** (mặc định) — chỉ hỏi việc nguy hiểm: xoá/ghi đè file, `sudo`, đổi quyền, đọc khoá và
  file bí mật, docker/git phá dữ liệu, ghi vào `/etc`, gửi dữ liệu ra ngoài, tool lạ. Còn lại chạy thẳng.
- **`ask`** — hỏi duyệt từng tool, trừ những cái trong `TGA_AUTO_ALLOW`.
- **`auto`** — không hỏi gì, nhưng chỉ chạy được tool đọc và một danh sách lệnh shell vô hại.

`risk.js` còn **đọc nội dung script** trước khi cho chạy, nên `node deploy.mjs` bị xét theo những gì
nằm trong `deploy.mjs`, không phải theo chữ "node".

### Gắn xích cho OpenCode và Kilo

Plugin không tự cài — symlink nó vào thư mục config của chính CLI đó rồi restart bot:

```bash
mkdir -p ~/.config/kilo/plugin
ln -s ~/telegram-agents/plugin/telegram-agents-guard.mjs \
      ~/.config/kilo/plugin/telegram-agents-guard.js     # OpenCode thì ~/.config/opencode/plugin/
sudo systemctl restart telegram-agents
```

Backend kiểm tra file đó lúc khởi động rồi mới báo `guard`, nên cái `/agent` hiện ra đúng bằng cái
đang chạy — không có chuyện khoe "có xích" mà chẳng ai giữ. Plugin đọc đúng bộ biến `TGA_*` như hook
của Claude và cũng **fail closed** y hệt: đã bật xích thì thiếu URL duyệt, bot chết, hay hết giờ chờ
đều thành huỷ tool call. Với `TGA_GUARD=none` nó không gắn hook nào cả, nên bạn tự gõ `kilo` ở
terminal vẫn như thường.

CLI vẫn chạy kèm `--auto`, cố ý: cái đó trả lời **câu hỏi quyền của chính nó**, không có thì ở chế độ
không tương tác nó từ chối sạch. Cổng duyệt là plugin, không phải CLI. Nhớ giới hạn: chỉ tool call
được canh, còn CLI làm gì ngoài tool call thì không.

### Thả xích

Đặt `TGA_GUARD_MODE=none` trong `config.env` thì Claude chạy kèm `--dangerously-skip-permissions`
và hook allow tất, ở mọi mode. Không nút bấm, không phải chờ, nhanh hơn hẳn. Đổi lại: ai cầm được
bot token của bạn là có shell dưới tài khoản của bạn — khoá SSH, file, `sudo`, đủ cả. Đây là một cái
đánh đổi thật, không phải thủ tục. Ba agent còn lại **luôn** ở trạng thái này; xem [Các agent](#các-agent).

## Cấu hình

Tất cả nằm trong `config.env` cạnh `bot.js` (xem [`config.env.example`](config.env.example) có chú
thích đầy đủ). Không muốn để token trong thư mục repo thì đặt vào `~/.config/telegram_secrets`, bot
đọc file đó như nguồn thứ hai.

| Biến | Mặc định | Nghĩa |
|---|---|---|
| `TG_BOT_TOKEN` | — | Token bot từ @BotFather |
| `TGA_ALLOWED_CHAT_IDS` | — | Chat id được ra lệnh, cách nhau bằng dấu phẩy |
| `TGA_AGENTS` | tất cả | Agent nào hiện trong `/agent`: `claude,opencode,kilo,kiro` |
| `TGA_AGENT` | `claude` | Agent mặc định cho chat mới |
| `TGA_<AGENT>_BIN` | — | Đường dẫn file chạy, ví dụ `TGA_CLAUDE_BIN=/home/me/.local/bin/claude` |
| `TGA_<AGENT>_MODEL` | claude: `sonnet`, còn lại: trống | Model mặc định từng agent; trống = để CLI tự chọn |
| `TGA_FREE_MODELS` | trống | Id hoặc tiền tố được gắn 🆓 ở dòng đầu; id kết thúc `:free` khỏi cần khai |
| `TGA_CLAUDE_EFFORT` | `high` | Effort của Claude Code |
| `TGA_KIRO_AGENT` | — | Profile agent của Kiro (`kiro-cli chat --agent`) |
| `TGA_LANG` | `en` | Ngôn ngữ giao diện: `en` hoặc `vi` |
| `TGA_DEFAULT_CWD` | `$HOME` | Thư mục làm việc ban đầu |
| `TGA_MODE` | `smart` | Chính sách quyền của Claude Code (ở trên) |
| `TGA_STREAM` | `batch` | `batch` hoặc `live` |
| `TGA_GUARD_MODE` | `bymode` | `bymode` = giữ xích, `none` = thả xích (Claude Code) |
| `TGA_AUTO_ALLOW` | `Read,Glob,Grep,TodoWrite` | Tool tự duyệt ở mode `ask` |
| `TGA_APPROVE_TIMEOUT_SEC` | `300` | Quá hạn không bấm → từ chối |
| `TGA_APPROVE_PORT` | `18792` | Cổng duyệt nội bộ, chỉ bind 127.0.0.1 |
| `TGA_TIMEOUT_SEC` | `1800` | Giết job nếu chạy quá lâu |
| `TGA_DATA_DIR` | cạnh `bot.js` | Chỗ để `state.json` |

Sửa xong nhớ: `systemctl --user restart telegram-agents`.

## Thêm agent mới

Thả một file vào `backends/`, đăng ký trong `backends/index.js`. Interface chỉ chục dòng, mô tả ở
đầu `backends/index.js`; `backends/claude.js` là bản mẫu, `kiro.js` cho thấy CLI chỉ in chữ cũng
ghép vào được. `bot.js` không bao giờ đụng tới cờ CLI hay định dạng output. Thêm vài ca parser vào
`test-backends.js` và một binary giả trong `test/fakebin/` nếu muốn test end-to-end phủ luôn.

## Về an toàn

- **Bot token chính là mật khẩu vào máy bạn.** Telegram không có lớp thứ hai ở đây. `config.env` để
  chmod 600, và đừng bao giờ commit nó.
- **Danh sách chat id là cả cái cổng.** Tin nhắn chỉ nhận từ chat id có trong danh sách; với nút bấm
  thì cả user id của người bấm *lẫn* chat id đều phải có. Cho nên đưa id của một group vào đây là
  trao shell cho cả group — đừng, trừ khi bạn cố ý.
- **Ba trong bốn agent không có cổng duyệt nào cả.** Bật chúng lên là bot token thành shell mà
  không có cả cái phanh smart mode. `TGA_AGENTS=claude` để tắt hẳn.
- Cổng duyệt chỉ bind `127.0.0.1` và có token ngẫu nhiên sinh lại mỗi lần khởi động.
- Duyệt quyền **fail closed**: nút hết hạn sau `TGA_APPROVE_TIMEOUT_SEC` là tự từ chối.
- `risk.js` là heuristic, không phải sandbox. Nó làm cho sai lầm đắt hơn, chứ không làm nó bất khả.
  Cần ranh giới thật thì chạy trong VM hoặc container.

## Gặp lỗi

**Log báo `getUpdates conflict` / 409** — hai tiến trình cùng poll một token. Một token, một bot.
Kiểm tra có `node bot.js` chạy lạc, `claude-telegram` còn chạy, hoặc cài cả user scope lẫn system scope.

**"chưa cài ở đây (không thấy "opencode" trong PATH)"** — `PATH` của systemd không có chỗ cài CLI
đó. Trình cài nhúng `PATH` lúc đó vào unit; nếu bạn cài CLI sau, chạy lại `./install.sh`, hoặc đặt
`TGA_<AGENT>_BIN` bằng đường dẫn tuyệt đối.

**Logout là bot chết** — unit user scope tắt theo phiên đăng nhập. `sudo loginctl enable-linger $USER`.

**Nhắn mà không thấy gì** — chắc chat id chưa có trong `TGA_ALLOWED_CHAT_IDS`. Log sẽ ghi
`Blocked unknown chat <id>`.

**Log ở đâu** — `journalctl --user -u telegram-agents -f`, hoặc `sudo journalctl -u telegram-agents -f`
nếu cài system scope. Mỗi lượt log ghi agent, thư mục và id resume; dòng output CLI không parse được
thì log là `unparsed line`.

## Ngôn ngữ

Mọi câu bot nói nằm trong `strings/`, tra theo key chứ không viết thẳng trong code. Tiếng Anh
(`strings/en.js`) là mặc định và cũng là bản dự phòng; tiếng Việt (`strings/vi.js`) có sẵn. Chọn
bằng `TGA_LANG` trong `config.env` — **muốn bot nói tiếng Việt thì đặt `TGA_LANG=vi`.**

Thêm ngôn ngữ: chép `strings/en.js` thành `strings/<mã>.js`, dịch phần giá trị, rồi đặt
`TGA_LANG=<mã>`. Key nào bỏ sót thì tự lấy tiếng Anh, không vỡ gì cả. Lý do rủi ro từ `risk.js`
dịch qua bảng `reasons` trong cùng file đó.

MIT.
