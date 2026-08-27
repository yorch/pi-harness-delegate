import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildReportContent, formatMetrics, parseTranscriptMeta } from '../extensions/activity.ts';

test('formatMetrics includes all fields', () => {
  assert.equal(
    formatMetrics({
      numTurns: 3,
      totalCostUsd: 0.5432,
      promptTokens: 62000,
      contextPercent: 6.2,
      durationMs: 12500,
    }),
    '3 turn(s) · $0.543 · 62k tok · 6.2% ctx · 13s',
  );
});

test('formatMetrics omits unknown fields', () => {
  assert.equal(
    formatMetrics({ numTurns: 1, totalCostUsd: 0.5, promptTokens: 0, contextPercent: null, durationMs: null }),
    '1 turn(s) · $0.500',
  );
});

test('formatMetrics renders unknown numTurns/cost as — rather than a fake 0', () => {
  assert.equal(
    formatMetrics({ numTurns: null, totalCostUsd: null, promptTokens: 0, contextPercent: null, durationMs: null }),
    '— turn(s) · $—',
  );
  assert.equal(
    formatMetrics({ numTurns: 2, totalCostUsd: null, promptTokens: 0, contextPercent: null, durationMs: null }),
    '2 turn(s) · $—',
  );
});

test('parseTranscriptMeta extracts mode, cost, session', () => {
  const head = [
    '# Delegated Claude run — review',
    '',
    '- mode: review',
    '- cost: $0.7244 · isError: false',
    '- session: b2125252-aaaa-bbbb-cccc-dddddddddddd',
    '',
    '## Activity',
  ].join('\n');
  assert.deepEqual(parseTranscriptMeta(head), {
    mode: 'review',
    cost: 0.7244,
    sessionId: 'b2125252-aaaa-bbbb-cccc-dddddddddddd',
    harness: 'claude',
  });
});

test('parseTranscriptMeta defaults on unparseable head (unknown cost is null, not 0)', () => {
  assert.deepEqual(parseTranscriptMeta('garbage'), { mode: 'delegate', cost: null, sessionId: null, harness: null });
  assert.deepEqual(parseTranscriptMeta(''), { mode: 'delegate', cost: null, sessionId: null, harness: null });
});

test('parseTranscriptMeta tolerates a header with unknown cost ("n/a")', () => {
  const head = ['# Delegated Codex run — general', '', '- turns: n/a · cost: n/a · isError: false', ''].join('\n');
  assert.equal(parseTranscriptMeta(head).cost, null);
});

test('buildReportContent assembles header, body and footers', () => {
  const content = buildReportContent({
    harness: 'claude',
    mode: 'review',
    metrics: '3 turn(s) · $0.543',
    body: 'Findings…',
    file: '/tmp/out.md',
    sessionId: 'abc-123',
  });
  assert.ok(content.startsWith('## claude review (3 turn(s) · $0.543)'));
  assert.ok(content.includes('Findings…'));
  assert.ok(content.includes('transcript: /tmp/out.md'));
  assert.ok(content.includes('resume: `/delegate --harness=claude --resume=abc-123'));
});

test('buildReportContent omits footers when absent', () => {
  const content = buildReportContent({ harness: 'claude', mode: 'review', metrics: '1 turn(s)', body: 'x' });
  assert.ok(!content.includes('transcript'));
  assert.ok(!content.includes('resume'));
});
