import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  aggregateSpend,
  buildTranscript,
  collectActivityLog,
  formatSpend,
  formatToolUse,
  pruneOutputs,
  safeSegmentName,
} from '../extensions/activity.ts';

test('formatToolUse prefers description', () => {
  assert.equal(formatToolUse('Bash', { command: 'ls', description: 'List files' }), 'Bash: List files');
  assert.equal(formatToolUse('Read', { file_path: 'auth/login.ts' }), 'Read: auth/login.ts');
  assert.equal(formatToolUse('Grep', { pattern: 'TODO' }), 'Grep: TODO');
  assert.equal(formatToolUse('Bash', { command: 'git status' }), 'Bash: git status');
  assert.equal(formatToolUse('Unknown', { a: 1 }), 'Unknown');
});

test('formatToolUse truncates long commands', () => {
  const long = `echo ${'x'.repeat(200)}`;
  const out = formatToolUse('Bash', { command: long });
  assert.ok(out.length <= 100, `length ${out.length}`);
  assert.ok(out.endsWith('…'));
});

test('collectActivityLog pairs tool calls with results (no-id fallback: attach to last entry)', () => {
  const log = collectActivityLog([
    { kind: 'tool_start', name: 'Bash' },
    { kind: 'tool_input', name: 'Bash', input: { command: 'ls' } },
    { kind: 'tool_result', isError: false },
    { kind: 'tool_input', name: 'Grep', input: { pattern: 'x' } },
    { kind: 'tool_result', isError: true },
  ]);
  assert.deepEqual(log, ['▶ Bash: ls  ✓', '▶ Grep: x  ✗ error']);
});

test('collectActivityLog attributes each result to its own row in a parallel batch (by id)', () => {
  // Claude-style: N tool_use blocks in one assistant message, then N tool_result blocks in the next.
  const log = collectActivityLog([
    { kind: 'tool_input', name: 'Read', input: { file_path: 'a.ts' }, id: 't1' },
    { kind: 'tool_input', name: 'Read', input: { file_path: 'b.ts' }, id: 't2' },
    { kind: 'tool_input', name: 'Read', input: { file_path: 'c.ts' }, id: 't3' },
    { kind: 'tool_result', isError: false, id: 't1' },
    { kind: 'tool_result', isError: false, id: 't2' },
    { kind: 'tool_result', isError: false, id: 't3' },
  ]);
  assert.deepEqual(log, ['▶ Read: a.ts  ✓', '▶ Read: b.ts  ✓', '▶ Read: c.ts  ✓']);
});

test('collectActivityLog marks a failing tool in the middle of a parallel batch on the right row', () => {
  const log = collectActivityLog([
    { kind: 'tool_input', name: 'Read', input: { file_path: 'a.ts' }, id: 't1' },
    { kind: 'tool_input', name: 'Bash', input: { command: 'bogus' }, id: 't2' },
    { kind: 'tool_input', name: 'Read', input: { file_path: 'c.ts' }, id: 't3' },
    // results arrive out of order and the middle one fails
    { kind: 'tool_result', isError: false, id: 't3' },
    { kind: 'tool_result', isError: true, id: 't2' },
    { kind: 'tool_result', isError: false, id: 't1' },
  ]);
  assert.deepEqual(log, ['▶ Read: a.ts  ✓', '▶ Bash: bogus  ✗ error', '▶ Read: c.ts  ✓']);
});

test('safeSegmentName neutralizes path separators', () => {
  assert.equal(safeSegmentName('review'), 'review');
  assert.equal(safeSegmentName('../../../etc/passwd'), 'etc_passwd');
  assert.equal(safeSegmentName('a b:c'), 'a_b_c');
  assert.equal(safeSegmentName('!!!'), 'delegate');
});

