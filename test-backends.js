#!/usr/bin/env node
'use strict';
/* Unit tests for the backend adapters: argument building and output parsing.
 * No network, no CLIs needed. Run: node test-backends.js */

const assert = require('assert');
const backends = require('./backends');
const { normalizeTool } = require('./backends/opencode-family.js');

let n = 0;
function test(name, fn) { n++; try { fn(); console.log(`ok ${n} - ${name}`); } catch (e) { console.log(`not ok ${n} - ${name}\n  ${e.message}`); process.exitCode = 1; } }

function collect(b, chunks) {
  const events = [];
  const p = b.createParser((e) => events.push(e));
  for (const c of chunks) p.feed(c);
  p.end();
  return events;
}
const types = (evs) => evs.map((e) => e.type);

// ---------------------------------------------------------------- registry ---
test('registry has the four agents', () => {
  assert.deepStrictEqual(backends.ALL.map((b) => b.id), ['claude', 'opencode', 'kilo', 'kiro']);
  for (const b of backends.ALL) {
    for (const k of ['buildArgs', 'listSessions', 'createParser', 'isSessionGone', 'sessionLabel']) {
      assert.strictEqual(typeof b[k], 'function', `${b.id}.${k}`);
    }
    assert.ok(Array.isArray(b.models), `${b.id}.models`);
  }
});

test('TGA_<ID>_BIN overrides the executable', () => {
  process.env.TGA_KIRO_BIN = '/nonexistent/kiro';
  assert.strictEqual(backends.binFor(backends.byId.kiro), '/nonexistent/kiro');
  assert.strictEqual(backends.isInstalled(backends.byId.kiro), false);
  delete process.env.TGA_KIRO_BIN;
});

// ------------------------------------------------------------------ claude ---
const claude = backends.byId.claude;
const claudeCtx = { prompt: 'hi', model: 'sonnet', effort: 'high', sessionId: null, guardMode: 'bymode', mode: 'smart', settingsFile: '/s.json', hookEnv: { TGA_GUARD: 'smart' } };

test('claude: bymode/smart uses bypass + settings hook', () => {
  const { args, env } = claude.buildArgs(claudeCtx);
  assert.deepStrictEqual(args.slice(0, 4), ['-p', '--output-format', 'stream-json', '--verbose']);
  assert.ok(args.includes('--dangerously-skip-permissions'));
  assert.strictEqual(args[args.indexOf('--settings') + 1], '/s.json');
  assert.ok(!args.includes('--resume'));
  assert.strictEqual(env.TGA_GUARD, 'smart');
});
test('claude: auto mode restricts tools instead of bypassing', () => {
  const { args } = claude.buildArgs({ ...claudeCtx, mode: 'auto' });
  assert.ok(!args.includes('--dangerously-skip-permissions'));
  assert.ok(args.includes('--allowedTools'));
  assert.deepStrictEqual(args.slice(args.indexOf('--permission-mode'), args.indexOf('--permission-mode') + 2), ['--permission-mode', 'acceptEdits']);
});
test('claude: guard none bypasses even in auto', () => {
  const { args } = claude.buildArgs({ ...claudeCtx, mode: 'auto', guardMode: 'none' });
  assert.ok(args.includes('--dangerously-skip-permissions'));
  assert.ok(!args.includes('--allowedTools'));
});
test('claude: resume flag', () => {
  const { args } = claude.buildArgs({ ...claudeCtx, sessionId: 'abc-123' });
  assert.deepStrictEqual(args.slice(-2), ['--resume', 'abc-123']);
});
test('claude: stream-json parsing', () => {
  const lines = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello ' }, { type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } }),
    'garbage line',
    JSON.stringify({ type: 'result', session_id: 'sess-1', total_cost_usd: 0.01, is_error: false, result: 'done', permission_denials: [{ tool_name: 'Bash' }] }),
  ];
  const evs = collect(claude, [lines.slice(0, 2).join('\n') + '\n', lines.slice(2).join('\n')]);
  assert.deepStrictEqual(types(evs), ['session', 'text', 'tool', 'noise', 'session', 'result']);
  assert.strictEqual(evs[1].text, 'Hello');
  assert.deepStrictEqual(evs[2], { type: 'tool', name: 'Bash', input: { command: 'ls' } });
  assert.deepStrictEqual(evs[5], { type: 'result', costUsd: 0.01, isError: false, text: 'done', denials: ['Bash'] });
});
test('claude: stale session detection', () => {
  assert.ok(claude.isSessionGone('No conversation found with session ID x', 1));
  assert.ok(!claude.isSessionGone('No conversation found', 0));
});

