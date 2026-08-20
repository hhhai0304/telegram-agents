'use strict';
/*
 * Vietnamese UI strings. Merged over strings/en.js, so any key left out here
 * falls back to English. Select with TGA_LANG=vi in config.env.
 */

module.exports = {
  lang: 'vi',

  approvalTitle: '🔐 Xin quyền',
  approvalTool: (tool) => `Tool: ${tool}`,
  approvalWhy: (why) => `⚠️ ${why}`,
  approvalIntent: (desc) => `Ý định: ${desc}`,
  approvalDeadline: (secs) => `Không trả lời trong ${secs}s → tự động từ chối.`,
  btnAllow: '✅ Cho phép',
  btnAllowSession: (sig) => `♾ Cho phép mọi "${sig}" phiên này`,
  btnDeny: '❌ Từ chối',
  approvalTimedOut: (tool, detail) => `⌛ Hết giờ chờ — đã từ chối.\n\nTool: ${tool}\n${detail}`,
  grantsNone: 'Chưa cấp quyền "cả phiên" nào.',
  grantsList: (sigs) => `♾ Quyền đang có hiệu lực cho phiên này:\n\n${sigs.map((s) => `• ${s}`).join('\n')}`,
  btnRevokeAll: '🗑 Thu hồi tất cả',
  revokedAll: '🗑 Đã thu hồi toàn bộ quyền "cả phiên".',
  noteAllowed: '✅ Đã cho phép',
  noteAllowedSession: (sig) => `♾ Đã cho phép, và mọi "${sig}" phiên này sẽ không hỏi lại`,
  noteDenied: '❌ Đã từ chối',

  costFree: '🆓 free',
  costPaid: '💰 tính phí',
  tagResumed: (id) => `↩️ tiếp ${id}`,
  tagNew: '🆕 phiên mới',
  working: (tag) => `⏳ ${tag}`,
  progress: (tag, secs, tools, tool) =>
    `⏳ ${tag} · ${secs}s · ${tools} tool` + (tool ? `\n🔧 ${tool}` : ''),
  sessionEnded: (icon, id) => `${icon} phiên ${id}`,
  sessionUnknown: '(không rõ phiên)',
  footerDone: (secs, tools, tag) => `✅ ${secs}s · ${tools} tool · ${tag}`,
  footerTimedOut: (mins, tag) =>
    `⌛ Dừng sau ${mins} phút — chạm giới hạn thời gian. Mọi thứ nó khởi động cũng bị tắt theo.\n${tag}`,
  footerStopped: (secs, tools, tag) => `🛑 đã dừng · ${secs}s · ${tools} tool · ${tag}`,
  footerFailed: (secs, tag) => `⚠️ kết thúc bất thường · ${secs}s · ${tag}`,
  footerDenied: (names) => `\n🚫 bị từ chối: ${names}`,
  auditHeader: (lines) => `\n\n🔧 Đã đụng vào:\n${lines}`,
  auditMore: (n) => `• … và ${n} việc nữa`,
  noOutput: '(không có nội dung trả về)',
  unknownContent: '(không rõ nội dung)',
  internalError: (msg) => `❌ Lỗi nội bộ: ${msg}`,
  queued: (n) => `⏸ Đang bận, đã xếp hàng (#${n}).`,
  stopping: '🛑 Đang dừng…',
  queueCleared: '🛑 Đã xoá hàng đợi.',
  nothingRunning: 'Không có gì đang chạy.',

  agoSeconds: (n) => `${n}s trước`,
  agoMinutes: (n) => `${n} phút trước`,
  agoHours: (n) => `${n} giờ trước`,
  agoDays: (n) => `${n} ngày trước`,

  noSessions: (cwd, agent) => `Chưa có phiên ${agent} nào trong ${cwd}.`,
  sessionsHeader: (cwd, agent) => `📋 Phiên ${agent} trong ${cwd}:`,
  sessionsUnsupported: (agent, resuming) =>
    `${agent} không liệt kê được phiên. Nó giữ 1 cuộc trò chuyện cho mỗi thư mục: ` +
    (resuming ? 'tin nhắn tiếp theo sẽ nối tiếp; /new để làm lại từ đầu.' : 'tin nhắn tiếp theo sẽ bắt đầu cuộc mới.'),
  sessionCurrent: ' ← đang dùng',
  btnNewSession: '🆕 Phiên mới',
  newSession: '🆕 Phiên mới. Quyền "cả phiên" đã xoá.',
  newSessionShort: '🆕 Phiên mới.',
  sessionNotFound: (arg, cwd) => `❌ Không tìm thấy phiên "${arg}" trong ${cwd}.`,
  resumedInto: (id) => `↩️ Đang dùng phiên ${id}…\nNhắn tiếp là chạy trong phiên này.`,
  ackNewSession: 'Phiên mới',
  ackResumed: 'Đã resume',
  ackRevoked: 'Đã thu hồi',
  ackExpired: 'Yêu cầu này hết hiệu lực rồi.',
  ackNotAllowed: 'Không có quyền.',

  cdUsage: 'Cú pháp: /cd <đường dẫn>',
  notADirectory: (p) => `❌ Không phải thư mục: ${p}`,
  cdDone: (p) => `📁 ${p}\n(phiên reset vì đổi thư mục — /sessions để xem phiên cũ ở đây)`,
  missingDirectory: (p) => `❌ Thư mục không tồn tại: ${p}\nDùng /cd để đổi.`,

  modelCurrent: (m, agent) => `🤖 ${agent} · model hiện tại: ${m}`,
  modelFreeText: 'Đặt bằng /model <tên> (đúng id CLI chấp nhận, ví dụ provider/model). /model - để xoá, cho CLI tự chọn.',
  effortUnsupported: (agent) => `${agent} không có tuỳ chọn effort.`,
  effortCurrent: (e) => `🎚 Effort hiện tại: ${e}\n(cao hơn = suy nghĩ kỹ hơn, tốn token và lâu hơn)`,
  unleashedNotice:
    '🔓 ĐANG THẢ XÍCH — cả 3 mode đều chạy thẳng, không hỏi gì.\n' +
    'Xích lại: TGA_GUARD_MODE=bymode trong config.env rồi restart service.\n\n',
  agentNoGuard: (agent) =>
    `🔓 ${agent} không có hook duyệt tool: nó luôn chạy ở chế độ tự duyệt của riêng nó, ` +
    `nên mode bên dưới chỉ có tác dụng khi agent là Claude Code.\n\n`,
  modeCurrent: (mode, autoAllow) =>
    `🔐 Chế độ hiện tại: ${mode}\n\n` +
    `smart — chỉ hỏi việc nguy hiểm: xoá/ghi đè file, sudo, đọc khoá\n` +
    `        và file bí mật, docker/git phá dữ liệu, đụng /etc, gửi\n` +
    `        dữ liệu ra ngoài. Còn lại chạy thẳng, cuối lượt liệt kê lại.\n` +
    `ask   — hỏi duyệt từng tool (trừ ${autoAllow})\n` +
    `auto  — không hỏi, chỉ cho tool đọc + lệnh bash vô hại`,
  ackUnknownModel: 'Model lạ',
  ackUnknownAgent: 'Agent lạ',
  ackAgentNotInstalled: (agent) => `${agent} chưa cài trên máy này.`,
  ackUnknownEffort: 'Effort lạ',
  ackUnknownMode: 'Chế độ lạ',
  ackUnknownStream: 'Kiểu gửi lạ',
  ackMode: (m) => `Chế độ: ${m}`,
  ackStream: (s) => `Kiểu gửi: ${s}`,
  modeExplain: {
    smart: '🛡 smart — chỉ hỏi việc nguy hiểm, còn lại chạy thẳng.',
    ask: '🔐 ask — sẽ hỏi duyệt từng tool trước khi chạy.',
    auto: '🔓 auto — không hỏi, nhưng chỉ chạy được tool đọc + lệnh bash vô hại.',
  },
  streamCurrent: (s) =>
    `📨 Kiểu gửi hiện tại: ${s}\n\n` +
    `batch — gom hết lời agent, gửi 1 lần khi xong việc (hoặc khi cần bấm duyệt)\n` +
    `live  — gửi ngay từng đoạn, thấy nó nghĩ tới đâu`,
  streamExplain: {
    batch: '📨 batch — gom lại, chỉ báo 1 lần khi xong hoặc khi cần bấm duyệt.',
    live: '📨 live — gửi ngay từng đoạn.',
  },

  agentCurrent: (agent) => `🧠 Agent hiện tại: ${agent}`,
  agentLine: ({ name, installed, session, model, guard }) =>
    `• ${name}${installed ? '' : ' ✗ chưa cài'} — model ${model}` +
    (session ? ` · phiên ${session}` : '') + (guard ? '' : ' · 🔓 không có hook duyệt'),
  agentHint: 'Bấm để chuyển, hoặc /agent <id>. Mỗi agent giữ phiên, model, effort riêng.',
  agentSwitched: (line) => `🧠 Đã chuyển.\n${line}`,
  agentUnknown: (arg, ids) => `❌ Không có agent "${arg}". Có: ${ids.join(', ')}`,
  agentNotInstalled: (agent, bin) => `❌ ${agent} chưa cài ở đây (không thấy "${bin}" trong PATH). Chọn agent khác bằng /agent.`,
  agentDefault: '(mặc định của CLI)',

  status: ({ agent, cwd, session, model, effort, guard, mode, stream, grants, turns, cost, active, queued }) => [
    `🧠 ${agent}`,
    `📁 ${cwd}`,
    `🔑 phiên: ${session}`,
    `🤖 ${model} · 🎚 ${effort} · ${guard === 'none' ? '🔓 thả xích' : `🔐 ${mode}`} · 📨 ${stream}`,
    `♾ quyền cả phiên: ${grants}`,
    `💬 lượt: ${turns} · 💵 ~$${cost}`,
    `⚙️ đang chạy: ${active} · hàng đợi: ${queued}`,
  ].join('\n'),
  statusNewSession: '(mới)',

  // --- tệp đính kèm --------------------------------------------------------
  mediaLine: (kind, name, p) => `[${kind}: ${name}]\n${p}`,
  mediaNoCaption: (n) => n === 1
    ? 'Xem giúp mình tệp đính kèm.'
    : `Xem giúp mình ${n} tệp đính kèm.`,
  mediaSaved: (n) => n === 1 ? '📎 Đã lưu 1 tệp đính kèm.' : `📎 Đã lưu ${n} tệp đính kèm.`,
  mediaFailed: (kind, why) => `⚠️ Không tải được ${kind}: ${why}`,
  // --- topic trong forum ---------------------------------------------------
  topicWelcome: (name, cwd, agent, model) =>
    `🧵 ${name}\n📁 ${cwd}\n🧠 ${agent}${model ? ` · ${model}` : ''}\n\nThiết lập lấy từ General; đổi ở đây thì topic này đi đường riêng.\nNhắn gì đó để bắt đầu. /close để lưu trữ topic, /drop để xoá hẳn.`,
  topicDefaultName: (stamp) => `phiên ${stamp}`,
  topicOpened: (name) => `🧵 Đã mở "${name}".`,
  topicFailed: (msg) => `⚠️ Telegram từ chối: ${msg}\n\nBot phải là admin có quyền "Quản lý chủ đề" (và "Xoá tin nhắn" cho /drop).`,
  topicsNotForum: 'Chat này chưa phải forum. Bật Chủ đề (Topics) trong cài đặt nhóm, rồi cho bot làm admin với quyền "Quản lý chủ đề".',
  topicOnlyInTopic: 'Lệnh này chỉ chạy trong một topic, không chạy ở General.',
  topicsNone: 'Chưa có topic nào. /new để mở một cái.',
  topicsHeader: (total) => `🧵 Các topic (${total})`,
  topicsTruncated: (hidden, shown) => `… còn ${hidden} cái nữa không hiện (chỉ vừa ${shown} cái mới nhất).`,
  topicLine: ({ icon, name, agent, session, cwd, when, live }) =>
    `${icon} ${name}${live ? ' ⏳' : ''} · ${agent} · ${session}\n   ${cwd} · ${when}`,
  topicsHint: 'Topic đóng vẫn giữ lịch sử. Topic xoá vẫn giữ phiên — khôi phục sẽ mở topic mới và chạy tiếp phiên cũ.',
  topicClosing: '🔒 Đang đóng topic này. Phiên vẫn được giữ — khôi phục từ General.',
  topicDropping: '🗑 Đang xoá topic…',
  topicDropped: (name) => `🗑 Đã xoá "${name}". Phiên vẫn còn — gõ /topics ở đây để khôi phục.`,
  topicRenameUsage: 'Cách dùng: /rename <tên mới>',
  topicRenamed: (name) => `✏️ Đã đổi tên thành "${name}".`,
  topicRestored: (name, cwd, agent, session) =>
    `♻️ Đã khôi phục "${name}"\n📁 ${cwd}\n🧠 ${agent}\n🔑 phiên: ${session}\n\nLàm tiếp từ chỗ đang dở.`,
  btnTopicClose: (name) => `🔒 Đóng ${name}`.slice(0, 60),
  btnTopicReopen: (name) => `🔓 Mở lại ${name}`.slice(0, 60),
  btnTopicRestore: (name) => `♻️ Khôi phục ${name}`.slice(0, 60),
  btnTopicForget: '🗑 Quên hẳn',
  ackTopicGone: 'Topic này không còn trong sổ đăng ký.',
  ackTopicClosed: 'Đã đóng.',
  ackTopicReopened: 'Đã mở lại.',
  ackTopicRestored: 'Đã khôi phục.',
  ackTopicForgotten: 'Đã quên.',

  menuCommands: [
    ['agent', 'Chuyển agent'],
    ['model', 'Xem hoặc đặt model cho agent hiện tại'],
    ['effort', 'Mức suy nghĩ: low → max (Claude Code)'],
    ['mode', 'Chế độ duyệt: smart / ask / auto'],
    ['stream', 'Trả lời: batch (gom 1 cục) hoặc live'],
    ['sessions', 'Phiên gần đây, bấm để resume'],
    ['resume', 'Resume phiên theo id'],
    ['new', 'Phiên mới — trong forum là topic mới'],
    ['topics', 'Danh sách topic: đóng, mở lại, khôi phục'],
    ['close', 'Lưu trữ topic này, vẫn giữ phiên'],
    ['drop', 'Xoá topic này, vẫn giữ phiên'],
    ['rename', 'Đổi tên topic này'],
    ['status', 'Phiên, thư mục, model, effort, chi phí'],
    ['pwd', 'Xem thư mục đang làm việc'],
    ['cd', 'Đổi thư mục làm việc'],
    ['approvals', 'Xem & thu hồi quyền "cả phiên"'],
    ['stop', 'Dừng job đang chạy'],
    ['help', 'Xem các lệnh có sẵn'],
  ],

  help: (unleashed, agents) => [
    'Coding agent qua Telegram — nhắn thẳng là agent hiện tại chạy.',
    '',
    '🧠 Agent',
    `/agent — chuyển giữa ${agents.join(' / ')}`,
    '',
    '📋 Phiên',
    '/sessions — danh sách phiên gần đây, bấm để resume',
    '/new (= /clear) — bắt đầu phiên mới',
    '',
    '🧵 Topic (nhóm supergroup đã bật Chủ đề)',
    '/new [tên] — ở General: mở một topic, tức một phiên chạy song song với các phiên khác',
    '/topics — liệt kê, kèm nút đóng / mở lại / khôi phục',
    '/close — lưu trữ topic này · /drop — xoá hẳn · /rename <tên>',
    'Topic bị xoá vẫn giữ phiên: khôi phục sẽ mở topic mới và chạy tiếp phiên đó.',
    '/resume <id> — resume theo id',
    '/status — phiên, thư mục, model, effort, chi phí',
    '',
    '⚙️ Cấu hình',
    '/model — chọn hoặc gõ model cho agent hiện tại',
    '/effort — low → max (Claude Code)',
    '/mode — smart · ask · auto (chỉ Claude Code' + (unleashed ? '; đang THẢ XÍCH: cả 3 đều không hỏi)' : ')'),
    '/stream — batch (gom 1 cục, mặc định) hoặc live (gửi từng đoạn)',
    '/cd <đường dẫn> — đổi thư mục · /pwd — xem',
    '',
    '🔐 Quyền',
    '/approvals — xem & thu hồi quyền "cả phiên" (Claude Code)',
    '/stop — dừng job đang chạy',
  ].join('\n'),

  // Risk reasons emitted by risk.js, keyed by their English text.
  reasons: {
    'delete files': 'xoá file',
    'run arbitrary commands': 'chạy lệnh tuỳ ý',
    'move / overwrite files': 'di chuyển / ghi đè file',
    'overwrite a disk': 'ghi đè ổ đĩa',
    'change file permissions': 'đổi quyền file',
    'run as root': 'chạy quyền root',
    'kill processes': 'giết tiến trình',
    'shut down / reboot the machine': 'tắt / khởi động lại máy',
    'mount / unmount a filesystem': 'gắn / tháo ổ đĩa',
    'change firewall rules': 'đổi tường lửa',
    'change cron schedules': 'đổi lịch cron',
    'change system accounts': 'đổi tài khoản hệ thống',
    'stop / disable a service': 'tắt / vô hiệu hoá service',
    'docker operation that can destroy data': 'thao tác docker có thể mất dữ liệu',
    'uninstall packages': 'gỡ gói phần mềm',
    'git operation that can lose or publish changes': 'git có thể mất thay đổi / đẩy ra ngoài',
    'connect to / push data to another machine': 'kết nối / đẩy dữ liệu sang máy khác',
    'send data out / run a downloaded script': 'gửi dữ liệu ra ngoài / chạy script tải về',
    'dump every environment variable': 'in toàn bộ biến môi trường',
    'script calls destructive commands': 'script gọi lệnh phá hoại',
    'touches a secret file or key': 'đụng tới file bí mật / khoá',
    'write to a system directory': 'ghi vào thư mục hệ thống',
    'edit startup / cron configuration': 'sửa cấu hình khởi động / cron',
    'read-only / harmless command': 'lệnh đọc / vô hại',
    'read sensitive content': 'đọc nội dung nhạy cảm',
    'read-only': 'chỉ đọc',
    'overwrite a secret file or key': 'ghi đè file bí mật / khoá',
    'edit a file inside the workspace': 'sửa file trong vùng làm việc',
    'calls another script': 'gọi script khác',
  },
};
