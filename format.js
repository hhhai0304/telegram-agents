'use strict';
/*
 * Markdown -> Telegram HTML.
 *
 * The Bot API renders HTML or MarkdownV2, never plain Markdown: an agent's
 * `**bold**`, `#` headings and ``` fences arrive as literal punctuation and
 * read as noise. Agents write Markdown, so the bridge translates on the way
 * out rather than asking every model to remember where its output is going.
 *
 * Only the subset Telegram can actually draw is converted. Tables are left as
 * typed text -- the Bot API has no table entity, and a half-converted one is
 * worse than the source.
 */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
const escapeHtml = (s) => s.replace(/[&<>]/g, (c) => ESCAPES[c]);

/* A cut inside a tag would corrupt the message, so the chunker only ever breaks
 * between tags; `links` keeps the href, which the tag name alone would lose. */
const TAG_RE = /<(\/?)([a-z]+)((?:"[^"]*"|[^>])*)>/g;

/** Tags left open at the end of `html`, innermost last, as their source text. */
function openTags(html) {
  const open = [];
  TAG_RE.lastIndex = 0;
  let m;
  while ((m = TAG_RE.exec(html)) !== null) {
    const [, closing, name, attrs] = m;
    if (closing) {
      for (let i = open.length - 1; i >= 0; i--) {
        if (open[i].name === name) { open.splice(i, 1); break; }
      }
    } else if (!attrs.trim().endsWith('/')) {
      open.push({ name, tag: m[0] });
    }
  }
  return open;
}

/**
 * Split rendered HTML into pieces of at most `size` characters.
 *
 * Every tag still open at a cut is closed at the end of the piece and reopened
 * at the start of the next one, so each message stands on its own. Cuts prefer
 * a line break, then back off to the start of a tag rather than land inside it.
 */
function chunkHtml(html, size = 3800) {
  const out = [];
  let rest = String(html);
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size);
    if (cut < size * 0.5) cut = size;
    const lastOpen = rest.lastIndexOf('<', cut);
    if (lastOpen > rest.lastIndexOf('>', cut)) cut = lastOpen;
    if (cut <= 0) cut = size;

    const head = rest.slice(0, cut);
    const open = openTags(head);
    out.push(head + open.map((t) => `</${t.name}>`).reverse().join(''));
    rest = open.map((t) => t.tag).join('') + rest.slice(cut).replace(/^\n/, '');
  }
  if (rest.trim()) out.push(rest);
  return out;
}

/**
 * Render Markdown as the subset of HTML the Bot API accepts.
 *
 * Code spans and fences are lifted out first: their contents are literal, so a
 * `**` inside a snippet must stay punctuation. Emphasis is only recognised at
 * word boundaries -- `a*b*c` and `file_name_here` are text, not formatting.
 */
function renderMarkdown(src) {
  const store = [];
  const stash = (html) => `\u0000${store.push(html) - 1}\u0000`;

  let s = escapeHtml(String(src == null ? '' : src).replace(/\r\n?/g, '\n'));

  s = s.replace(/```[^\n]*\n?([\s\S]*?)(?:```|$)/g, (_, body) => stash(`<pre>${body.replace(/\n$/, '')}</pre>`));
  s = s.replace(/`([^`\n]+)`/g, (_, body) => stash(`<code>${body}</code>`));

  s = s.replace(/^#{1,6}[ \t]+(.+?)[ \t]*$/gm, '<b>$1</b>');
  s = s.replace(/\*\*([^\n]+?)\*\*/g, '<b>$1</b>');
  s = s.replace(/__([^\n]+?)__/g, '<b>$1</b>');
  s = s.replace(/~~([^\n]+?)~~/g, '<s>$1</s>');
  s = s.replace(/(?<![\w*])\*([^\s*](?:[^*\n]*[^\s*])?)\*(?![\w*])/g, '<i>$1</i>');
  s = s.replace(/(?<![\w_])_([^\s_](?:[^_\n]*[^\s_])?)_(?![\w_])/g, '<i>$1</i>');
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
  s = s.replace(/^([ \t]*)[-*+][ \t]+/gm, '$1\u2022 ');

  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => store[Number(i)]);
}

module.exports = { renderMarkdown, chunkHtml, escapeHtml, openTags };
