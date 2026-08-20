'use strict';
/*
 * English UI strings. This is the reference catalogue: every other locale is
 * merged on top of it, so anything a translation is missing falls back here.
 *
 * Values are either plain strings or functions of the values they interpolate.
 * Keep the keys stable — bot.js refers to them by name.
 */

module.exports = {
  lang: 'en',

  // --- approval prompt -----------------------------------------------------
  approvalTitle: '🔐 Permission request',
  approvalTool: (tool) => `Tool: ${tool}`,
  approvalWhy: (why) => `⚠️ ${why}`,
  approvalIntent: (desc) => `Intent: ${desc}`,
  approvalDeadline: (secs) => `No answer within ${secs}s → automatically denied.`,
  btnAllow: '✅ Allow',
  btnAllowSession: (sig) => `♾ Allow every "${sig}" this session`,
  btnDeny: '❌ Deny',
  approvalTimedOut: (tool, detail) => `⌛ Timed out — denied.\n\nTool: ${tool}\n${detail}`,
  grantsNone: 'No "allow for this session" grants yet.',
  grantsList: (sigs) => `♾ Grants in effect for this session:\n\n${sigs.map((s) => `• ${s}`).join('\n')}`,
  btnRevokeAll: '🗑 Revoke all',
  revokedAll: '🗑 Revoked every "allow for this session" grant.',
  noteAllowed: '✅ Allowed',
  noteAllowedSession: (sig) => `♾ Allowed, and every "${sig}" this session will run without asking`,
  noteDenied: '❌ Denied',

  // --- turn lifecycle ------------------------------------------------------
  costFree: '🆓 free',
  costPaid: '💰 paid',
  tagResumed: (id) => `↩️ continuing ${id}`,
  tagNew: '🆕 new session',
  working: (tag) => `⏳ ${tag}`,
  progress: (tag, secs, tools, tool) =>
    `⏳ ${tag} · ${secs}s · ${tools} tool` + (tool ? `\n🔧 ${tool}` : ''),
  sessionEnded: (icon, id) => `${icon} session ${id}`,
  sessionUnknown: '(session unknown)',
  footerDone: (secs, tools, tag) => `✅ ${secs}s · ${tools} tool · ${tag}`,
  footerStopped: (secs, tools, tag) => `🛑 stopped · ${secs}s · ${tools} tool · ${tag}`,
  footerFailed: (secs, tag) => `⚠️ ended abnormally · ${secs}s · ${tag}`,
  footerDenied: (names) => `\n🚫 denied: ${names}`,
  auditHeader: (lines) => `\n\n🔧 Touched:\n${lines}`,
  auditMore: (n) => `• … and ${n} more`,
  noOutput: '(no output)',
  unknownContent: '(no description)',
  internalError: (msg) => `❌ Internal error: ${msg}`,
  queued: (n) => `⏸ Busy, queued (#${n}).`,
  stopping: '🛑 Stopping…',
  queueCleared: '🛑 Queue cleared.',
  nothingRunning: 'Nothing is running.',

  // --- relative time -------------------------------------------------------
  agoSeconds: (n) => `${n}s ago`,
  agoMinutes: (n) => `${n} min ago`,
  agoHours: (n) => `${n}h ago`,
  agoDays: (n) => `${n}d ago`,

  // --- sessions ------------------------------------------------------------
  noSessions: (cwd, agent) => `No ${agent} sessions yet in ${cwd}.`,
  sessionsHeader: (cwd, agent) => `📋 ${agent} sessions in ${cwd}:`,
  sessionsUnsupported: (agent, resuming) =>
    `${agent} does not list sessions. It keeps one conversation per directory: ` +
    (resuming ? 'the next message continues it; /new starts over.' : 'the next message starts a new one.'),
  sessionCurrent: ' ← current',
  btnNewSession: '🆕 New session',
  newSession: '🆕 New session. Session grants cleared.',
  newSessionShort: '🆕 New session.',
  sessionNotFound: (arg, cwd) => `❌ No session "${arg}" in ${cwd}.`,
  resumedInto: (id) => `↩️ Using session ${id}…\nAnything you send now runs in it.`,
  ackNewSession: 'New session',
  ackResumed: 'Resumed',
  ackRevoked: 'Revoked',
  ackExpired: 'That request has expired.',
  ackNotAllowed: 'Not allowed.',

  // --- directory -----------------------------------------------------------
  cdUsage: 'Usage: /cd <path>',
  notADirectory: (p) => `❌ Not a directory: ${p}`,
  cdDone: (p) => `📁 ${p}\n(session reset because the directory changed — /sessions lists the old ones here)`,
  missingDirectory: (p) => `❌ Directory does not exist: ${p}\nUse /cd to change it.`,

  // --- settings ------------------------------------------------------------
  modelCurrent: (m, agent) => `🤖 ${agent} · current model: ${m}`,
  modelFreeText: 'Set one with /model <name> (the exact id the CLI accepts, e.g. provider/model). /model - clears it and lets the CLI pick.',
  effortCurrent: (e) => `🎚 Current effort: ${e}\n(higher = thinks harder, costs more tokens and time)`,
  effortUnsupported: (agent) => `${agent} has no effort setting.`,
  unleashedNotice:
    '🔓 OFF THE LEASH — all three modes run straight through, nothing asks.\n' +
    'Leash it again: TGA_GUARD_MODE=bymode in config.env, then restart the service.\n\n',
  agentNoGuard: (agent) =>
    `🔓 ${agent} has no approval hook: it always runs in its own auto-approve mode, ` +
    `so the mode below only applies when the agent is Claude Code.\n\n`,
  modeCurrent: (mode, autoAllow) =>
    `🔐 Current mode: ${mode}\n\n` +
    `smart — only asks about dangerous work: deleting or overwriting files,\n` +
    `        sudo, reading keys and secret files, destructive docker/git,\n` +
    `        touching /etc, sending data out. The rest runs straight through\n` +
    `        and is listed at the end of the turn.\n` +
    `ask   — approve every tool call (except ${autoAllow})\n` +
    `auto  — never asks, but only read-only tools and harmless bash work`,
  ackUnknownModel: 'Unknown model',
  ackUnknownAgent: 'Unknown agent',
  ackAgentNotInstalled: (agent) => `${agent} is not installed on this machine.`,
  ackUnknownEffort: 'Unknown effort',
  ackUnknownMode: 'Unknown mode',
  ackUnknownStream: 'Unknown delivery mode',
  ackMode: (m) => `Mode: ${m}`,
  ackStream: (s) => `Delivery: ${s}`,
  modeExplain: {
    smart: '🛡 smart — only asks about dangerous work, the rest runs straight through.',
    ask: '🔐 ask — every tool call waits for your approval.',
    auto: '🔓 auto — never asks, but only read-only tools and harmless bash work.',
  },
  streamCurrent: (s) =>
    `📨 Current delivery: ${s}\n\n` +
    `batch — buffer everything the agent says, send once the turn is done (or when an approval is needed)\n` +
    `live  — send each chunk as it arrives, watch it think`,
  streamExplain: {
    batch: '📨 batch — buffered, one message when the turn is done or an approval is needed.',
    live: '📨 live — every chunk sent as it arrives.',
  },

  // --- agents --------------------------------------------------------------
  agentCurrent: (agent) => `🧠 Current agent: ${agent}`,
  agentLine: ({ name, installed, session, model, guard }) =>
    `• ${name}${installed ? '' : ' ✗ not installed'} — model ${model}` +
    (session ? ` · session ${session}` : '') + (guard ? '' : ' · 🔓 no approval hook'),
  agentHint: 'Tap one to switch, or /agent <id>. Every agent keeps its own session, model and effort.',
  agentSwitched: (line) => `🧠 Switched.\n${line}`,
  agentUnknown: (arg, ids) => `❌ Unknown agent "${arg}". Known: ${ids.join(', ')}`,
  agentNotInstalled: (agent, bin) => `❌ ${agent} is not installed here (no "${bin}" on PATH). Pick another with /agent.`,
  agentDefault: '(CLI default)',

  // --- status --------------------------------------------------------------
  status: ({ agent, cwd, session, model, effort, guard, mode, stream, grants, turns, cost, active, queued }) => [
    `🧠 ${agent}`,
    `📁 ${cwd}`,
    `🔑 session: ${session}`,
    `🤖 ${model} · 🎚 ${effort} · ${guard === 'none' ? '🔓 off the leash' : `🔐 ${mode}`} · 📨 ${stream}`,
    `♾ session grants: ${grants}`,
    `💬 turns: ${turns} · 💵 ~$${cost}`,
    `⚙️ running: ${active} · queued: ${queued}`,
  ].join('\n'),
  statusNewSession: '(new)',

  // --- attachments ---------------------------------------------------------
  // Files are fetched to disk and named in the prompt, because the agents read
  // paths, not Telegram updates.
  mediaLine: (kind, name, p) => `[${kind}: ${name}]\n${p}`,
  mediaNoCaption: (n) => n === 1
    ? 'Have a look at the attached file.'
    : `Have a look at the ${n} attached files.`,
  mediaSaved: (n) => n === 1 ? '📎 Saved 1 attachment.' : `📎 Saved ${n} attachments.`,
  mediaFailed: (kind, why) => `⚠️ Could not fetch the ${kind}: ${why}`,
  // --- forum topics --------------------------------------------------------
  // A supergroup with Topics turns each thread into its own session; the
  // General topic is the hub that opens, lists and restores them.
  topicWelcome: (name, cwd, agent, model) =>
    `🧵 ${name}\n📁 ${cwd}\n🧠 ${agent}${model ? ` · ${model}` : ''}\n\nSettings come from General; change them here and this topic goes its own way.\nSend a message to start. /close archives this topic, /drop deletes it.`,
  topicDefaultName: (stamp) => `session ${stamp}`,
  topicOpened: (name) => `🧵 Opened "${name}".`,
  topicFailed: (msg) => `⚠️ Telegram refused: ${msg}\n\nThe bot needs to be an admin with "Manage Topics" (and "Delete Messages" for /drop).`,
  topicsNotForum: 'This chat is not a forum. Turn on Topics in the group settings, then make the bot an admin with "Manage Topics".',
  topicOnlyInTopic: 'That only works inside a topic, not in General.',
  topicsNone: 'No topics yet. /new opens one.',
  topicsHeader: (total) => `🧵 Topics (${total})`,
  topicsTruncated: (hidden, shown) => `… and ${hidden} more, not shown (the newest ${shown} fit).`,
  topicLine: ({ icon, name, agent, session, cwd, when, live }) =>
    `${icon} ${name}${live ? ' ⏳' : ''} · ${agent} · ${session}\n   ${cwd} · ${when}`,
  topicsHint: 'Closed topics keep their history. Deleted ones keep their session — restore opens a fresh topic and resumes it.',
  topicClosing: '🔒 Closing this topic. Its session is kept — restore it from General.',
  topicDropping: '🗑 Deleting this topic…',
  topicDropped: (name) => `🗑 Deleted "${name}". Its session is kept — /topics in here restores it.`,
  topicRenameUsage: 'Usage: /rename <new name>',
  topicRenamed: (name) => `✏️ Renamed to "${name}".`,
  topicRestored: (name, cwd, agent, session) =>
    `♻️ Restored "${name}"\n📁 ${cwd}\n🧠 ${agent}\n🔑 session: ${session}\n\nCarry on where you left off.`,
  btnTopicClose: (name) => `🔒 Close ${name}`.slice(0, 60),
  btnTopicReopen: (name) => `🔓 Reopen ${name}`.slice(0, 60),
  btnTopicRestore: (name) => `♻️ Restore ${name}`.slice(0, 60),
  btnTopicForget: '🗑 Forget',
  ackTopicGone: 'That topic is no longer in the registry.',
  ackTopicClosed: 'Closed.',
  ackTopicReopened: 'Reopened.',
  ackTopicRestored: 'Restored.',
  ackTopicForgotten: 'Forgotten.',

  // --- help ----------------------------------------------------------------
  // Slash-command menu published to Telegram with setMyCommands on every boot.
  // Keep it in sync with handleCommand(); a stale menu autocompletes commands
  // this bot does not have, and unknown commands are sent to the agent as text.
  menuCommands: [
    ['agent', 'Switch coding agent'],
    ['model', 'Show or set the model for this agent'],
    ['effort', 'Reasoning effort: low to max (Claude Code)'],
    ['mode', 'Approval mode: smart / ask / auto'],
    ['stream', 'Replies: batch (one message) or live'],
    ['sessions', 'Recent sessions, tap to resume'],
    ['resume', 'Resume a session by id'],
    ['new', 'New session — in a forum, a new topic'],
    ['topics', 'List the topics: close, reopen, restore'],
    ['close', 'Archive this topic, keep its session'],
    ['drop', 'Delete this topic, keep its session'],
    ['rename', 'Rename this topic'],
    ['status', 'Session, directory, model, effort, cost'],
    ['pwd', 'Show the working directory'],
    ['cd', 'Change the working directory'],
    ['approvals', 'View and revoke session-wide grants'],
    ['stop', 'Stop the running job'],
    ['help', 'Show available commands'],
  ],

  help: (unleashed, agents) => [
    'Coding agents over Telegram — just send a message and the current agent runs it.',
    '',
    '🧠 Agent',
    `/agent — switch between ${agents.join(' / ')}`,
    '',
    '📋 Sessions',
    '/sessions — recent sessions, tap one to resume',
    '/new (= /clear) — start a fresh session',
    '',
    '🧵 Topics (a supergroup with Topics on)',
    '/new [name] — in General: open a topic, i.e. a session that runs alongside the others',
    '/topics — list them, with buttons to close, reopen or restore',
    '/close — archive this topic · /drop — delete it · /rename <name>',
    'A deleted topic keeps its session: restoring opens a new topic and resumes it.',
    '/resume <id> — resume a specific id',
    '/status — session, directory, model, effort, cost',
    '',
    '⚙️ Settings',
    '/model — pick or type a model for the current agent',
    '/effort — low → max (Claude Code)',
    '/mode — smart · ask · auto (Claude Code only' + (unleashed ? '; OFF THE LEASH: none of them ask)' : ')'),
    '/stream — batch (one message at the end, default) or live (as it goes)',
    '/cd <path> — change directory · /pwd — show it',
    '',
    '🔐 Permissions',
    '/approvals — view and revoke "allow for this session" grants (Claude Code)',
    '/stop — kill the running job',
  ].join('\n'),

  /* Risk reasons come from risk.js in English. A locale may translate them by
   * providing a `reasons` map; unknown reasons pass through untouched.
   * `foo.sh: delete files` is translated by its tail, after the colon. */
  reasons: {},
};
