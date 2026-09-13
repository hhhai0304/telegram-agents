#!/usr/bin/env node
'use strict';
/* Unit tests for the Markdown -> Telegram HTML renderer and its chunker.
 * No network, no CLIs needed. Run: node test-format.js */

const assert = require('assert');
const { renderMarkdown, chunkHtml, escapeHtml, openTags } = require('./format.js');

let n = 0;
function test(name, fn) { n++; try { fn(); console.log(`ok ${n} - ${name}`); } catch (e) { console.log(`not ok ${n} - ${name}\n  ${e.message}`); process.exitCode = 1; } }

const strip = (html) => html.replace(/<[^>]+>/g, '');
const balanced = (html) => { assert.deepStrictEqual(openTags(html), [], `unbalanced: ${html}`); };

// ------------------------------------------------------------- escaping ---
test('escapeHtml covers the three characters Telegram parses', () => {
  assert.strictEqual(escapeHtml('a & b < c > d'), 'a &amp; b &lt; c &gt; d');
});
test('renderMarkdown escapes text and leaves it readable', () => {
  assert.strictEqual(renderMarkdown('if (a < b && c > d)'), 'if (a &lt; b &amp;&amp; c &gt; d)');
});
test('renderMarkdown tolerates empty input', () => {
  assert.strictEqual(renderMarkdown(''), '');
  assert.strictEqual(renderMarkdown(null), '');
  assert.strictEqual(renderMarkdown(undefined), '');
});

// ------------------------------------------------------------ emphasis ---
test('bold, strike and italic render to their HTML tags', () => {
  assert.strictEqual(renderMarkdown('**bold**'), '<b>bold</b>');
  assert.strictEqual(renderMarkdown('__bold__'), '<b>bold</b>');
  assert.strictEqual(renderMarkdown('~~gone~~'), '<s>gone</s>');
  assert.strictEqual(renderMarkdown('*slanted*'), '<i>slanted</i>');
  assert.strictEqual(renderMarkdown('_slanted_'), '<i>slanted</i>');
});
test('emphasis inside a sentence keeps the surrounding text', () => {
  assert.strictEqual(renderMarkdown('this is **very** important'), 'this is <b>very</b> important');
});
test('word-internal markers are text, not formatting', () => {
  assert.strictEqual(renderMarkdown('a*b*c'), 'a*b*c');
  assert.strictEqual(renderMarkdown('file_name_here'), 'file_name_here');
  assert.strictEqual(renderMarkdown('src/**/*.js'), 'src/**/*.js');
});
test('headings become bold lines', () => {
  assert.strictEqual(renderMarkdown('## Summary'), '<b>Summary</b>');
  assert.strictEqual(renderMarkdown('#hashtag'), '#hashtag');
});
test('list markers become bullets', () => {
  assert.strictEqual(renderMarkdown('- one\n- two'), '\u2022 one\n\u2022 two');
  assert.strictEqual(renderMarkdown('* one'), '\u2022 one');
  assert.strictEqual(renderMarkdown('---'), '---');
});
test('links keep their href', () => {
  assert.strictEqual(
    renderMarkdown('see [the docs](https://example.com/a?b=1)'),
    'see <a href="https://example.com/a?b=1">the docs</a>',
  );
});

// ---------------------------------------------------------------- code ---
test('inline code is escaped inside <code>', () => {
  assert.strictEqual(renderMarkdown('run `a < b` now'), 'run <code>a &lt; b</code> now');
});
test('fenced blocks become <pre> and keep their contents literal', () => {
  const html = renderMarkdown('before\n```js\nconst x = **1** < 2;\n```\nafter');
  assert.strictEqual(html, 'before\n<pre>const x = **1** &lt; 2;</pre>\nafter');
});
test('an unterminated fence still renders as code', () => {
  assert.strictEqual(renderMarkdown('```\nnpm test'), '<pre>npm test</pre>');
});

// -------------------------------------------------------------- chunking ---
test('chunkHtml leaves short input untouched', () => {
  assert.deepStrictEqual(chunkHtml('<b>hi</b>', 100), ['<b>hi</b>']);
});
test('chunkHtml keeps every piece balanced and loses no text', () => {
  const html = `<b>${'x'.repeat(120)}</b>`;
  const parts = chunkHtml(html, 40);
  assert.ok(parts.length > 1, 'expected a split');
  for (const p of parts) balanced(p);
  assert.strictEqual(parts.map(strip).join(''), 'x'.repeat(120));
});
test('chunkHtml reopens a tag that spans the cut', () => {
  const parts = chunkHtml(`<b>${'y'.repeat(60)}</b>`, 30);
  for (const p of parts) balanced(p);
  assert.ok(parts[1].startsWith('<b>'), 'second piece reopens the tag');
});
test('chunkHtml never cuts inside a tag', () => {
  const href = `https://example.com/${'p'.repeat(60)}`;
  const parts = chunkHtml(`<a href="${href}">${'z'.repeat(80)}</a>`, 45);
  for (const p of parts) {
    balanced(p);
    assert.ok(!/<[a-z]*$/.test(p), `truncated tag: ${p.slice(-20)}`);
  }
});
test('chunkHtml splits on a line break when one is near', () => {
  const parts = chunkHtml(`${'a'.repeat(20)}\n${'b'.repeat(50)}`, 30);
  assert.strictEqual(parts[0], 'a'.repeat(20));
});

console.log(`1..${n}`);
