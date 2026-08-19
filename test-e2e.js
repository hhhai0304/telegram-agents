#!/usr/bin/env node
'use strict';
/*
 * End-to-end test: a fake Telegram Bot API + fake agent CLIs (test/fakebin).
 * Boots bot.js against them, feeds a scripted conversation, and checks what
 * the bot sends back. No network, no real CLIs, no real token.
 *
 *   /agent opencode -> hello   (json backend, session captured, resumed on 2nd turn)
 *   /agent kiro     -> hello   (text backend)
 *   /agent          (keyboard) · /status · /sessions on kiro
 *
 * Run: node test-e2e.js
 */

const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');

const CHAT = '424242';
const script = [
  { text: '/agent opencode' },
  { text: 'hello one' },
  { text: '/model gemini-3.7-flash' },   // free by TGA_FREE_MODELS prefix, not by name
  { text: 'hello two' },
  { text: '/status' },
  { text: '/agent kiro' },
  { text: 'hi kiro' },
  { text: 'hi again' },
  { text: '/sessions' },
  { text: '/agent' },
  { text: '/agent claude' },
  { text: '/status' },
];
let updateId = 1, cursor = 0, promptsServed = 0;
const sent = [];       // sendMessage bodies
const edits = [];      // editMessageText bodies
let msgId = 100;
let done;
const finished = new Promise((r) => { done = r; });

const api = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    const method = req.url.split('/').pop();
    let j = {}; try { j = JSON.parse(body || '{}'); } catch (_) {}
    const reply = (result) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, result })); };
    if (method === 'getUpdates') {
      // One update per poll, only after the previous turn produced its footer,
      // so the test drives the bot deterministically.
      // A prompt is only released once the previous prompt's footer (✅) has
      // been edited in, so every turn runs under the agent the script expects.
      const footers = edits.filter((e) => /^✅/.test(e.text)).length;
      if (cursor < script.length && footers >= promptsServed) {
        const s = script[cursor++];
        if (!s.text.startsWith('/')) promptsServed++;
        return reply([{ update_id: updateId++, message: { message_id: msgId++, chat: { id: Number(CHAT) }, text: s.text } }]);
      }
      if (cursor < script.length) return setTimeout(() => reply([]), 100);
      if (!finished.settled) { finished.settled = true; setTimeout(done, 1500); }
      return setTimeout(() => reply([]), 200);
    }
    if (method === 'sendMessage') { sent.push(j); return reply({ message_id: msgId++, chat: { id: Number(CHAT) } }); }
    if (method === 'editMessageText') { edits.push(j); return reply(true); }
    if (method === 'deleteMessage' || method === 'answerCallbackQuery') return reply(true);
    reply(true);
  });
});