test('pruneOutputs keeps the newest N transcripts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pcd-prune-'));
  try {
    const old = Date.now() / 1000 - 3600; // an hour old: outside the protect window for just-written files
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(dir, `00${i}-a.md`), 'x');
      utimesSync(join(dir, `00${i}-a.md`), old + i, old + i);
    }
    pruneOutputs(dir, 2);
    assert.equal(readdirSync(dir).filter(f => f.endsWith('.md')).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pruneOutputs maxCount 0 keeps everything', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pcd-noprune-'));
  try {
    for (let i = 0; i < 3; i++) writeFileSync(join(dir, `${i}.md`), 'x');
    pruneOutputs(dir, 0);
    assert.equal(readdirSync(dir).length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildTranscript includes metadata, activity and output', () => {
  const t = buildTranscript({
    harness: 'claude',
    mode: 'review',
    permission: 'readonly',
    nativePermission: 'plan',
    model: 'claude-sonnet-5',
    cwd: '/repo',
    sessionId: 'sess-1',
    resumed: true,
    numTurns: 2,
    totalCostUsd: 0.1234,
    isError: false,
    stopReason: 'end_turn',
    durationMs: 3000,
    usage: { inputTokens: 10, outputTokens: 20, cacheCreationInputTokens: 100, cacheReadInputTokens: 50 },
    contextPercent: 2.1,
    contextWindow: 1_000_000,
    activityLog: ['▶ Read: a.ts  ✓'],
    output: 'findings…',
  });
  assert.ok(t.startsWith('# Delegated Claude run — review'));
  assert.ok(t.includes('permission: readonly (plan)'));
  assert.ok(t.includes('session: sess-1 (resumed)'));
  assert.ok(t.includes('cost: $0.1234'));
  assert.ok(t.includes('tokens: input 10 · output 20 · cache+100 · cache 50'));
  assert.ok(t.includes('context: 2.1% of 1,000,000 window'));
  assert.ok(t.includes('duration: 3.0s'));
  assert.ok(t.includes('model: claude-sonnet-5'));
  assert.ok(t.includes('▶ Read: a.ts  ✓'));
  assert.ok(t.includes('findings…'));
});

test('buildTranscript renders unknown numTurns/cost as n/a rather than a fake 0', () => {
  const t = buildTranscript({
    harness: 'codex',
    mode: 'general',
    permission: 'edit',
    model: null,
    cwd: '/repo',
    sessionId: null,
    resumed: false,
    numTurns: null,
    totalCostUsd: null,
    isError: false,
    stopReason: null,
    durationMs: null,
    usage: null,
    contextPercent: null,
    contextWindow: null,
    activityLog: [],
    output: 'ok',
  });
  assert.ok(t.includes('turns: n/a · cost: n/a · isError: false'));
});

test('aggregateSpend rolls up cost and run counts per harness, counting unknowns separately', () => {
  const spend = aggregateSpend([
    { harness: 'claude', cost: 0.5 },
    { harness: 'claude', cost: 0.25 },
    { harness: 'claude', cost: null },
    { harness: 'codex', cost: null },
  ]);
  assert.deepEqual(spend.byHarness.claude, { totalCostUsd: 0.75, runs: 3, unknownRuns: 1 });
  assert.deepEqual(spend.byHarness.codex, { totalCostUsd: 0, runs: 1, unknownRuns: 1 });
  assert.deepEqual(spend.total, { totalCostUsd: 0.75, runs: 4, unknownRuns: 2 });
});

test('formatSpend reports unknown-cost runs honestly instead of folding them into $0', () => {
  assert.equal(formatSpend({ totalCostUsd: 1.234, runs: 12, unknownRuns: 3 }), '$1.234 over 12 run(s) (3 unknown)');
  assert.equal(formatSpend({ totalCostUsd: 0, runs: 2, unknownRuns: 0 }), '$0.000 over 2 run(s)');
});

test('writeTranscript: owner-only permissions on the directory and each file', async () => {
  const { mkdtempSync, statSync, readFileSync, rmSync, mkdirSync, chmodSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { writeTranscript } = await import('../extensions/activity.ts');
  const root = mkdtempSync(join(tmpdir(), 'transcript-perms-'));
  try {
    const dir = join(root, 'outputs', 'claude');
    const file = writeTranscript(dir, 'review', '# hi');
    assert.equal(readFileSync(file, 'utf8'), '# hi');
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    // a pre-existing, too-open directory is tightened too
    const loose = join(root, 'loose');
    mkdirSync(loose, { mode: 0o755 });
    chmodSync(loose, 0o755);
    writeTranscript(loose, 'plan', 'x');
    assert.equal(statSync(loose).mode & 0o777, 0o700);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
