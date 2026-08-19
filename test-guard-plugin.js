#!/usr/bin/env node
'use strict';
/* Tests for plugin/telegram-agents-guard.js — the approval gate the OpenCode
 * family uses in place of a PreToolUse hook. A fake /approve server stands in
 * for the bot; no CLI and no network. Run: node test-guard-plugin.js */

const assert = require('assert');
const http = require('http');
const path = require('path');
const { pathToFileURL } = require('url');

const PLUGIN = pathToFileURL(path.join(__dirname, 'plugin', 'telegram-agents-guard.mjs')).href;

let n = 0;
const results = [];
async function test(name, fn) {
  n++;
  try { await fn(); console.log(`ok ${n} - ${name}`); }
  catch (e) { console.log(`not ok ${n} - ${name}\n  ${e.message}`); process.exitCode = 1; }
}

/** Fresh copy of the plugin with `env` applied: the module reads TGA_* at load
 *  time, so each case needs its own instance — hence the cache-busting query. */
let seq = 0;
async function loadGuard(env) {
  const saved = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  try {
    const mod = await import(`${PLUGIN}?case=${++seq}`);
    return await mod.TelegramAgentsGuard({ directory: __dirname });
  } finally {
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

/** Fake bot: answers every request with `decision`, and counts the calls. */
function fakeBot(decision, reason = 'test') {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      calls.push(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ decision, reason }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      calls,
      url: `http://127.0.0.1:${server.address().port}/approve`,
      // undici keeps the socket alive, and server.close() waits for it -- so
      // drop connections first or the test process never exits.
      close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }),
    }));
  });
}

const BASE = { TGA_APP_DIR: __dirname, TGA_APPROVE_TOKEN: 'tok', TGA_CHAT: '1', TGA_APPROVE_TIMEOUT_SEC: '5' };
const DANGEROUS = { tool: 'bash', args: { command: 'rm -rf /home/user/notes' } };
const HARMLESS = { tool: 'read', args: { filePath: '/home/user/telegram-agents/README.md' } };

const call = (hooks, t) => hooks['tool.execute.before']({ tool: t.tool, sessionID: 's', callID: 'c' }, { args: t.args });
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };

// Every fake server, closed at the end whatever the cases did.
const openServers = [];
const track = (s) => { openServers.push(s); return s; };

(async () => {
  await test('the factory survives being called with no context (kilo does)', async () => {
    // Regression: kilo 7.4.22 calls the factory once with no argument. When the
    // parameter was destructured this threw, and kilo dropped the plugin
    // without a word in the log -- the CLI then ran completely unguarded.
    const saved = process.env.TGA_GUARD;
    process.env.TGA_GUARD = 'smart';
    try {
      const mod = await import(`${PLUGIN}?case=noctx`);
      const hooks = await mod.TelegramAgentsGuard();
      assert.deepStrictEqual(Object.keys(hooks), ['tool.execute.before']);
    } finally {
      if (saved === undefined) delete process.env.TGA_GUARD; else process.env.TGA_GUARD = saved;
    }
  });

  await test('guard=none leaves no hook at all (inert for a human at the keyboard)', async () => {
    const hooks = await loadGuard({ ...BASE, TGA_GUARD: 'none', TGA_APPROVE_URL: 'http://127.0.0.1:1/approve' });
    assert.deepStrictEqual(Object.keys(hooks), []);
  });

  await test('guard unset behaves like none', async () => {
    const hooks = await loadGuard({ ...BASE, TGA_GUARD: undefined, TGA_APPROVE_URL: undefined });
    assert.deepStrictEqual(Object.keys(hooks), []);
  });

  await test('smart: a harmless read never reaches the owner', async () => {
    const bot = track(await fakeBot('deny'));
    const hooks = await loadGuard({ ...BASE, TGA_GUARD: 'smart', TGA_APPROVE_URL: bot.url });
    await call(hooks, HARMLESS);
    assert.strictEqual(bot.calls.length, 0);
    await bot.close();
  });

  await test('smart: rm outside /tmp asks, and "allow" lets it through', async () => {
    const bot = track(await fakeBot('allow'));
    const hooks = await loadGuard({ ...BASE, TGA_GUARD: 'smart', TGA_APPROVE_URL: bot.url });
    await call(hooks, DANGEROUS);
    assert.strictEqual(bot.calls.length, 1);
    const c = bot.calls[0];
    assert.strictEqual(c.token, 'tok');
    assert.strictEqual(c.chatId, '1');
    assert.strictEqual(c.payload.tool_name, 'Bash');          // normalized to Claude vocabulary
    assert.match(c.payload.tool_input.command, /rm -rf/);
    assert.ok(c.why, 'a reason is sent along');
    await bot.close();
  });

  await test('smart: "deny" aborts the tool call with the owner\'s reason', async () => {
    const bot = track(await fakeBot('deny', 'nope, not that one'));
    const hooks = await loadGuard({ ...BASE, TGA_GUARD: 'smart', TGA_APPROVE_URL: bot.url });
    const e = await rejects(call(hooks, DANGEROUS));
    assert.ok(e && /nope, not that one/.test(e.message), String(e && e.message));
    await bot.close();
  });

  await test('all: everything asks except TGA_AUTO_ALLOW', async () => {
    const bot = track(await fakeBot('allow'));
    const hooks = await loadGuard({ ...BASE, TGA_GUARD: 'all', TGA_AUTO_ALLOW: 'Read', TGA_APPROVE_URL: bot.url });
    await call(hooks, HARMLESS);
    assert.strictEqual(bot.calls.length, 0, 'Read is auto-allowed');
    await call(hooks, { tool: 'write', args: { filePath: '/home/user/x' } });
    assert.strictEqual(bot.calls.length, 1, 'Write is not');
    await bot.close();
  });

  // --- fail closed ---------------------------------------------------------
  await test('bot unreachable denies instead of running the tool', async () => {
    const hooks = await loadGuard({ ...BASE, TGA_GUARD: 'smart', TGA_APPROVE_URL: 'http://127.0.0.1:1/approve' });
    const e = await rejects(call(hooks, DANGEROUS));
    assert.ok(e && /could not reach the owner/.test(e.message), String(e && e.message));
  });

  await test('HTTP error from the bot denies', async () => {
    const server = http.createServer((req, res) => { res.writeHead(500).end('boom'); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const hooks = await loadGuard({ ...BASE, TGA_GUARD: 'smart', TGA_APPROVE_URL: `http://127.0.0.1:${server.address().port}/approve` });
    const e = await rejects(call(hooks, DANGEROUS));
    assert.ok(e && /HTTP 500/.test(e.message), String(e && e.message));
    await new Promise((r) => { server.closeAllConnections(); server.close(r); });
  });

  await test('no approval URL denies (a guarded run must never fall back to allow)', async () => {
    const hooks = await loadGuard({ ...BASE, TGA_GUARD: 'smart', TGA_APPROVE_URL: undefined });
    const e = await rejects(call(hooks, DANGEROUS));
    assert.ok(e && /not configured/.test(e.message), String(e && e.message));
  });

  await test('missing TGA_APP_DIR denies every call, not just dangerous ones', async () => {
    const hooks = await loadGuard({ ...BASE, TGA_APP_DIR: undefined, TGA_GUARD: 'smart', TGA_APPROVE_URL: 'http://127.0.0.1:1/approve' });
    const e = await rejects(call(hooks, HARMLESS));
    assert.ok(e && /approval gate broken/.test(e.message), String(e && e.message));
  });

  for (const s of openServers) await s.close();
  console.log(`1..${n}`);
})();