(async () => {
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  const port = api.address().port;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tga-e2e-'));
  const fakebin = path.join(__dirname, 'test', 'fakebin');

  const bot = spawn(process.execPath, [path.join(__dirname, 'bot.js')], {
    env: {
      ...process.env,
      PATH: `${fakebin}:${process.env.PATH}`,
      TG_BOT_TOKEN: 'fake:token',
      TGA_ALLOWED_CHAT_IDS: CHAT,
      TGA_TELEGRAM_API: `http://127.0.0.1:${port}`,
      TGA_DATA_DIR: dataDir,
      TGA_APPROVE_PORT: String(20000 + Math.floor(Math.random() * 20000)),
      TGA_DEFAULT_CWD: dataDir,
      TGA_LANG: 'en',
      TGA_AGENTS: '', TGA_AGENT: 'claude',
      // Kilo has no fake CLI: the test asserts it shows up as NOT installed, so
      // pin its binary to a path that cannot exist. Without this the assertion
      // depends on whether the host happens to have `kilo` on PATH.
      TGA_KILO_BIN: '/nonexistent/kilo',
      // Between them these three exercise every branch of the price label:
      // `:free` suffix, a prefix declared free, and a model that bills.
      TGA_OPENCODE_MODEL: 'z-ai/glm-5.2:free',
      TGA_KIRO_MODEL: 'anthropic/claude-sonnet-5',
      TGA_FREE_MODELS: 'gemini-',
      CLAUDE_TG_ALLOWED_CHAT_IDS: '', CLAUDE_TG_GUARD_MODE: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let botLog = '';
  bot.stdout.on('data', (d) => { botLog += d; });
  bot.stderr.on('data', (d) => { botLog += d; });

  const timeout = setTimeout(() => { console.error('TIMEOUT\n' + botLog); process.exit(1); }, 30000);
  await finished;
  clearTimeout(timeout);
  bot.kill('SIGTERM');
  api.close();

  const texts = sent.map((m) => m.text);
  const all = texts.concat(edits.map((m) => m.text)).join('\n---\n');
  let n = 0;
  const test = (name, fn) => { n++; try { fn(); console.log(`ok ${n} - ${name}`); } catch (e) { console.log(`not ok ${n} - ${name}\n  ${e.message}`); process.exitCode = 1; } };

  test('/agent opencode switches', () => assert.ok(texts.some((t) => /Switched\.\n• OpenCode/.test(t)), texts.join('\n')));
  test('opencode: reply text arrives with the prompt and --auto/--format json', () => {
    const t = texts.find((x) => /fake-opencode says: hello one/.test(x));
    assert.ok(t, 'no reply');
    assert.ok(/--format json --auto/.test(t), t);
    assert.ok(!/--session/.test(t), 'first turn must not resume');
  });
  test('opencode: second turn resumes the captured session', () => {
    const t = texts.find((x) => /fake-opencode says: hello two/.test(x));
    assert.ok(t && /--session ses_fake01/.test(t), t);
  });
  test('opencode: footer shows tool count and session', () => {
    assert.ok(edits.some((e) => /✅ \d+s · 1 tool · ↩️ session fake01|✅ \d+s · 1 tool · 🆕 session fake01/.test(e.text)), edits.map((e) => e.text).join('\n'));
  });
  test('opencode: audit lists the bash call', () => assert.ok(edits.some((e) => /Touched:\n• Bash: rm -rf \/tmp\/x/.test(e.text))));
  test('every turn opens with the CLI, the model, and whether it bills', () => {
    // `:free` marks itself; anything else bills unless TGA_FREE_MODELS says so.
    assert.ok(texts.some((t) => /^⏳ .*· OpenCode · glm-5\.2:free · 🆓 free$/m.test(t)), texts.join('\n'));
    assert.ok(texts.some((t) => /^⏳ .*· Kiro CLI · claude-sonnet-5 · 💰 paid$/m.test(t)), 'kiro header');
  });
  test('TGA_FREE_MODELS marks a model free by prefix', () => {
    assert.ok(texts.some((t) => /^⏳ .*· OpenCode · gemini-3\.7-flash · 🆓 free$/m.test(t)), 'prefix-declared free');
  });
  test('/status shows the agent and cost', () => {
    const t = texts.find((x) => /^🧠 OpenCode\n/.test(x));
    assert.ok(t, 'no status');
    assert.ok(/session: fake01/.test(t) && /\$0\.002/.test(t), t);
  });
  test('kiro: text backend reply, tool counted, ANSI stripped', () => {
    const t = texts.find((x) => /fake-kiro says: hi kiro/.test(x));
    assert.ok(t && !/\x1b/.test(t) && / \[fresh\]/.test(t), t);
    assert.ok(edits.some((e) => /1 tool · 🆕 session last/.test(e.text)), 'footer');
  });
  test('kiro: second turn passes --resume', () => assert.ok(texts.some((x) => /fake-kiro says: hi again \[resumed\]/.test(x))));
  test('kiro: /sessions explains the one-conversation model', () => assert.ok(texts.some((x) => /Kiro CLI does not list sessions/.test(x))));
  test('/agent shows every agent with install marks', () => {
    const m = sent.find((x) => /Current agent: Kiro CLI/.test(x.text));
    assert.ok(m, 'no agent list');
    assert.ok(/• Kilo CLI ✗ not installed/.test(m.text), m.text);
    assert.ok(/• OpenCode — model gemini-3\.7-flash · session fake01/.test(m.text), m.text);
    const rows = m.reply_markup.inline_keyboard.map((r) => r[0].text);
    assert.deepStrictEqual(rows, ['Claude Code', 'OpenCode', 'Kilo CLI ✗', '● Kiro CLI']);
  });
  test('switching back to claude keeps its own (empty) session', () => {
    const t = texts.filter((x) => /^🧠 Claude Code\n/.test(x)).pop();
    assert.ok(t && /session: \(new\)/.test(t) && /sonnet · 🎚 high/.test(t), t);
  });
  test('state.json is per-agent (v3)', () => {
    const st = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
    assert.strictEqual(st.v, 3);
    const c = st.chats[CHAT];
    assert.strictEqual(c.agent, 'claude');
    assert.strictEqual(c.per.opencode.sessionId, 'ses_fake01');
    assert.strictEqual(c.per.kiro.sessionId, 'last');
  });
  console.log(`1..${n}`);
  if (process.exitCode) console.log('--- bot log ---\n' + botLog + '\n--- messages ---\n' + all);
  fs.rmSync(dataDir, { recursive: true, force: true });
})();
