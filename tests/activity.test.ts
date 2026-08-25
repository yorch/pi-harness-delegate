import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
	buildTranscript,
	collectActivityLog,
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
	const long = 'echo ' + 'x'.repeat(200);
	const out = formatToolUse('Bash', { command: long });
	assert.ok(out.length <= 100, `length ${out.length}`);
	assert.ok(out.endsWith('…'));
});

test('collectActivityLog pairs tool calls with results', () => {
	const log = collectActivityLog([
		{ kind: 'tool_start', name: 'Bash' },
		{ kind: 'tool_input', name: 'Bash', input: { command: 'ls' } },
		{ kind: 'tool_result', isError: false },
		{ kind: 'tool_input', name: 'Grep', input: { pattern: 'x' } },
		{ kind: 'tool_result', isError: true },
	]);
	assert.deepEqual(log, ['▶ Bash: ls  ✓', '▶ Grep: x  ✗ error']);
});

test('safeSegmentName neutralizes path separators', () => {
	assert.equal(safeSegmentName('review'), 'review');
	assert.equal(safeSegmentName('../../../etc/passwd'), 'etc_passwd');
	assert.equal(safeSegmentName('a b:c'), 'a_b_c');
	assert.equal(safeSegmentName('!!!'), 'delegate');
});

test('pruneOutputs keeps the newest N transcripts', () => {
	const dir = join(tmpdir(), `pcd-prune-${Date.now()}`);
	mkdirSync(dir, { recursive: true });
	try {
		for (let i = 0; i < 5; i++) {
			writeFileSync(join(dir, `00${i}-a.md`), 'x');
		}
		pruneOutputs(dir, 2);
		assert.equal(readdirSync(dir).filter((f) => f.endsWith('.md')).length, 2);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('pruneOutputs maxCount 0 keeps everything', () => {
	const dir = join(tmpdir(), `pcd-noprune-${Date.now()}`);
	mkdirSync(dir, { recursive: true });
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
