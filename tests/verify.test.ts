import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildFanoutReport,
  buildReportContent,
  buildTranscript,
  buildVerifyResult,
  formatVerifySection,
  resolveVerifyCommand,
  resolveVerifyPlan,
  skipVerifyResult,
} from '../extensions/activity.ts';

test('resolveVerifyCommand: per-call override wins over the template', () => {
  assert.equal(resolveVerifyCommand('npm test', 'bun test'), 'npm test');
});

test('resolveVerifyCommand: falls back to the template when no override is given', () => {
  assert.equal(resolveVerifyCommand(undefined, 'bun test'), 'bun test');
});

test('resolveVerifyCommand: undefined when neither is configured (no invented default)', () => {
  assert.equal(resolveVerifyCommand(undefined, undefined), undefined);
  assert.equal(resolveVerifyCommand('', undefined), undefined);
});

test('resolveVerifyPlan: skips on a readonly template even though a command is configured', () => {
  const plan = resolveVerifyPlan(undefined, 'bun test', 'readonly');
  assert.deepEqual(plan, { command: 'bun test', skip: true });
});

test('resolveVerifyPlan: runs on an edit template', () => {
  const plan = resolveVerifyPlan(undefined, 'bun test', 'edit');
  assert.deepEqual(plan, { command: 'bun test', skip: false });
});

test('resolveVerifyPlan: skips on readonly regardless of the command source (call override or template)', () => {
  assert.deepEqual(resolveVerifyPlan('npm test', undefined, 'readonly'), { command: 'npm test', skip: true });
});

test('resolveVerifyPlan: undefined when no command is configured, on any permission', () => {
  assert.equal(resolveVerifyPlan(undefined, undefined, 'readonly'), undefined);
  assert.equal(resolveVerifyPlan(undefined, undefined, 'edit'), undefined);
  assert.equal(resolveVerifyPlan(undefined, undefined, 'danger'), undefined);
});

test('resolveVerifyPlan: danger permission runs verify too (only readonly is special)', () => {
  const plan = resolveVerifyPlan(undefined, 'bun test', 'danger');
  assert.deepEqual(plan, { command: 'bun test', skip: false });
});

test('skipVerifyResult: records the reason, no exit code, not ok', () => {
  const v = skipVerifyResult('bun test', 'readonly run');
  assert.equal(v.command, 'bun test');
  assert.equal(v.exitCode, null);
  assert.equal(v.ok, false);
  assert.equal(v.skipped, 'readonly run');
});

test('formatVerifySection: a skipped verify renders a skip line, not a pass/fail one', () => {
  const section = formatVerifySection(skipVerifyResult('bun test', 'readonly run'));
  assert.equal(section, '### Verify: `bun test`\n⊘ skipped (readonly run)');
});

test('buildTranscript: records a skipped verify (never silently dropped)', () => {
  const t = buildTranscript({
    harness: 'claude',
    mode: 'review',
    permission: 'readonly',
    model: 'sonnet',
    cwd: '/repo',
    sessionId: 's1',
    resumed: false,
    numTurns: 1,
    totalCostUsd: 0.05,
    isError: false,
    stopReason: null,
    durationMs: 500,
    usage: null,
    contextPercent: null,
    contextWindow: null,
    activityLog: [],
    output: 'looks fine',
    verify: skipVerifyResult('bun test', 'readonly run'),
  });
  assert.ok(t.includes('- turns: 1 · cost: $0.0500 · isError: false'), 'the harness result is unaffected');
  assert.ok(t.includes('### Verify: `bun test`'));
  assert.ok(t.includes('⊘ skipped (readonly run)'));
});

test('buildVerifyResult: ok is exit-code-derived, tail capped to the last N chars', () => {
  const ok = buildVerifyResult('bun test', 0, 'all good');
  assert.equal(ok.ok, true);
  assert.equal(ok.exitCode, 0);
  assert.equal(ok.outputTail, 'all good');

  const long = 'x'.repeat(50);
  const capped = buildVerifyResult('bun test', 1, long, 10);
  assert.equal(capped.ok, false);
  assert.equal(capped.outputTail.length, 10);
  assert.equal(capped.outputTail, long.slice(-10));
});

