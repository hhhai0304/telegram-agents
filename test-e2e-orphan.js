#!/usr/bin/env node
'use strict';
/*
 * Regression test: an agent that leaves a daemon behind must not wedge the
 * conversation.
 *
 * Measured on 2026-08-20 — a turn showed "10771s · 0 tool" three hours after
 * its agent had been killed by the time limit, and every later message in that
 * topic queued behind it. `child.on('close')` waits for the process to exit AND
 * for every stdio pipe to close; a grandchild inherits those pipes and holds
 * them for as long as it lives, so 'close' never came.
 *
 * The fake CLI here does exactly that: it spawns a child that inherits stdout
 * and sits there for a minute, then exits itself.
 *
 * Passing means: the first turn ends anyway, and the SECOND message is answered
 * rather than queued forever.
 *
 * Run: node test-e2e-orphan.js
 */

const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');

const CHAT = '424242';

let updateId = 1, msgId = 100;
const sent = [];
const edits = [];
let done;
const finished = new Promise((r) => { done = r; });

const texts = () => sent.concat(edits).map((m) => m.text || '');
const footers = () => texts().filter((t) => /^[✅⌛🛑❌]/.test(t));

const steps = [
  { when: () => true, updates: () => ['first, with an orphan'] },
  // Only released once the first turn has produced a footer. If the orphan
  // wedged the bot, this step never fires and the test fails on turn count.
  { when: () => footers().length >= 1, updates: () => ['second, must not queue'] },
];
let step = 0;

function msg(text) {
  return {
    update_id: updateId++,
    message: { message_id: msgId++, chat: { id: Number(CHAT) }, from: { id: Number(CHAT) }, text },
  };
}

const api = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    let j = {}; try { j = JSON.parse(body || '{}'); } catch (_) {}
    const reply = (result) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result }));
    };
    const method = req.url.split('/').pop();
    switch (method) {
      case 'getUpdates':
        if (step < steps.length && steps[step].when()) {
          return reply(steps[step++].updates().map(msg));
        }
        if (step < steps.length) return setTimeout(() => reply([]), 100);
        if (!finished.settled) { finished.settled = true; setTimeout(done, 5000); }
        return setTimeout(() => reply([]), 100);
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tga-orphan-'));
  const fakebin = path.join(__dirname, 'test', 'fakebin');

  const bot = spawn(process.execPath, [path.join(__dirname, 'bot.js')], {
    env: {
      ...process.env,
      PATH: `${fakebin}:${process.env.PATH}`,
      TG_BOT_TOKEN: 'fake:token',
      TGA_ALLOWED_CHAT_IDS: CHAT,
      TGA_ALLOWED_USER_IDS: '',
      TGA_TELEGRAM_API: `http://127.0.0.1:${port}`,
      TGA_DATA_DIR: dataDir,
      TGA_APPROVE_PORT: String(20000 + Math.floor(Math.random() * 20000)),
      TGA_DEFAULT_CWD: dataDir,
      TGA_LANG: 'en',
      TGA_AGENTS: 'opencode', TGA_AGENT: 'opencode',
      TGA_KILO_BIN: '/nonexistent/kilo',
      FAKE_ORPHAN: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let botLog = '';
  bot.stdout.on('data', (d) => { botLog += d; });
  bot.stderr.on('data', (d) => { botLog += d; });

  // Generous, but far short of the 30-minute task limit: if the fix is missing
  // the bot sits here doing nothing rather than finishing either turn.
  const bail = setTimeout(() => { done(); }, 25000);
  await finished;
  clearTimeout(bail);
  bot.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 300));

  const echoes = texts().filter((t) => /fake-opencode says:/.test(t));

  test('a turn ends even though a grandchild still holds stdout', () => {
    assert.ok(footers().length >= 1,
      `no turn ever finished — the orphan wedged it.\n${texts().join('\n--\n')}`);
    assert.ok(echoes.some((t) => /first, with an orphan/.test(t)), echoes.join('\n--\n'));
  });

  test('the next message is answered, not stuck behind the dead job', () => {
    assert.ok(echoes.some((t) => /second, must not queue/.test(t)),
      `the second message never ran.\n${texts().join('\n--\n')}`);
  });

  test('nothing reports being busy', () => {
    assert.ok(!texts().some((t) => /queued/i.test(t)), texts().join('\n--\n'));
  });

  console.log(`1..${n}`);
  if (process.exitCode) console.log('--- bot log ---\n' + botLog);
  fs.rmSync(dataDir, { recursive: true, force: true });
  api.close();
})();
