import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatFanoutChip, type RunRow, type RunStatus, renderRowLabel } from '../extensions/progress-multi.ts';

test('renderRowLabel: marks by status, spinner frame only matters while running', () => {
  assert.equal(renderRowLabel({ harness: 'claude', startedAt: null, status: 'queued', activity: '' }, 0), '… claude');
  assert.equal(
    renderRowLabel({ harness: 'codex', startedAt: Date.now(), status: 'running', activity: '' }, 0),
    '⠋ codex',
  );
  assert.equal(
    renderRowLabel({ harness: 'codex', startedAt: Date.now(), status: 'running', activity: '' }, 1),
    '⠙ codex',
  );
  assert.equal(
    renderRowLabel({ harness: 'opencode', startedAt: Date.now(), status: 'done', activity: '' }, 3),
    '✓ opencode',
  );
  assert.equal(renderRowLabel({ harness: 'amp', startedAt: Date.now(), status: 'failed', activity: '' }, 3), '✗ amp');
});

test('formatFanoutChip omits zero counts and reports every status', () => {
  const row = (harness: string, status: RunStatus): RunRow => ({
    harness,
    startedAt: status === 'queued' ? null : 1,
    status,
    activity: '',
  });
  // The case the first cut got wrong: 2 failed + 2 queued rendered as "0/4 running", reading idle.
  assert.equal(
    formatFanoutChip([row('a', 'failed'), row('b', 'failed'), row('c', 'queued'), row('d', 'queued')]),
    '2✗ 2…',
  );
  assert.equal(
    formatFanoutChip([row('a', 'done'), row('b', 'failed'), row('c', 'running'), row('d', 'queued')]),
    '1✓ 1✗ 1▶ 1…',
  );
  // Common cases stay short.
  assert.equal(formatFanoutChip([row('a', 'running'), row('b', 'running')]), '2▶');
  assert.equal(formatFanoutChip([row('a', 'done'), row('b', 'done')]), '2✓');
  assert.equal(formatFanoutChip([]), '0…');
});
