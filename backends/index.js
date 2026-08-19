'use strict';
/*
 * Backend registry. A backend is a coding-agent CLI the bot can drive.
 *
 * Every backend module exports the same small interface (see claude.js for the
 * reference implementation and comments):
 *
 *   id            'claude' | 'opencode' | 'kilo' | 'kiro'  — used in /agent and state
 *   name          human label
 *   bin           executable name; overridable with TGA_<ID>_BIN
 *   models        [] = free text via `/model <name>`; non-empty = buttons
 *   modelsOpen    true  = the buttons are a shortlist, `/model <anything>` still works
 *   defaultModel  '' = don't pass a model flag, let the CLI decide
 *   efforts       null = the CLI has no effort knob
 *   guard         true  = the tool-approval gate (approve-hook.js) works here
 *   sessions      true  = listSessions() can enumerate transcripts on disk
 *   stdinPrompt   true  = pipe the prompt on stdin, false = pass it as an argument
 *   buildArgs(ctx)        -> { args, env }
 *   listSessions(cwd, n)  -> [{ id, title, mtime }]
 *   createParser(emit)    -> { feed(str), end() }  emitting normalized events:
 *       { type: 'session', id }
 *       { type: 'text', text }
 *       { type: 'tool', name, input }        name/input in Claude Code vocabulary
 *       { type: 'result', costUsd, isError, text, denials }
 *   isSessionGone(stderr, code) -> true when the resume id is stale
 *   sessionLabel(id)      -> short label for the UI
 *
 * bot.js never touches CLI flags or output formats itself.
 */

const fs = require('fs');
const path = require('path');

const ALL = [
  require('./claude.js'),
  require('./opencode.js'),
  require('./kilo.js'),
  require('./kiro.js'),
];

const byId = Object.fromEntries(ALL.map((b) => [b.id, b]));

/** Resolve the executable for a backend: TGA_<ID>_BIN wins, else its default. */
function binFor(b) {
  return process.env[`TGA_${b.id.toUpperCase()}_BIN`] || b.bin;
}

/** Is the executable reachable? Absolute paths are stat'ed, names are searched on PATH. */
function isInstalled(b) {
  const bin = binFor(b);
  if (bin.includes('/')) {
    try { fs.accessSync(bin, fs.constants.X_OK); return true; } catch (_) { return false; }
  }
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    try { fs.accessSync(path.join(dir, bin), fs.constants.X_OK); return true; } catch (_) {}
  }
  return false;
}

module.exports = { ALL, byId, binFor, isInstalled };
