import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fmtElapsed, renderEntry } from '../extensions/progress.ts';

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
		bg: (c: string, s: string) => s,
		bold: (s: string) => s,
	};
	assert.equal(renderEntry({ kind: 'tool', text: 'Bash: ls', ok: true }, theme), 'accent:▶ muted:Bash: lssuccess: ✓');
	assert.equal(renderEntry({ kind: 'tool', text: 'Bash: rm', ok: false }, theme), 'accent:▶ muted:Bash: rmerror: ✗');
	assert.equal(renderEntry({ kind: 'tool', text: 'Read: a.ts' }, theme), 'accent:▶ muted:Read: a.ts');
	assert.equal(renderEntry({ kind: 'thinking', text: '💭 thinking…' }, theme), 'dim:💭 thinking…');
	assert.equal(renderEntry({ kind: 'text', text: 'tail' }, theme), 'text:tail');
});
