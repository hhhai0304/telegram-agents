#!/usr/bin/env node
'use strict';
/*
 * End-to-end test for forum topics: a fake Telegram Bot API that pretends the
 * chat is a supergroup with Topics on, plus the fake opencode CLI.
 *
 * What it proves:
 *   /new in General            -> createForumTopic, and the welcome lands in it
 *   two topics, one poll       -> both agents run AT THE SAME TIME
 *   every reply                -> carries the right message_thread_id
 *   /topics                    -> lists them with management buttons
 *   /close, /drop              -> hit the right Bot API methods
 *   restore button             -> new topic, old session id resumed
 *
 * Run: node test-e2e-forum.js
 */

const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');

const CHAT = '-1001234567890';
const OWNER = 878600413;
const STRANGER = 999000111;   // in the group, not on the user allowlist
const AGENT_DELAY_MS = 900;   // how long a fake turn takes

let updateId = 1, msgId = 100, nextThread = 100;
const sent = [];        // sendMessage bodies
const edits = [];       // editMessageText bodies
const calls = [];       // every method name, in order
const topics = [];      // createForumTopic bodies
let done;
const finished = new Promise((r) => { done = r; });

/* The script is a list of steps. A step is released once its `when` holds, so
 * the test stays deterministic without hard-coded sleeps — except the one step
 * that deliberately releases two messages in a single poll. */
const inTopic = (t) => sent.filter((m) => m.message_thread_id === t);
const anyText = (re) => sent.concat(edits).some((m) => re.test(m.text || ''));

const steps = [
  // Change the hub's model first: a topic opened afterwards must inherit it,
  // rather than falling back to the configured default.
  { when: () => true,
    updates: () => [msg('/model gemini-3.7-flash')] },

  { when: () => anyText(/gemini-3\.7-flash/),
    updates: () => [msg('/new build')] },

  { when: () => topics.length >= 1,
    updates: () => [msg('/new test')] },

  // Both at once, in one getUpdates response: the whole point of the feature.
  { when: () => topics.length >= 2,
    updates: () => [msg('hello build', 101), msg('hello test', 102)] },

  { when: () => edits.filter((e) => /^✅/.test(e.text || '')).length >= 2,
    updates: () => [msg('/topics')] },

  { when: () => anyText(/🧵 Topics/),
    updates: () => [msg('/close', 101)] },

  // Posting in a closed topic revives it: Telegram allows it for an admin, so
  // the registry must not keep calling it closed.
  { when: () => calls.includes('closeForumTopic'),
    updates: () => [msg('still here', 101)] },

  { when: () => calls.includes('reopenForumTopic'),
    updates: () => [msg('/drop', 102)] },

  { when: () => calls.includes('deleteForumTopic'),
    updates: () => [cb('T:r:102')] },

  // A stranger who is in the group but not on TGA_ALLOWED_USER_IDS, plus an
  // anonymous admin (posts as the group, no real user). Neither may do
  // anything. The owner's /topics right after is the fence: once its answer
  // shows up, both of those were definitely processed and dropped.
  { when: () => sent.some((m) => /♻️ Restored/.test(m.text || '')),
    updates: () => [
      msg('rm -rf /', 101, STRANGER),
      cb('T:x:101', STRANGER),
      msg('/drop', 101, OWNER, { sender_chat: { id: Number(CHAT), type: 'supergroup' } }),
      msg('/status'),
    ] },
];
let step = 0;

function msg(text, thread, from = OWNER, extra = {}) {
  const m = { message_id: msgId++, chat: { id: Number(CHAT), is_forum: true }, from: { id: from }, text, ...extra };
  if (thread) { m.message_thread_id = thread; m.is_topic_message = true; }
  return { update_id: updateId++, message: m };
}
function cb(data, from = OWNER) {
  return {
    update_id: updateId++,
    callback_query: {
      id: String(updateId), data,
      from: { id: from },
      message: { message_id: msgId++, chat: { id: Number(CHAT), is_forum: true } },
    },
  };
}

const api = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    const method = req.url.split('/').pop();
    let j = {}; try { j = JSON.parse(body || '{}'); } catch (_) {}
    const reply = (result) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result }));
    };
    if (method !== 'getUpdates') calls.push(method);

    switch (method) {
      case 'getUpdates':
        if (step < steps.length && steps[step].when()) return reply(steps[step++].updates());
        if (step < steps.length) return setTimeout(() => reply([]), 50);
        if (!finished.settled) { finished.settled = true; setTimeout(done, 1200); }
        return setTimeout(() => reply([]), 100);
      case 'getChat':
        return reply({ id: Number(CHAT), type: 'supergroup', is_forum: true });
      case 'createForumTopic': {
        topics.push(j);
        return reply({ message_thread_id: ++nextThread, name: j.name, icon_color: j.icon_color });
      }
      case 'sendMessage':
        sent.push({ ...j, at: Date.now() });
        return reply({ message_id: msgId++, chat: { id: Number(CHAT) } });
      case 'editMessageText':
        edits.push({ ...j, at: Date.now() });
        return reply(true);
      default:
        return reply(true);
    }
  });
});

