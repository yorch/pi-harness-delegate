import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAmpLine } from '../extensions/harnesses/amp.ts';
import { parseClaudeLine } from '../extensions/harnesses/claude.ts';
import { parseCodexLine } from '../extensions/harnesses/codex.ts';
import { parseOpencodeLine } from '../extensions/harnesses/opencode.ts';
import { getHarness, HARNESS_NAMES, resolveHarnessName } from '../extensions/harnesses/registry.ts';

test('claude harness parses stream deltas and result', () => {
  const state = { streamedText: '', activities: [], result: null };
  const out1 = parseClaudeLine(
    JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } },
    }),
    state,
  );
  assert.equal(out1.streamedText, 'hi');
  const out2 = parseClaudeLine(
    JSON.stringify({
      type: 'result',
      result: 'done',
      total_cost_usd: 0.1,
      session_id: 'abc',
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    { streamedText: 'hi', activities: [], result: null },
  );
  assert.ok(out2.result);
  assert.equal(out2.result!.sessionId, 'abc');
});

test('codex harness parses plain text fallback', () => {
  const state = { streamedText: '', activities: [], result: null };
  const out = parseCodexLine('hello from codex', state);
  assert.ok(out.streamedText?.includes('hello'));
});

test('codex harness parses json result', () => {
  const state = { streamedText: 'partial', activities: [], result: null };
  const out = parseCodexLine(
    JSON.stringify({
      type: 'result',
      result: 'final',
      session_id: 'sess-1',
      usage: { input_tokens: 5, output_tokens: 5 },
    }),
    state,
  );
  assert.ok(out.result);
  assert.equal(out.result!.sessionId, 'sess-1');
});

test('opencode harness parses text', () => {
  const state = { streamedText: '', activities: [], result: null };
  const out = parseOpencodeLine(JSON.stringify({ type: 'text', text: 'opencode hi' }), state);
  assert.equal(out.streamedText, 'opencode hi');
});

test('amp harness parses text', () => {
  const state = { streamedText: '', activities: [], result: null };
  const out = parseAmpLine(JSON.stringify({ type: 'text', text: 'amp hi' }), state);
  assert.equal(out.streamedText, 'amp hi');
});

test('registry returns harnesses and normalizes aliases', () => {
  assert.ok(HARNESS_NAMES.includes('claude'));
  assert.ok(HARNESS_NAMES.includes('codex'));
  assert.equal(resolveHarnessName('OMP'), 'amp');
  assert.equal(resolveHarnessName('claude'), 'claude');
  assert.ok(getHarness('claude'));
  assert.ok(getHarness('amp'));
  assert.ok(getHarness('omp'));
  assert.equal(getHarness('unknown'), undefined);
});

test('harness buildArgs respect permission', () => {
  const claude = getHarness('claude')!;
  const argsRo = claude.buildArgs({ prompt: 'hi', cwd: '/tmp', permission: 'readonly' });
  assert.ok(argsRo.includes('plan'));
  const argsEdit = claude.buildArgs({ prompt: 'hi', cwd: '/tmp', permission: 'edit' });
  assert.ok(argsEdit.includes('acceptEdits'));
  const argsDanger = claude.buildArgs({ prompt: 'hi', cwd: '/tmp', permission: 'danger' });
  assert.ok(argsDanger.includes('bypassPermissions'));

  const codex = getHarness('codex')!;
  const cArgsRo = codex.buildArgs({ prompt: 'hi', cwd: '/tmp', permission: 'readonly' });
  assert.ok(cArgsRo.includes('read-only'));
});
