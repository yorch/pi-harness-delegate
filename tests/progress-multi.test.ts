import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  formatFanoutChip,
  isFanoutComplete,
  type RunRow,
  type RunStatus,
  renderRowLabel,
} from '../extensions/progress-multi.ts';

test('renderRowLabel: marks by status, spinner frame only matters while running', () => {
  assert.equal(
    renderRowLabel({ harness: 'claude', startedAt: null, status: 'queued', activity: '', costUsd: null }, 0),
    '… claude',
  );
  assert.equal(
    renderRowLabel({ harness: 'codex', startedAt: Date.now(), status: 'running', activity: '', costUsd: null }, 0),
    '⠋ codex',
  );
  assert.equal(
    renderRowLabel({ harness: 'codex', startedAt: Date.now(), status: 'running', activity: '', costUsd: null }, 1),
    '⠙ codex',
  );
  assert.equal(
    renderRowLabel({ harness: 'opencode', startedAt: Date.now(), status: 'done', activity: '', costUsd: 0.01 }, 3),
    '✓ opencode',
  );
  assert.equal(
    renderRowLabel({ harness: 'amp', startedAt: Date.now(), status: 'failed', activity: '', costUsd: null }, 3),
    '✗ amp',
  );
});

test('formatFanoutChip omits zero status counts and reports every status', () => {
  const row = (harness: string, status: RunStatus, costUsd: number | null = null): RunRow => ({
    harness,
    startedAt: status === 'queued' ? null : 1,
    status,
    activity: '',
    costUsd,
  });
  // The case the first cut got wrong: 2 failed + 2 queued rendered as "0/4 running", reading idle.
  assert.equal(
    formatFanoutChip([row('a', 'failed'), row('b', 'failed'), row('c', 'queued'), row('d', 'queued')], 5_000),
    '2✗ 2… · ⏱ 0:05',
  );
  assert.equal(
    formatFanoutChip([row('a', 'done'), row('b', 'failed'), row('c', 'running'), row('d', 'queued')], 65_000),
    '1✓ 1✗ 1▶ 1… · ⏱ 1:05',
  );
  // Common cases stay short.
  assert.equal(formatFanoutChip([row('a', 'running'), row('b', 'running')], 0), '2▶ · ⏱ 0:00');
  assert.equal(formatFanoutChip([row('a', 'done'), row('b', 'done')], 1_000), '2✓ · ⏱ 0:01');
  assert.equal(formatFanoutChip([], 0), '0… · ⏱ 0:00');
});

test('formatFanoutChip: adds aggregate spend once a run has reported a cost, omitted otherwise', () => {
  const row = (harness: string, status: RunStatus, costUsd: number | null = null): RunRow => ({
    harness,
    startedAt: status === 'queued' ? null : 1,
    status,
    activity: '',
    costUsd,
  });
  // No run has completed yet — nothing to sum, so no spend segment.
  assert.equal(formatFanoutChip([row('a', 'running'), row('b', 'queued')], 3_000), '1▶ 1… · ⏱ 0:03');
  // One completed run reported a cost — shown even though others are still in flight.
  assert.equal(formatFanoutChip([row('a', 'done', 0.05), row('b', 'running')], 3_000), '1✓ 1▶ · ⏱ 0:03 · $0.050');
  // Multiple completed runs — costs sum.
  assert.equal(formatFanoutChip([row('a', 'done', 0.05), row('b', 'done', 0.125)], 3_000), '2✓ · ⏱ 0:03 · $0.175');
  // A failed run never carries a cost — doesn't pull the total down or in.
  assert.equal(formatFanoutChip([row('a', 'done', 0.05), row('b', 'failed')], 3_000), '1✓ 1✗ · ⏱ 0:03 · $0.050');
});

test('isFanoutComplete: true only once every row is terminal, false for an empty fan-out', () => {
  const row = (status: RunStatus): RunRow => ({
    harness: 'a',
    startedAt: status === 'queued' ? null : 1,
    status,
    activity: '',
    costUsd: null,
  });
  assert.equal(isFanoutComplete([row('done'), row('failed')]), true);
  assert.equal(isFanoutComplete([row('done'), row('running')]), false);
  assert.equal(isFanoutComplete([row('queued')]), false);
  assert.equal(isFanoutComplete([]), false);
});
