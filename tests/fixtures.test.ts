import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseAmpLine } from '../extensions/harnesses/amp.ts';
import { parseClaudeLine } from '../extensions/harnesses/claude.ts';
import { parseCodexLine } from '../extensions/harnesses/codex.ts';
import { parseOpencodeLine } from '../extensions/harnesses/opencode.ts';

function loadFixture(name: string): string[] {
  const p = join(import.meta.dirname, 'fixtures', name);
  return readFileSync(p, 'utf8').split('\n').filter(Boolean);
}

test('opencode fixture parses hello with step_finish tokens', () => {
  const lines = loadFixture('opencode-hello.jsonl');
  const state = { streamedText: '', activities: [], result: null, _harness: {} };
  let _last: ReturnType<typeof parseOpencodeLine> | null = null;
  for (const l of lines) _last = parseOpencodeLine(l, state);
  // opencode hello should have captured streamedText "Hello there, nice to meet you!"
  // feed lines sequentially updating state
  const st2 = { streamedText: '', activities: [] as never[], result: null, _harness: {} } as never;
  let streamed = '';
  let result: ReturnType<typeof parseOpencodeLine>['result'] = null;
  for (const l of lines) {
    const out = parseOpencodeLine(l, st2 as never);
    if (out.streamedText) streamed += out.streamedText;
    if (out.result) result = out.result;
  }
  assert.ok(streamed.includes('Hello'), `streamed should contain Hello, got ${streamed}`);
  assert.ok(result, 'should have result from step_finish');
  assert.equal(result?.sessionId?.startsWith('ses_'), true);
});

test('amp fixture parses hello with message_update deltas', () => {
  const lines = loadFixture('amp-hello.jsonl');
  const state = { streamedText: '', activities: [], result: null, _harness: {} } as never;
  let streamed = '';
  let result: ReturnType<typeof parseAmpLine>['result'] = null;
  for (const l of lines) {
    const out = parseAmpLine(l, state as never);
    if (out.streamedText) streamed += out.streamedText;
    if (out.result) result = out.result;
  }
  assert.ok(streamed.includes('Hello') || state.streamedText.includes('Hello'), 'amp streamed should contain Hello');
  // amp result comes from turn_end/agent_end
  assert.ok(result || streamed.length > 0);
});

test('codex error fixture parses as isError', () => {
  const lines = loadFixture('codex-error.jsonl');
  const state = { streamedText: '', activities: [], result: null, _harness: {} } as never;
  let result: ReturnType<typeof parseCodexLine>['result'] = null;
  for (const l of lines) {
    const out = parseCodexLine(l, state as never);
    if (out.result) result = out.result;
  }
  assert.ok(result, 'codex error should produce result');
  assert.equal(result?.isError, true);
  assert.ok(result?.result.includes('usage limit') || result?.result.includes('Upgrade'));
});

test('claude fixture parses stream deltas and result', () => {
  const lines = loadFixture('claude-hello.jsonl');
  const state = { streamedText: '', activities: [], result: null, _harness: {} } as never;
  let streamed = '';
  let result: ReturnType<typeof parseClaudeLine>['result'] = null;
  for (const l of lines) {
    const out = parseClaudeLine(l, state as never);
    if (out.streamedText) streamed += out.streamedText;
    if (out.result) result = out.result;
  }
  assert.ok(streamed.includes('Hello') || result?.result.includes('Hello'));
  assert.ok(result);
  assert.equal(result?.isError, false);
});
