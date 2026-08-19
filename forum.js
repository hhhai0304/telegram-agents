'use strict';
/*
 * Forum-topic routing.
 *
 * A Telegram supergroup with Topics enabled gives every conversation its own
 * thread. This module maps one topic to one agent session, so several sessions
 * can run side by side in a single group instead of fighting over one chat.
 *
 * The General topic (no message_thread_id) is the hub: it lists the topics,
 * creates new ones and restores the ones that were deleted.
 *
 * Everything is addressed by a KEY:
 *
 *   "<chatId>"            private chat, or the General topic of a forum
 *   "<chatId>:<threadId>" one topic inside a forum
 *
 * Keys are what bot.js already used chat ids for — state, queue and running
 * jobs are all keyed by them, so a topic is a first-class conversation with its
 * own cwd, agent, model and session id.
 *
 * The registry (state.topics) is the source of truth for restore. A deleted
 * topic loses its Telegram messages but keeps its record, so "restore" means:
 * create a fresh topic, move the stored session state onto the new key, resume.
 */

/** Key for an incoming message. Falsy/absent thread id means General. */
function keyOf(chatId, threadId) {
  return threadId ? `${chatId}:${threadId}` : String(chatId);
}

/** Split a key back into Bot API parameters. */
function route(key) {
  const s = String(key);
  const i = s.indexOf(':');
  if (i < 0) return { chat_id: s };
  return { chat_id: s.slice(0, i), message_thread_id: Number(s.slice(i + 1)) };
}

const chatIdOf = (key) => route(key).chat_id;
const threadOf = (key) => route(key).message_thread_id || 0;
const isTopic = (key) => threadOf(key) !== 0;

/* Telegram numbers the General topic 1 when it bothers to number it at all.
 * Messages posted there carry no message_thread_id, so treat 1 as General too
 * — otherwise a reply inside General would open a second, phantom session. */
const GENERAL = 1;

module.exports = function makeForum({ tg, state, saveState, log }) {
  if (!state.topics) state.topics = {};

  /** Registry for one group: { "<threadId>": {name, status, createdAt, lastAt} } */
  function registry(chatId) {
    return state.topics[String(chatId)] || {};
  }

  /* Same, but creates the entry. Only the write paths use it — a plain lookup
   * must not leave an empty registry behind for every private chat that ever
   * sends a message. */
  function registryFor(chatId) {
    const k = String(chatId);
    return state.topics[k] || (state.topics[k] = {});
  }

  /** Remember a topic we created, or one a human created and then posted in. */
  function register(chatId, threadId, name, status = 'open') {
    if (!threadId || threadId === GENERAL) return null;
    const reg = registryFor(chatId);
    const id = String(threadId);
    const prev = reg[id] || {};
    reg[id] = {
      name: name || prev.name || `topic ${id}`,
      status,
      createdAt: prev.createdAt || Date.now(),
      lastAt: Date.now(),
    };
    saveState();
    return reg[id];
  }

  function touch(chatId, threadId) {
    if (!threadId || threadId === GENERAL) return;
    const rec = registry(chatId)[String(threadId)];
    if (rec) { rec.lastAt = Date.now(); saveState(); }
  }

  function get(chatId, threadId) {
    return registry(chatId)[String(threadId)] || null;
  }

  /** Topics of one group, newest activity first. */
  function list(chatId) {
    return Object.entries(registry(chatId))
      .map(([id, rec]) => ({ threadId: Number(id), ...rec }))
      .sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
  }

  function forget(chatId, threadId) {
    const reg = registry(chatId);
    const id = String(threadId);
    if (!reg[id]) return false;
    delete reg[id];
    saveState();
    return true;
  }

  /* --- is this chat actually a forum? ----------------------------------- */
  /* getChat is a network round trip, so the answer is cached. A group can be
   * switched to a forum after the bot joined, which is why the cache is only
   * populated on a positive answer plus a short-lived negative. */
  const forumCache = new Map(); // chatId -> { value, at }
  const NEG_TTL = 60000;

  async function isForum(chatId) {
    const k = String(chatId);
    if (!k.startsWith('-')) return false;             // private chats never are
    const hit = forumCache.get(k);
    if (hit && (hit.value || Date.now() - hit.at < NEG_TTL)) return hit.value;
    let value = false;
    try {
      const chat = await tg('getChat', { chat_id: k }, { retries: 1 });
      value = !!chat.is_forum;
    } catch (e) {
      log('warn', `getChat(${k}) failed: ${e.message}`);
    }
    forumCache.set(k, { value, at: Date.now() });
    return value;
  }

  /* --- Telegram side ---------------------------------------------------- */

  /* Icon colours Telegram accepts for a topic. Cycled so adjacent sessions are
   * visually distinct in the topic list. */
  const COLORS = [0x6FB9F0, 0xFFD67E, 0xCB86DB, 0x8EEE98, 0xFF93B2, 0xFB6F5F];

  async function create(chatId, name) {
    const n = Object.keys(registry(chatId)).length;
    const topic = await tg('createForumTopic', {
      chat_id: String(chatId),
      name: String(name).slice(0, 128),
      icon_color: COLORS[n % COLORS.length],
    });
    register(chatId, topic.message_thread_id, topic.name);
    return topic;
  }

  async function rename(chatId, threadId, name) {
    await tg('editForumTopic', {
      chat_id: String(chatId), message_thread_id: Number(threadId), name: String(name).slice(0, 128),
    });
    const rec = get(chatId, threadId);
    if (rec) { rec.name = name; saveState(); }
  }

  /** Close = archive. Telegram keeps the messages; the session state stays too. */
  async function close(chatId, threadId) {
    await tg('closeForumTopic', { chat_id: String(chatId), message_thread_id: Number(threadId) });
    const rec = get(chatId, threadId);
    if (rec) { rec.status = 'closed'; rec.lastAt = Date.now(); saveState(); }
  }

  async function reopen(chatId, threadId) {
    await tg('reopenForumTopic', { chat_id: String(chatId), message_thread_id: Number(threadId) });
    const rec = get(chatId, threadId);
    if (rec) { rec.status = 'open'; rec.lastAt = Date.now(); saveState(); }
  }

  /**
   * Drop = delete the topic and every message in it. The registry entry and the
   * session state survive on purpose: that is what makes restore possible.
   */
  async function drop(chatId, threadId) {
    await tg('deleteForumTopic', { chat_id: String(chatId), message_thread_id: Number(threadId) });
    const rec = get(chatId, threadId);
    if (rec) { rec.status = 'gone'; rec.lastAt = Date.now(); saveState(); }
  }

  /**
   * Restore a dropped topic: a deleted thread id can never come back, so this
   * creates a new one and hands the old key's state over to it. Returns
   * { topic, fromKey, toKey } so the caller can move the conversation state.
   */
  async function restore(chatId, threadId) {
    const rec = get(chatId, threadId);
    if (!rec) return null;
    const topic = await create(chatId, rec.name);
    const fromKey = keyOf(chatId, threadId);
    const toKey = keyOf(chatId, topic.message_thread_id);
    forget(chatId, threadId);
    return { topic, fromKey, toKey };
  }

  return {
    keyOf, route, chatIdOf, threadOf, isTopic, GENERAL,
    isForum, registry, register, touch, get, list, forget,
    create, rename, close, reopen, drop, restore,
  };
};

module.exports.keyOf = keyOf;
module.exports.route = route;
module.exports.chatIdOf = chatIdOf;
module.exports.threadOf = threadOf;
module.exports.isTopic = isTopic;
module.exports.GENERAL = GENERAL;
