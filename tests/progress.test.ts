import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fmtElapsed, renderEntry, truncateFeed } from '../extensions/progress.ts';

test('fmtElapsed formats mm:ss', () => {
  assert.equal(fmtElapsed(0), '0:00');
  assert.equal(fmtElapsed(12_000), '0:12');
  assert.equal(fmtElapsed(42_000), '0:42');
  assert.equal(fmtElapsed(65_000), '1:05');
  assert.equal(fmtElapsed(600_000), '10:00');
  assert.equal(fmtElapsed(-1000), '0:00');
});

test('renderEntry styles by kind', () => {
  const theme = {
    fg: (c: string, s: string) => `${c}:${s}`,
    bg: (_c: string, s: string) => s,
    bold: (s: string) => s,
  };
  assert.equal(renderEntry({ kind: 'tool', text: 'Bash: ls', ok: true }, theme), 'accent:▶ muted:Bash: lssuccess: ✓');
  assert.equal(renderEntry({ kind: 'tool', text: 'Bash: rm', ok: false }, theme), 'accent:▶ muted:Bash: rmerror: ✗');
  assert.equal(renderEntry({ kind: 'tool', text: 'Read: a.ts' }, theme), 'accent:▶ muted:Read: a.ts');
  assert.equal(renderEntry({ kind: 'thinking', text: '💭 thinking…' }, theme), 'dim:💭 thinking…');
  assert.equal(renderEntry({ kind: 'text', text: 'tail' }, theme), 'text:tail');
});

test('truncateFeed: no marker when everything fits, reports the drop count when it does not', () => {
  assert.deepEqual(truncateFeed([1, 2, 3], 12), { visible: [1, 2, 3], hiddenCount: 0 });
  assert.deepEqual(truncateFeed([], 12), { visible: [], hiddenCount: 0 });
  const entries = Array.from({ length: 15 }, (_, i) => i);
  // the marker takes one of the 12 lines: 11 entries + "+4 earlier" = 12 lines, never 13
  assert.deepEqual(truncateFeed(entries, 12), { visible: entries.slice(4), hiddenCount: 4 });
  // exactly at the cap — still no marker
  assert.deepEqual(
    truncateFeed(
      Array.from({ length: 12 }, (_, i) => i),
      12,
    ),
    {
      visible: Array.from({ length: 12 }, (_, i) => i),
      hiddenCount: 0,
    },
  );
});

test('truncateFeed: marker + visible entries never exceed max, for every overflow size', () => {
  for (let n = 13; n < 40; n++) {
    const { visible, hiddenCount } = truncateFeed(
      Array.from({ length: n }, (_, i) => i),
      12,
    );
    assert.equal(visible.length + (hiddenCount > 0 ? 1 : 0), 12, `n=${n}`);
    assert.equal(visible.length + hiddenCount, n, `n=${n}`);
    assert.equal(visible[visible.length - 1], n - 1, 'the newest entry is always kept');
  }
});

test("truncateFeed: max 0 (or less) shows no entries rather than slice(-0)'s everything", () => {
  assert.deepEqual(truncateFeed([1, 2, 3], 0), { visible: [], hiddenCount: 3 });
  assert.deepEqual(truncateFeed([1, 2, 3], -5), { visible: [], hiddenCount: 3 });
  assert.deepEqual(truncateFeed([], 0), { visible: [], hiddenCount: 0 });
  // max 1: room for the marker only
  assert.deepEqual(truncateFeed([1, 2], 1), { visible: [], hiddenCount: 2 });
});