test('formatVerifySection: renders pass/fail with the command and output tail', () => {
  const pass = formatVerifySection(buildVerifyResult('bun test', 0, '12 pass'));
  assert.ok(pass.startsWith('### Verify: `bun test`'));
  assert.ok(pass.includes('✓ exit 0'));
  assert.ok(pass.includes('  12 pass'));

  const fail = formatVerifySection(buildVerifyResult('bun test', 1, '1 fail\nExpected 2, got 3'));
  assert.ok(fail.includes('✗ exit 1'));
  assert.ok(fail.includes('  1 fail'));
  assert.ok(fail.includes('  Expected 2, got 3'));
});

test('formatVerifySection: omits the output block when there is no output', () => {
  const section = formatVerifySection(buildVerifyResult('bun test', 0, '   \n  '));
  assert.equal(section, '### Verify: `bun test`\n✓ exit 0');
});

test('buildTranscript: appends a Verify section without touching isError', () => {
  const t = buildTranscript({
    harness: 'claude',
    mode: 'implement',
    permission: 'edit',
    model: 'sonnet',
    cwd: '/repo',
    sessionId: 's1',
    resumed: false,
    numTurns: 2,
    totalCostUsd: 0.1,
    isError: false,
    stopReason: null,
    durationMs: 1000,
    usage: null,
    contextPercent: null,
    contextWindow: null,
    activityLog: [],
    output: 'done',
    verify: buildVerifyResult('bun test', 1, '1 fail'),
  });
  assert.ok(t.includes('- turns: 2 · cost: $0.1000 · isError: false'));
  assert.ok(t.includes('### Verify: `bun test`'));
  assert.ok(t.includes('✗ exit 1'));
});

test('buildTranscript: no Verify section when no verify command was configured', () => {
  const t = buildTranscript({
    harness: 'claude',
    mode: 'review',
    permission: 'readonly',
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
  assert.ok(!t.includes('### Verify'));
});

test('buildReportContent: includes the verify section when present', () => {
  const content = buildReportContent({
    harness: 'claude',
    mode: 'implement',
    metrics: '2 turn(s)',
    body: 'Did the thing.',
    verify: buildVerifyResult('bun test', 0, '5 pass'),
  });
  assert.ok(content.includes('### Verify: `bun test`'));
  assert.ok(content.includes('✓ exit 0'));
});

test('buildFanoutReport: mechanically groups per-harness metrics and totals spend', () => {
  const report = buildFanoutReport({
    runs: [
      { harness: 'claude', ok: true, metrics: '3 turn(s) · $0.500', cost: 0.5, body: 'Claude found nothing.' },
      { harness: 'codex', ok: true, metrics: '— turn(s) · $—', cost: null, body: 'Codex found a bug.' },
      { harness: 'opencode', ok: false, cost: null, error: 'timed out' },
    ],
    skipped: ['amp'],
    unknown: ['bogus'],
  });
  assert.ok(report.includes('_unknown harness(es), skipped: bogus_'));
  assert.ok(report.includes('_not installed, skipped: amp_'));
  assert.ok(report.includes('**Total spend:** $0.500 over 3 run(s) (2 unknown)'));
  assert.ok(report.includes('### claude'));
  assert.ok(report.includes('Claude found nothing.'));
  assert.ok(report.includes('### codex'));
  assert.ok(report.includes('Codex found a bug.'));
  assert.ok(report.includes('### opencode — failed'));
  assert.ok(report.includes('error: timed out'));
});

test('buildFanoutReport: no unknown/skipped lines when everything resolved', () => {
  const report = buildFanoutReport({
    runs: [{ harness: 'claude', ok: true, metrics: '1 turn(s)', cost: 0, body: 'ok' }],
    skipped: [],
    unknown: [],
  });
  assert.ok(!report.includes('skipped'));
  assert.ok(report.startsWith('**Total spend:**'));
});
