'use strict';
/*
 * Attachments.
 *
 * The agents read files, not Telegram updates, so anything you send is fetched
 * to a temp file and the prompt points at the path. A screenshot with a caption
 * becomes "<caption>\n\n[image: /tmp/.../shot.jpg]" — Claude Code opens it the
 * same way it opens any other file you name.
 *
 * Telegram caps a bot download at 20 MB and only keeps file_path valid for an
 * hour, so files are pulled the moment the message arrives, not lazily.
 *
 * Albums arrive as SEPARATE updates sharing a media_group_id. Firing one turn
 * per photo would be maddening, so a group is held for a moment and delivered
 * as a single prompt.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = path.join(os.tmpdir(), 'telegram-agents-media');
const MAX_BYTES = 20 * 1024 * 1024;      // the Bot API's own download limit
const KEEP_MS = 24 * 60 * 60 * 1000;     // how long a fetched file stays around
const GROUP_WAIT_MS = 1500;              // how long to wait for the rest of an album

/** What kind of attachment is this, and which file_id do we fetch? */
function describe(msg) {
  if (msg.photo && msg.photo.length) {
    // Sizes ascend; the last one is the original.
    const best = msg.photo[msg.photo.length - 1];
    return { kind: 'image', fileId: best.file_id, name: 'image.jpg', size: best.file_size };
  }
  if (msg.document) {
    return {
      kind: (msg.document.mime_type || '').startsWith('image/') ? 'image' : 'file',
      fileId: msg.document.file_id,
      name: msg.document.file_name || 'file',
      size: msg.document.file_size,
    };
  }
  if (msg.video) return { kind: 'video', fileId: msg.video.file_id, name: 'video.mp4', size: msg.video.file_size };
  if (msg.voice) return { kind: 'voice', fileId: msg.voice.file_id, name: 'voice.ogg', size: msg.voice.file_size };
  if (msg.audio) return { kind: 'audio', fileId: msg.audio.file_id, name: msg.audio.file_name || 'audio', size: msg.audio.file_size };
  if (msg.sticker) return { kind: 'sticker', fileId: msg.sticker.file_id, name: 'sticker.webp', size: msg.sticker.file_size };
  if (msg.animation) return { kind: 'animation', fileId: msg.animation.file_id, name: 'animation.mp4', size: msg.animation.file_size };
  return null;
}

/** Does this message carry anything worth fetching? */
const hasMedia = (msg) => !!describe(msg);

/** Keep one filename per file, safe to hand to a shell-quoting agent. */
function safeName(name) {
  const base = path.basename(String(name)).replace(/[^\w.\- ]+/g, '_').slice(-80);
  return base || 'file';
}

module.exports = function makeMedia({ tg, apiBase, token, log }) {
  /* Old files are swept on the way in rather than on a timer: this only runs
   * when something is actually downloaded, and a bot that never receives a file
   * should not be spinning anything. */
  function sweep() {
    let removed = 0;
    try {
      for (const f of fs.readdirSync(DIR)) {
        const p = path.join(DIR, f);
        try {
          if (Date.now() - fs.statSync(p).mtimeMs > KEEP_MS) { fs.rmSync(p, { recursive: true, force: true }); removed++; }
        } catch (_) {}
      }
    } catch (_) {}
    return removed;
  }

  /**
   * Fetch one attachment. Returns { kind, path, name } or throws with a message
   * worth showing — "too big" is a normal outcome, not a crash.
   */
  async function fetchOne(msg) {
    const d = describe(msg);
    if (!d) return null;
    if (d.size && d.size > MAX_BYTES) {
      const err = new Error(`too big (${Math.round(d.size / 1048576)} MB, the Bot API stops at 20 MB)`);
      err.tooBig = true;
      throw err;
    }

    const file = await tg('getFile', { file_id: d.fileId });
    if (!file.file_path) throw new Error('Telegram returned no file_path');

    fs.mkdirSync(DIR, { recursive: true });
    sweep();

    // Telegram photos have no filename of their own, so `describe` guesses one.
    // file_path knows the real format — trust it for the extension, and report
    // the corrected name rather than claiming a .jpg that is really a .png.
    const ext = path.extname(file.file_path) || path.extname(d.name);
    const stem = safeName(d.name).replace(/\.[^.]*$/, '');
    const shown = ext ? `${stem}${ext}` : stem;
    const dest = path.join(DIR, `${msg.message_id}-${shown}`);

    const res = await fetch(`${apiBase}/file/bot${token}/${file.file_path}`, {
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) {
      const err = new Error('too big');
      err.tooBig = true;
      throw err;
    }
    fs.writeFileSync(dest, buf, { mode: 0o600 });
    log('info', `media: ${d.kind} -> ${dest} (${buf.length} bytes)`);
    return { kind: d.kind, path: dest, name: shown };
  }

  /* --- albums ------------------------------------------------------------ */
  /* media_group_id -> { items, timer, resolve }. One update per photo arrives
   * within milliseconds of the others, so a short wait collects the whole set
   * and the caption (Telegram puts it on exactly one of them). */
  const groups = new Map();

  /**
   * Collect an album. Resolves for the FIRST message of the group with every
   * attachment gathered, and resolves null for the others so the caller knows
   * to drop them.
   */
  function collect(msg, onReady) {
    const id = msg.media_group_id;
    if (!id) return false;
    let g = groups.get(id);
    if (!g) {
      g = { msgs: [], timer: null };
      groups.set(id, g);
    }
    g.msgs.push(msg);
    if (g.timer) clearTimeout(g.timer);
    g.timer = setTimeout(() => {
      groups.delete(id);
      onReady(g.msgs);
    }, GROUP_WAIT_MS);
    return true;
  }

  return { DIR, hasMedia, describe, fetchOne, collect, sweep, GROUP_WAIT_MS };
};

module.exports.hasMedia = hasMedia;
module.exports.describe = describe;
module.exports.safeName = safeName;
module.exports.DIR = DIR;
module.exports.MAX_BYTES = MAX_BYTES;
