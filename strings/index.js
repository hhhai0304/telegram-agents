'use strict';
/*
 * Locale loader. TGA_LANG picks the catalogue; English is the default and
 * the fallback for any key a translation leaves out.
 *
 * Adding a language: copy strings/en.js to strings/<code>.js, translate the
 * values, and set TGA_LANG=<code> in config.env. Keys you skip keep their
 * English text rather than breaking.
 */

const en = require('./en.js');

const code = String(process.env.TGA_LANG || process.env.CLAUDE_TG_LANG || 'en').toLowerCase().trim();

let locale = en;
if (code && code !== 'en') {
  try { locale = { ...en, ...require(`./${code}.js`) }; }
  catch (e) { console.error(`WARN unknown TGA_LANG "${code}", falling back to en`); }
}

/* Risk reasons arrive from risk.js in English, sometimes prefixed by a script
 * name ("deploy.sh: delete files"). Translate the part after the colon and keep
 * the prefix; anything unknown passes through unchanged. */
function reason(why) {
  if (!why) return why;
  const map = locale.reasons || {};
  if (map[why]) return map[why];
  const i = why.indexOf(': ');
  if (i > 0) {
    const tail = why.slice(i + 2);
    if (map[tail]) return `${why.slice(0, i)}: ${map[tail]}`;
  }
  return why;
}

module.exports = { ...locale, reason };