let n = 0;
function test(name, fn) {
  n++;
  try { fn(); console.log(`ok ${n} - ${name}`); }
  catch (e) { process.exitCode = 1; console.log(`not ok ${n} - ${name}\n  ${e.message}`); }
}

(async () => {
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  const port = api.address().port;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tga-forum-'));
  const fakebin = path.join(__dirname, 'test', 'fakebin');

  const bot = spawn(process.execPath, [path.join(__dirname, 'bot.js')], {
    env: {
      ...process.env,
      PATH: `${fakebin}:${process.env.PATH}`,
      TG_BOT_TOKEN: 'fake:token',
      TGA_ALLOWED_CHAT_IDS: CHAT,
      // overridable (to empty) so the refusal assertions can be shown to fail
      TGA_ALLOWED_USER_IDS: process.env.TGA_ALLOWED_USER_IDS !== undefined
        ? process.env.TGA_ALLOWED_USER_IDS : String(OWNER),
      TGA_TELEGRAM_API: `http://127.0.0.1:${port}`,
      TGA_DATA_DIR: dataDir,
      TGA_APPROVE_PORT: String(20000 + Math.floor(Math.random() * 20000)),
      TGA_DEFAULT_CWD: dataDir,
      TGA_LANG: 'en',
      TGA_AGENTS: 'opencode', TGA_AGENT: 'opencode',
      // overridable so the concurrency assertion can be shown to fail at 1
      TGA_MAX_CONCURRENT: process.env.TGA_MAX_CONCURRENT || '2',
      FAKE_DELAY_MS: String(AGENT_DELAY_MS),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let botLog = '';
  bot.stdout.on('data', (d) => { botLog += d; });
  bot.stderr.on('data', (d) => { botLog += d; });

  const bail = setTimeout(() => { done(); }, 30000);
  await finished;
  clearTimeout(bail);
  bot.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 300));

  // --- what happened ------------------------------------------------------

  test('/new in General created a topic named after the argument', () => {
    assert.strictEqual(topics.length, 3, `expected 3 createForumTopic calls, got ${topics.length}`);
    assert.deepStrictEqual(topics.slice(0, 2).map((t) => t.name), ['build', 'test']);
    assert.strictEqual(topics[0].chat_id, CHAT);
  });

  test('a new topic inherits the hub model, but not its session', () => {
    const w = sent.find((m) => /🧵 build/.test(m.text || ''));
    assert.ok(w && /gemini-3\.7-flash/.test(w.text), `welcome did not inherit the model: ${w && w.text}`);
    const st = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
    const topic = st.chats[`${CHAT}:101`];
    assert.strictEqual(topic.per.opencode.model, 'gemini-3.7-flash');
    // The hub's own session must not have been handed over at creation time.
    assert.notStrictEqual(topic.per.opencode.sessionId, st.chats[CHAT].per.opencode.sessionId);
  });

  test('a message in a closed topic reopens it', () => {
    assert.ok(calls.includes('reopenForumTopic'), 'the topic was left closed on Telegram');
    const st = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
    assert.strictEqual(st.topics[CHAT]['101'].status, 'open', 'the registry still says closed');
  });

  test('the topic list says how many there are', () => {
    const list = sent.filter((m) => /🧵 Topics \(/.test(m.text || '')).pop();
    assert.ok(list, 'the header lost its count');
    assert.ok(/🧵 Topics \(2\)/.test(list.text), list.text.split('\n')[0]);
  });

  test('the welcome message goes into the new topic, not into General', () => {
    const w = sent.find((m) => /🧵 build/.test(m.text || ''));
    assert.ok(w, 'no welcome for "build"');
    assert.strictEqual(w.message_thread_id, 101);
  });

  test('each topic replies inside itself', () => {
    assert.ok(inTopic(101).some((m) => /hello build/.test(m.text || '')), 'topic 101 lost its reply');
    assert.ok(inTopic(102).some((m) => /hello test/.test(m.text || '')), 'topic 102 lost its reply');
    assert.ok(!inTopic(101).some((m) => /hello test/.test(m.text || '')), 'replies crossed topics');
  });

  test('the two topics ran at the same time, not one after the other', () => {
    // Serial execution would mean topic 102 only starts after 101 is done. The
    // fake CLI takes AGENT_DELAY_MS, so the two timestamps say which it was.
    const start = (t) => sent.find((m) => m.message_thread_id === t && /^⏳/.test(m.text || ''));
    const s101 = start(101), s102 = start(102);
    assert.ok(s101 && s102, 'a topic never started');
    const firstFinish = Math.min(...edits.filter((e) => /^✅/.test(e.text || '')).map((e) => e.at));
    assert.ok(edits.filter((e) => /^✅/.test(e.text || '')).length >= 2, 'both turns should finish');
    assert.ok(s102.at < firstFinish,
      `topic 102 started ${s102.at - firstFinish}ms AFTER the first turn finished — that is serial`);
    assert.ok(Math.abs(s101.at - s102.at) < AGENT_DELAY_MS,
      `the two turns started ${Math.abs(s101.at - s102.at)}ms apart, more than one turn's work`);
  });

  test('/topics lists both, with buttons', () => {
    const list = sent.filter((m) => /🧵 Topics/.test(m.text || '')).pop();
    assert.ok(list, 'no topic list');
    assert.ok(/build/.test(list.text) && /test/.test(list.text), list.text);
    const labels = (list.reply_markup.inline_keyboard || []).flat().map((b) => b.text);
    assert.ok(labels.some((t) => /Close/.test(t)), labels.join(' | '));
    assert.ok(labels.some((t) => /Forget/.test(t)), labels.join(' | '));
  });

  test('/close and /drop reach the right Bot API methods', () => {
    assert.ok(calls.includes('closeForumTopic'), calls.join(','));
    assert.ok(calls.includes('deleteForumTopic'), calls.join(','));
  });

  test('restore opens a fresh topic and carries the session over', () => {
    const restored = sent.find((m) => /♻️ Restored/.test(m.text || ''));
    assert.ok(restored, 'nothing was restored');
    assert.strictEqual(restored.message_thread_id, 103, 'restore must use the NEW thread id');
    assert.ok(/session: fake01/.test(restored.text), restored.text);
  });

  test('state keys the conversations by topic', () => {
    const st = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
    assert.ok(st.chats[`${CHAT}:101`], 'topic 101 has no state');
    assert.ok(!st.chats[`${CHAT}:102`], 'the dropped topic kept its old key');
    assert.ok(st.chats[`${CHAT}:103`], 'the restored topic has no state');
    assert.strictEqual(st.chats[`${CHAT}:103`].per.opencode.sessionId, 'ses_fake01');
    assert.strictEqual(st.topics[CHAT]['101'].status, 'open', 'reopened by the message sent into it');
  });

  test('a stranger in the group is ignored completely', () => {
    // No prompt ran for them: nothing quotes their text, and no new turn started.
    assert.ok(!sent.some((m) => /rm -rf \//.test(m.text || '')), 'the stranger reached the agent');
    // Two turns legitimately ran in topic 101: "hello build" and "still here".
    // A third would mean the stranger's message got through.
    const startsIn101 = sent.filter((m) => m.message_thread_id === 101 && /^⏳/.test(m.text || ''));
    assert.strictEqual(startsIn101.length, 2, 'an extra turn ran in topic 101');
  });

  test("a stranger's button tap is refused, and changes nothing", () => {
    // T:x:101 would have wiped topic 101 from the registry. Checking merely
    // that the entry EXISTS proves nothing — the next message in that topic
    // re-registers it. The name is the tell: a re-registered topic falls back
    // to "topic 101", only the surviving record still says "build".
    const st = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
    assert.ok(st.topics[CHAT]['101'], 'the stranger managed to forget a topic');
    assert.strictEqual(st.topics[CHAT]['101'].name, 'build',
      'the record was destroyed and rebuilt, so the tap went through');
  });

  test('a message sent on behalf of the chat is refused even with the owner id', () => {
    // sender_chat = anonymous admin or a forwarded channel post: not a person,
    // so it must not pass just because `from` happens to be allowed.
    assert.strictEqual(calls.filter((c) => c === 'deleteForumTopic').length, 1,
      'the anonymous /drop went through');
  });

  test('the owner still works with the filter on', () => {
    assert.ok(sent.some((m) => /🧠 OpenCode/.test(m.text || '')), 'no /status answer for the owner');
  });

  console.log(`1..${n}`);
  if (process.exitCode) {
    console.log('--- bot log ---\n' + botLog);
    console.log('--- sent ---\n' + sent.map((m) => `[${m.message_thread_id || 'general'}] ${m.text}`).join('\n---\n'));
    console.log('--- calls ---\n' + calls.join(', '));
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
  api.close();
})();
