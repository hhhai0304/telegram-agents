#!/usr/bin/env node
'use strict';
/*
 * Tests for forum.js — key routing and the topic registry.
 *
 * The Telegram side is a fake `tg` that records calls and replies the way the
 * Bot API does, so create/close/drop/restore are exercised without a network.
 */

const assert = require('assert');
const makeForum = require('./forum.js');

let n = 0, failed = 0;
function test(name, fn) {
  n++;
  try { fn(); console.log(`ok ${n} - ${name}`); }
  catch (e) { failed++; console.log(`not ok ${n} - ${name}\n  ${e.message}`); }
}
async function atest(name, fn) {
  n++;
  try { await fn(); console.log(`ok ${n} - ${name}`); }
  catch (e) { failed++; console.log(`not ok ${n} - ${name}\n  ${e.message}`); }
}

const { keyOf, route, chatIdOf, threadOf, isTopic } = makeForum;

// --- keys ------------------------------------------------------------------

test('a private chat keeps its bare id as the key', () => {
  assert.strictEqual(keyOf('878600413', undefined), '878600413');
  assert.strictEqual(keyOf('878600413', 0), '878600413');
  assert.strictEqual(isTopic('878600413'), false);
  assert.deepStrictEqual(route('878600413'), { chat_id: '878600413' });
});

test('a topic key carries the thread id', () => {
  const k = keyOf('-1001234567890', 42);
  assert.strictEqual(k, '-1001234567890:42');
  assert.strictEqual(chatIdOf(k), '-1001234567890');
  assert.strictEqual(threadOf(k), 42);
  assert.ok(isTopic(k));
  assert.deepStrictEqual(route(k), { chat_id: '-1001234567890', message_thread_id: 42 });
});

test('route survives the negative chat id of a supergroup', () => {
  // The leading "-" must not be mistaken for the key separator.
  assert.deepStrictEqual(route('-1001234567890'), { chat_id: '-1001234567890' });
});

// --- registry --------------------------------------------------------------

function fixture(handlers = {}) {
  const calls = [];
  const state = { offset: 0, chats: {}, topics: {} };
  let nextThread = 100;
  const tg = async (method, body) => {
    calls.push({ method, body });
    if (handlers[method]) return handlers[method](body);
    if (method === 'createForumTopic') return { message_thread_id: ++nextThread, name: body.name };
    if (method === 'getChat') return { is_forum: true };
    return true;
  };
  const forum = makeForum({ tg, state, saveState() {}, log() {} });
  return { forum, state, calls };
}

const CHAT = '-1001234567890';

test('register ignores General', () => {
  const { forum, state } = fixture();
  assert.strictEqual(forum.register(CHAT, 1, 'General'), null);
  assert.strictEqual(forum.register(CHAT, 0, 'nope'), null);
  assert.deepStrictEqual(forum.list(CHAT), []);
  // And a refused register leaves no registry behind at all: a plain lookup
  // must not litter state.topics with an empty object per chat.
  assert.strictEqual(state.topics[CHAT], undefined);
});

test('register keeps the original createdAt when a topic is seen again', () => {
  const { forum } = fixture();
  const first = forum.register(CHAT, 7, 'build');
  const again = forum.register(CHAT, 7, undefined);
  assert.strictEqual(again.createdAt, first.createdAt);
  assert.strictEqual(again.name, 'build', 'a nameless re-register must not wipe the name');
});

test('list is newest-activity first', () => {
  const { forum, state } = fixture();
  forum.register(CHAT, 1001, 'old');
  forum.register(CHAT, 1002, 'new');
  state.topics[CHAT]['1001'].lastAt = 1;
  state.topics[CHAT]['1002'].lastAt = 2;
  assert.deepStrictEqual(forum.list(CHAT).map((t) => t.name), ['new', 'old']);
});

test('reading does not create a registry', () => {
  const { forum, state } = fixture();
  forum.get(CHAT, 7);
  forum.list(CHAT);
  forum.touch(CHAT, 7);
  assert.deepStrictEqual(state.topics, {}, 'a read left an entry behind');
});

test('registries are per group', () => {
  const { forum } = fixture();
  forum.register(CHAT, 5, 'a');
  forum.register('-100999', 5, 'b');
  assert.strictEqual(forum.get(CHAT, 5).name, 'a');
  assert.strictEqual(forum.get('-100999', 5).name, 'b');
});

// --- Telegram side ---------------------------------------------------------

(async () => {
  await atest('create registers the topic Telegram actually made', async () => {
    const { forum, calls } = fixture();
    const t = await forum.create(CHAT, 'deploy');
    assert.strictEqual(t.message_thread_id, 101);
    assert.strictEqual(calls[0].method, 'createForumTopic');
    assert.strictEqual(calls[0].body.chat_id, CHAT);
    assert.ok(typeof calls[0].body.icon_color === 'number');
    assert.strictEqual(forum.get(CHAT, 101).status, 'open');
  });

  await atest('names longer than Telegram allows are cut, not rejected', async () => {
    const { forum, calls } = fixture();
    await forum.create(CHAT, 'x'.repeat(500));
    assert.strictEqual(calls[0].body.name.length, 128);
  });

  await atest('close and reopen flip the status', async () => {
    const { forum } = fixture();
    await forum.create(CHAT, 'a');
    await forum.close(CHAT, 101);
    assert.strictEqual(forum.get(CHAT, 101).status, 'closed');
    await forum.reopen(CHAT, 101);
    assert.strictEqual(forum.get(CHAT, 101).status, 'open');
  });

  await atest('drop keeps the record so the session can come back', async () => {
    const { forum } = fixture();
    await forum.create(CHAT, 'a');
    await forum.drop(CHAT, 101);
    assert.strictEqual(forum.get(CHAT, 101).status, 'gone');
  });

  await atest('restore opens a NEW topic and hands over the old key', async () => {
    const { forum } = fixture();
    await forum.create(CHAT, 'refactor');
    await forum.drop(CHAT, 101);
    const moved = await forum.restore(CHAT, 101);
    assert.strictEqual(moved.fromKey, `${CHAT}:101`);
    assert.strictEqual(moved.toKey, `${CHAT}:102`);
    assert.strictEqual(moved.topic.name, 'refactor', 'the restored topic keeps its name');
    assert.strictEqual(forum.get(CHAT, 101), null, 'the dead thread id is forgotten');
    assert.strictEqual(forum.get(CHAT, 102).status, 'open');
  });

  await atest('restoring something unknown is a no-op, not a crash', async () => {
    const { forum } = fixture();
    assert.strictEqual(await forum.restore(CHAT, 999), null);
  });

  await atest('isForum caches a positive answer', async () => {
    const { forum, calls } = fixture();
    assert.strictEqual(await forum.isForum(CHAT), true);
    assert.strictEqual(await forum.isForum(CHAT), true);
    assert.strictEqual(calls.filter((c) => c.method === 'getChat').length, 1);
  });

  await atest('a private chat is never a forum, and costs no getChat', async () => {
    const { forum, calls } = fixture();
    assert.strictEqual(await forum.isForum('878600413'), false);
    assert.strictEqual(calls.length, 0);
  });

  await atest('a failing getChat means "not a forum", not a thrown error', async () => {
    const { forum } = fixture({ getChat: () => { throw new Error('chat not found'); } });
    assert.strictEqual(await forum.isForum(CHAT), false);
  });

  console.log(`1..${n}`);
  if (failed) process.exitCode = 1;
})();
