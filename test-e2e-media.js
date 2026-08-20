#!/usr/bin/env node
'use strict';
/*
 * End-to-end test for attachments: a fake Bot API that serves getFile and the
 * file-download endpoint, plus the fake opencode CLI.
 *
 * What it proves:
 *   photo + caption   -> fetched to disk, the path reaches the agent's prompt
 *   photo, no caption -> still a turn, with a stand-in prompt
 *   album             -> ONE turn for the whole group, not one per photo
 *   edited message    -> a fresh turn, not silence
 *   oversized file    -> a message saying so, and no turn
 *
 * Run: node test-e2e-media.js
 */

const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');

const CHAT = '424242';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

let updateId = 1, msgId = 100;
const sent = [];
const edits = [];
const served = [];      // file paths the bot actually downloaded
let done;
const finished = new Promise((r) => { done = r; });

const prompts = () => sent.concat(edits).map((m) => m.text || '');
const anyText = (re) => prompts().some((t) => re.test(t));
const turnsDone = () => edits.filter((e) => /^✅/.test(e.text || '')).length;

/* Each step waits for the previous turn to finish, so the fake CLI's echo of
 * the prompt is unambiguous about which message produced it. */
const steps = [
  { when: () => true,
    updates: () => [photo('look at this', 'shot.png')] },

  { when: () => turnsDone() >= 1,
    updates: () => [photo(null, 'nocaption.png')] },

  // An album: three updates, one media_group_id, caption on the first.
  { when: () => turnsDone() >= 2,
    updates: () => [
      photo('three of them', 'a.png', 'grp1'),
      photo(null, 'b.png', 'grp1'),
      photo(null, 'c.png', 'grp1'),
    ] },

  { when: () => turnsDone() >= 3,
    updates: () => [edited('fixed my typo')] },

  { when: () => turnsDone() >= 4,
    updates: () => [photo('too heavy', 'huge.png', null, 30 * 1024 * 1024)] },
];
let step = 0;

function photo(caption, name, group, size = PNG.length) {
  const m = {
    message_id: msgId++,
    chat: { id: Number(CHAT) },
    from: { id: Number(CHAT) },
    photo: [{ file_id: `fid-${name}`, file_size: size, width: 1, height: 1 }],
  };
  if (caption) m.caption = caption;
  if (group) m.media_group_id = group;
  return { update_id: updateId++, message: m };
}
function edited(text) {
  return {
    update_id: updateId++,
    edited_message: {
      message_id: msgId++, chat: { id: Number(CHAT) }, from: { id: Number(CHAT) }, text,
    },
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

    // The download endpoint is /file/bot<token>/<file_path>, not a method call.
    if (req.url.startsWith('/file/')) {
      served.push(req.url);
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(PNG);
    }

    const method = req.url.split('/').pop();
    switch (method) {
      case 'getUpdates':
        if (step < steps.length && steps[step].when()) return reply(steps[step++].updates());
        if (step < steps.length) return setTimeout(() => reply([]), 50);
        if (!finished.settled) { finished.settled = true; setTimeout(done, 2500); }
        return setTimeout(() => reply([]), 100);
      case 'getFile': {
        const name = String(j.file_id).replace(/^fid-/, '');
        return reply({ file_id: j.file_id, file_path: `photos/${name}` });
      }
      case 'sendMessage':
        sent.push(j);
        return reply({ message_id: msgId++, chat: { id: Number(CHAT) } });
      case 'editMessageText':
        edits.push(j);
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tga-media-'));
  const fakebin = path.join(__dirname, 'test', 'fakebin');

  const bot = spawn(process.execPath, [path.join(__dirname, 'bot.js')], {
    env: {
      ...process.env,
      PATH: `${fakebin}:${process.env.PATH}`,
      TG_BOT_TOKEN: 'fake:token',
      TGA_ALLOWED_CHAT_IDS: CHAT,
      // bot.js reads the real config.env too — pin anything that gates input.
      TGA_ALLOWED_USER_IDS: '',
      TGA_TELEGRAM_API: `http://127.0.0.1:${port}`,
      TGA_DATA_DIR: dataDir,
      TGA_APPROVE_PORT: String(20000 + Math.floor(Math.random() * 20000)),
      TGA_DEFAULT_CWD: dataDir,
      TGA_LANG: 'en',
      TGA_AGENTS: 'opencode', TGA_AGENT: 'opencode',
      TGA_KILO_BIN: '/nonexistent/kilo',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let botLog = '';
  bot.stdout.on('data', (d) => { botLog += d; });
  bot.stderr.on('data', (d) => { botLog += d; });

  const bail = setTimeout(() => { done(); }, 40000);
  await finished;
  clearTimeout(bail);
  bot.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 300));

  // The fake CLI echoes the prompt it was given, so the replies show exactly
  // what the agent received.
  const echoes = prompts().filter((t) => /fake-opencode says:/.test(t));

  test('a photo with a caption reaches the agent as caption + path', () => {
    const e = echoes.find((t) => /look at this/.test(t));
    assert.ok(e, `no turn for the captioned photo. Got:\n${echoes.join('\n--\n')}`);
    // A Telegram photo carries no filename, so the bot names it after the
    // format file_path reports — png here, not the guessed jpg.
    assert.ok(/\[image: image\.png\]/.test(e), e);
    assert.ok(/telegram-agents-media\/\d+-image\.png/.test(e), e);
  });

  test('the file was really downloaded, not just named', () => {
    assert.ok(served.some((u) => /photos\/shot\.png$/.test(u)), served.join(', '));
    const m = /(\/tmp\/[^\s\]]*telegram-agents-media\/\d+-image\.png)/.exec(echoes.join('\n'));
    assert.ok(m, 'no path in the prompt');
    assert.ok(fs.existsSync(m[1]), `${m[1]} is not on disk`);
    assert.strictEqual(fs.readFileSync(m[1]).length, PNG.length, 'wrong bytes');
  });

  test('a photo with no caption still starts a turn', () => {
    // Nothing in the prompt names the source file, so identify the turn by its
    // stand-in text and check it still carried a path.
    const e = echoes.find((t) => /attached file/.test(t));
    assert.ok(e, echoes.join('\n--\n'));
    assert.ok(/telegram-agents-media\/\d+-image\.png/.test(e), e);
  });

  test('an album is one turn, with every photo in it', () => {
    const album = echoes.filter((t) => /three of them/.test(t));
    assert.strictEqual(album.length, 1, `the album fired ${album.length} turns`);
    const paths = album[0].match(/telegram-agents-media\/\d+-image\.png/g) || [];
    assert.strictEqual(new Set(paths).size, 3, `expected 3 distinct files, got ${paths.length}`);
  });

  test('an edited message is answered instead of ignored', () => {
    assert.ok(echoes.some((t) => /fixed my typo/.test(t)), echoes.join('\n--\n'));
  });

  test('an oversized file is refused out loud, and runs nothing', () => {
    assert.ok(anyText(/Could not fetch the image.*20 MB/s), prompts().join('\n--\n'));
    assert.ok(!echoes.some((t) => /too heavy/.test(t)), 'the oversized photo still ran a turn');
  });

  console.log(`1..${n}`);
  if (process.exitCode) console.log('--- bot log ---\n' + botLog);
  fs.rmSync(dataDir, { recursive: true, force: true });
  api.close();
})();
