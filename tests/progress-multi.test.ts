import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderRowLabel } from '../extensions/progress-multi.ts';

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
