import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { collectActivityLog } from '../extensions/activity.ts';
import { parseAmpLine } from '../extensions/harnesses/amp.ts';
import { parseClaudeLine } from '../extensions/harnesses/claude.ts';
import { parseCodexLine } from '../extensions/harnesses/codex.ts';
import { parseOpencodeLine } from '../extensions/harnesses/opencode.ts';
import type { ActivityEvent, ParseState, StreamedResult } from '../extensions/harnesses/types.ts';

function loadFixture(name: string): string[] {
  const p = join(import.meta.dirname, 'fixtures', name);
  return readFileSync(p, 'utf8').split('\n').filter(Boolean);
}

/** Feed every line of a fixture through a parser, returning the accumulated activities and final result. */
function replay(
  lines: string[],
  parseLine: (line: string, state: ParseState) => { activities?: ActivityEvent[]; result?: StreamedResult | null },
): { activities: ActivityEvent[]; result: StreamedResult | null } {
  const state: ParseState = { streamedText: '', activities: [], result: null };
  const activities: ActivityEvent[] = [];
  let result: StreamedResult | null = null;
  for (const l of lines) {
    const out = parseLine(l, state);
    if (out.activities) activities.push(...out.activities);
    if (out.result) result = out.result;
  }
  return { activities, result };
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

// --- Fixtures below are real, redacted CLI captures with tool calls (not just "say hello") ---
// captured against: claude (installed CLI), codex-cli 0.149.1, opencode 1.18.16, omp 17.2.9.
// See AGENTS.md for capture details and what each harness's real schema does/doesn't report.

test('claude.jsonl: real tool-call ids attribute results to the right row, real cost/turns extracted', () => {
  const lines = loadFixture('claude.jsonl');
  const { activities, result } = replay(lines, parseClaudeLine);
  assert.ok(result);
  assert.equal(result?.sessionId, 'b5b4fc05-28a3-4fd8-bbb0-25cdd38e947b');
  assert.equal(result?.numTurns, 7);
  assert.ok(typeof result?.totalCostUsd === 'number' && Math.abs(result.totalCostUsd - 0.7528274999999999) < 1e-9);
  const log = collectActivityLog(activities);
  assert.ok(log.some(l => l.startsWith('▶ Bash') && l.endsWith('✓')));
  assert.ok(log.some(l => l.startsWith('▶ Read') && l.endsWith('✓')));
});

test('codex.jsonl: real item.id correlates command_execution tool calls, real usage tokens extracted', () => {
  const lines = loadFixture('codex.jsonl');
  const { activities, result } = replay(lines, parseCodexLine);
  assert.ok(result);
  assert.equal(result?.sessionId, '01a04438-fb3a-7d91-9941-96d421741745');
  assert.equal(result?.numTurns, 1); // one turn.started in the fixture
  assert.equal(result?.totalCostUsd, null); // codex-cli 0.149.1 never reports a $ cost
  assert.equal(result?.usage?.inputTokens, 95987);
  assert.equal(result?.usage?.cacheReadInputTokens, 68864);
  assert.equal(result?.usage?.outputTokens, 785);
  const log = collectActivityLog(activities);
  // two sequential command_execution calls, each resolved by its own item.id, both successful
  const toolLines = log.filter(l => l.startsWith('▶'));
  assert.equal(toolLines.length, 2);
  assert.ok(toolLines.every(l => l.endsWith('✓')));
});

test('opencode.jsonl: parallel tool_use batch resolved by callID, cost/tokens summed across step_finish', () => {
  const lines = loadFixture('opencode.jsonl');
  const { activities, result } = replay(lines, parseOpencodeLine);
  assert.ok(result);
  assert.ok(result?.sessionId?.startsWith('ses_'));
  // two step_finish events observed -> numTurns is a genuine count, not a guess
  assert.equal(result?.numTurns, 2);
  assert.ok(typeof result?.totalCostUsd === 'number' && Math.abs(result.totalCostUsd - (0.094492 + 0.00872275)) < 1e-9);
  assert.equal(result?.usage?.inputTokens, 2 + 5);
  assert.equal(result?.usage?.outputTokens, 74 + 149);
  const log = collectActivityLog(activities);
  const toolLines = log.filter(l => l.startsWith('▶'));
  assert.equal(toolLines.length, 5); // 1 bash + 4 parallel reads
  assert.ok(toolLines.every(l => l.endsWith('✓')));
});

test('amp.jsonl: out-of-order parallel tool_execution_end attributes to the right toolCallId row', () => {
  const lines = loadFixture('amp.jsonl');
  const { activities, result } = replay(lines, parseAmpLine);
  assert.ok(result);
  // three real toolu_bdrk_...|fc_tmp_... starts, ending out of order (a, c, b) — a naive
  // "attach to last entry" fallback would mark every result on the c.txt row.
  const log = collectActivityLog(activities);
  const aRow = log.find(l => l.includes('a.txt'));
  const bRow = log.find(l => l.includes('b.txt'));
  const cRow = log.find(l => l.includes('c.txt'));
  assert.ok(aRow?.endsWith('✓'), `a.txt row should be marked done, got: ${aRow}`);
  assert.ok(bRow?.endsWith('✓'), `b.txt row should be marked done, got: ${bRow}`);
  assert.ok(cRow?.endsWith('✓'), `c.txt row should be marked done, got: ${cRow}`);
  // real usage.cost.total/usage.{input,output} are per-turn, not cumulative — three turn_end
  // events in the fixture, so a genuine total requires summing them, not taking the last one.
  assert.equal(result?.numTurns, 3);
  assert.ok(
    typeof result?.totalCostUsd === 'number' && Math.abs(result.totalCostUsd - (0.088193 + 0.089507 + 0.116241)) < 1e-9,
  );
  assert.equal(result?.usage?.inputTokens, 87273 + 87632 + 115596);
  assert.equal(result?.usage?.outputTokens, 184 + 375 + 129);
});