// -------------------------------------------------------- opencode / kilo ---
for (const id of ['opencode', 'kilo']) {
  const b = backends.byId[id];
  test(`${id}: run --format json --auto, prompt as argument`, () => {
    const { args } = b.buildArgs({ prompt: 'fix the bug', model: '', sessionId: null });
    assert.deepStrictEqual(args, ['run', '--format', 'json', '--auto', '--', 'fix the bug']);
    assert.strictEqual(b.stdinPrompt, false);
    assert.strictEqual(b.guard, false);
  });
  test(`${id}: model + session flags`, () => {
    const { args } = b.buildArgs({ prompt: 'x', model: 'anthropic/claude-sonnet-4-5', sessionId: 'ses_1' });
    assert.ok(args.includes('--model') && args[args.indexOf('--model') + 1] === 'anthropic/claude-sonnet-4-5');
    assert.ok(args.includes('--session') && args[args.indexOf('--session') + 1] === 'ses_1');
  });
  test(`${id}: json event parsing`, () => {
    const lines = [
      { type: 'step_start', sessionID: 'ses_abc', part: {} },
      { type: 'tool_use', sessionID: 'ses_abc', part: { id: 'p1', tool: 'bash', state: { status: 'running', input: { command: 'rm -rf /tmp/x' } } } },
      { type: 'tool_use', sessionID: 'ses_abc', part: { id: 'p1', tool: 'bash', state: { status: 'completed', input: { command: 'rm -rf /tmp/x' } } } },
      { type: 'tool_use', sessionID: 'ses_abc', part: { id: 'p2', tool: 'edit', state: { status: 'completed', input: { filePath: '/a/b.js' } } } },
      { type: 'text', sessionID: 'ses_abc', part: { text: 'All done.' } },
      { type: 'step_finish', sessionID: 'ses_abc', part: { cost: 0.002 } },
    ].map((o) => JSON.stringify(o));
    const evs = collect(b, [lines.join('\n') + '\n']);
    const tools = evs.filter((e) => e.type === 'tool');
    assert.strictEqual(tools.length, 2, 'one event per tool call, not per status update');
    assert.deepStrictEqual(tools[0], { type: 'tool', name: 'Bash', input: { command: 'rm -rf /tmp/x', description: undefined } });
    assert.deepStrictEqual(tools[1], { type: 'tool', name: 'Edit', input: { file_path: '/a/b.js' } });
    assert.ok(evs.some((e) => e.type === 'session' && e.id === 'ses_abc'));
    assert.deepStrictEqual(evs.filter((e) => e.type === 'text').map((e) => e.text), ['All done.']);
    const res = evs[evs.length - 1];
    assert.strictEqual(res.type, 'result');
    assert.strictEqual(res.costUsd, 0.002);
    assert.strictEqual(res.isError, false);
  });
  test(`${id}: error event marks the result`, () => {
    const evs = collect(b, [JSON.stringify({ type: 'error', sessionID: 's', error: { name: 'ProviderAuthError', message: 'no key' } }) + '\n']);
    const res = evs[evs.length - 1];
    assert.strictEqual(res.isError, true);
    assert.strictEqual(res.text, 'no key');
  });
  test(`${id}: listSessions on a missing storage dir is empty`, () => {
    assert.deepStrictEqual(b.listSessions('/nonexistent'), []);
  });
}

test('normalizeTool maps opencode names to Claude vocabulary', () => {
  assert.deepStrictEqual(normalizeTool('write', { filePath: '/x' }), { name: 'Write', input: { file_path: '/x' } });
  assert.deepStrictEqual(normalizeTool('grep', { pattern: 'foo' }), { name: 'Grep', input: { pattern: 'foo' } });
  assert.deepStrictEqual(normalizeTool('todowrite', { a: 1 }), { name: 'todowrite', input: { a: 1 } });
});

// -------------------------------------------------------------------- kiro ---
const kiro = backends.byId.kiro;
test('kiro: chat --no-interactive --trust-all-tools, prompt as argument', () => {
  const { args, env } = kiro.buildArgs({ prompt: 'explain this', model: '', sessionId: null });
  assert.deepStrictEqual(args, ['chat', '--no-interactive', '--trust-all-tools', '--', 'explain this']);
  assert.strictEqual(env.NO_COLOR, '1');
  assert.strictEqual(kiro.sessions, false);
});
test('kiro: resume + model', () => {
  const { args } = kiro.buildArgs({ prompt: 'x', model: 'claude-sonnet-4', sessionId: 'last' });
  assert.ok(args.includes('--resume'));
  assert.ok(args.includes('--model'));
});
test('kiro: text parsing strips ANSI, spinners, counts tools', () => {
  const raw = '\x1b[32m⠋ Thinking...\r⠙ Thinking...\r\x1b[0m\n' +
    '🛠️  Using tool: fs_read\n' +
    ' ● Reading file: /etc/hostname\n' +
    '\x1b[1mHere is the answer\x1b[0m\n\nline two\n\n\n\nline three';
  const evs = collect(kiro, [raw.slice(0, 20), raw.slice(20)]);
  assert.deepStrictEqual(types(evs), ['tool', 'text', 'session', 'result']);
  assert.strictEqual(evs[0].name, 'Read');
  assert.strictEqual(evs[1].text, '● Reading file: /etc/hostname\nHere is the answer\n\nline two\n\nline three');
  assert.strictEqual(evs[2].id, 'last');
});
test('kiro: no output still yields session + result', () => {
  assert.deepStrictEqual(types(collect(kiro, [])), ['session', 'result']);
});

console.log(`1..${n}`);
