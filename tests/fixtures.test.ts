import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { collectActivityLog } from '../extensions/activity.ts';
import { parseAmpLine } from '../extensions/harnesses/amp.ts';
import { parseClaudeLine } from '../extensions/harnesses/claude.ts';
import { parseCodexLine } from '../extensions/harnesses/codex.ts';
import { parseDevinLine } from '../extensions/harnesses/devin.ts';
import { parseOpencodeAcpLine, parseOpencodeLine } from '../extensions/harnesses/opencode.ts';
import type { ActivityEvent, ParseState, StreamedResult } from '../extensions/harnesses/types.ts';

function loadFixture(name: string): string[] {
  const p = join(import.meta.dirname, 'fixtures', name);
  return readFileSync(p, 'utf8').split('\n').filter(Boolean);
}

/** Feed every line of a fixture through a parser, returning the accumulated activities and final result.
 *  Accumulates streamedText into state.streamedText the same way runner.ts/acp-runner.ts do — needed for
 *  harnesses (like devin's) whose final result has no text field of its own and falls back to it. */
function replay(
  lines: string[],
  parseLine: (
    line: string,
    state: ParseState,
  ) => { streamedText?: string; activities?: ActivityEvent[]; result?: StreamedResult | null },
): { activities: ActivityEvent[]; result: StreamedResult | null } {
  const state: ParseState = { streamedText: '', activities: [], result: null };
  const activities: ActivityEvent[] = [];
  let result: StreamedResult | null = null;
  for (const l of lines) {
    const out = parseLine(l, state);
    if (out.streamedText) state.streamedText += out.streamedText;
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

test('codex-resume.jsonl: a fresh process resuming a prior session genuinely recalls its context', () => {
  // Real, live-captured two-process resume: turn 1 (codex exec) taught the model a fact and was
  // killed; turn 2 is an independent `codex exec resume <id> <prompt>` process asking for it back.
  // Split on the second thread.started line so each turn replays through its own fresh ParseState,
  // matching how two separate spawned processes actually behave — resume must not depend on any
  // in-memory state surviving between them.
  const lines = loadFixture('codex-resume.jsonl');
  const splitAt = lines.indexOf('{"type":"thread.started","thread_id":"01a052bb-0000-0000-0000-000000000001"}', 2);
  assert.ok(splitAt > 0, 'expected a second thread.started line to split on');

  const turn1 = replay(lines.slice(0, splitAt), parseCodexLine);
  assert.ok(turn1.result);
  assert.equal(turn1.result?.sessionId, '01a052bb-0000-0000-0000-000000000001');
  assert.equal(turn1.result?.isError, false);
  assert.ok(turn1.result?.result.includes('OK'));

  // A leading non-JSON "Reading additional input from stdin..." line (real codex-cli output when
  // stdin isn't a TTY) must not crash the parser — it's tolerated as plain text, per the
  // tolerant-parsing convention (AGENTS.md scope notes).
  assert.doesNotThrow(() => replay(lines.slice(0, splitAt), parseCodexLine));

  const turn2 = replay(lines.slice(splitAt), parseCodexLine); // fresh state — a genuinely new process
  assert.ok(turn2.result);
  assert.equal(turn2.result?.sessionId, '01a052bb-0000-0000-0000-000000000001', 'resume reports the same session id');
  assert.equal(turn2.result?.isError, false);
  // The passphrase was only ever told to turn 1 — a fresh process recalling it proves resume
  // genuinely restores prior context rather than just accepting/echoing the session id.
  assert.ok(
    turn2.result?.result.includes('quokka-nebula-77'),
    `expected recalled passphrase, got: ${turn2.result?.result}`,
  );
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

test('amp-error.jsonl: a real 429 quota rejection is reported as isError, not a silent empty success', () => {
  // Real, live-captured omp turn_end/agent_end where message.content is an empty array (the error
  // never became assistant text) and the failure only shows up as message.stopReason === "error" +
  // message.errorMessage. Found by the live integration suite (tests/live.test.ts) — before the
  // fix, parseAmpLine only checked the top-level `is_error` field (never set here) and fell back to
  // empty streamedText, so this surfaced as a "successful" run with an empty result.
  const lines = loadFixture('amp-error.jsonl');
  const { result } = replay(lines, parseAmpLine);
  assert.ok(result);
  assert.equal(result?.isError, true);
  assert.ok(result?.result.includes('429 Monthly usage limit reached'), result?.result);
});

test('devin-acp.jsonl: real toolCallId correlates tool_call/tool_call_update across a genuine ACP session', () => {
  const lines = loadFixture('devin-acp.jsonl');
  const { activities, result } = replay(lines, parseDevinLine);
  assert.ok(result);
  assert.equal(result?.sessionId, 'cactus-iberis');
  assert.equal(result?.stopReason, 'end_turn');
  // The real model Devin ran, read back from _cognition.ai/agent_stopped's stats.modelLabel —
  // independent of whatever --model was requested, since --model accepts fuzzy names.
  assert.equal(result?.model, 'GLM-5.2 High');
  // Devin's ACP payload reports no $ cost and no turn count — honest-metrics convention (#11).
  assert.equal(result?.totalCostUsd, null);
  assert.equal(result?.numTurns, null);
  assert.equal(result?.contextWindow, 200000); // from usage_update's `size`
  // Devin's inputTokens (66446) already includes cachedReadTokens (66124) as a subset — our
  // StreamedUsage.inputTokens must exclude cache reads (index.ts adds them back in separately
  // to compute promptTokens), so the real "new" input is 66446 - 66124 = 322.
  assert.equal(result?.usage?.inputTokens, 322);
  assert.equal(result?.usage?.outputTokens, 45);
  assert.equal(result?.usage?.cacheReadInputTokens, 66124);
  assert.equal(result?.usage?.cacheCreationInputTokens, 0); // not reported over ACP
  // promptTokens (index.ts: inputTokens + cacheCreationInputTokens + cacheReadInputTokens) must
  // reconstruct Devin's own real inputTokens figure exactly, and the context % must match Devin's
  // own used/size (66491/200000 ≈ 33%), not a double-counted ~66%.
  const promptTokens =
    (result?.usage?.inputTokens ?? 0) +
    (result?.usage?.cacheCreationInputTokens ?? 0) +
    (result?.usage?.cacheReadInputTokens ?? 0);
  assert.equal(promptTokens, 66446);
  assert.ok(result?.contextWindow);
  const contextPercent = (promptTokens / (result?.contextWindow ?? 1)) * 100;
  assert.ok(Math.abs(contextPercent - 33.223) < 0.01, `expected ~33.2%, got ${contextPercent}`);
  // the prompt response carries no text of its own — falls back to accumulated agent_message_chunk text.
  assert.ok(result?.result.includes('math.js') && result.result.includes('greet.js'), result?.result);

  // 4 real tool calls (2x find_file_by_name, 2x read), each a genuine `chatcmpl-tool-...` toolCallId.
  // Each fires 2-3 `tool_call_update` events (in_progress, sometimes twice) before its terminal
  // completed/failed — only the terminal one should produce a tool_result, or a naive "every
  // update produces a result" parser would exhaust ToolCallIndex's pending entry on the first
  // in_progress update and strand the real completion unattributed.
  const log = collectActivityLog(activities);
  const toolLines = log.filter(l => l.startsWith('▶'));
  assert.equal(toolLines.length, 4);
  assert.ok(
    toolLines.every(l => l.endsWith('✓')),
    `every tool call should resolve, got: ${toolLines}`,
  );
  assert.ok(log.some(l => l.includes('find_file_by_name') && l.includes('math.js')));
  assert.ok(log.some(l => l.includes('find_file_by_name') && l.includes('greet.js')));
  assert.ok(log.some(l => l.includes('read') && l.includes('math.js')));
  assert.ok(log.some(l => l.includes('read') && l.includes('greet.js')));
  // 8 agent_thought_chunk events -> 8 thinking activities, distinct from the 4 tool_input + 4 tool_result.
  assert.equal(activities.filter(a => a.kind === 'thinking').length, 8);
});

test('devin-acp.jsonl: unrecognized session/update kinds (config_option_update, available_commands_update, etc.) are ignored, not thrown', () => {
  const lines = loadFixture('devin-acp.jsonl');
  const state: ParseState = { streamedText: '', activities: [], result: null };
  for (const l of lines) {
    assert.doesNotThrow(() => parseDevinLine(l, state));
  }
});

test('opencode-acp.jsonl: real toolCallId correlates tool_call/tool_call_update, genuine cost/contextWindow/usage extracted', () => {
  // First 29 lines: the fresh session/prompt turn, before the session/load resume replay below —
  // isolating it here keeps this test's counts unambiguous; the resume replay (same toolCallIds,
  // by design) is covered separately below.
  const lines = loadFixture('opencode-acp.jsonl').slice(0, 29);
  const { activities, result } = replay(lines, parseOpencodeAcpLine);
  assert.ok(result);
  assert.equal(result?.sessionId, 'ses_REDACTEDsessionid0001');
  assert.equal(result?.stopReason, 'end_turn');
  assert.equal(result?.isError, false);
  // Real over ACP, unlike stdout's always-null contextWindow and only-sometimes-real cost — $0
  // here because the captured run happened to be on a $0-cost promotional model, not because the
  // field is absent (docs/acp-harness-assessment.md §2).
  assert.equal(result?.contextWindow, 200000);
  assert.equal(result?.totalCostUsd, 0);
  // never observed populated over ACP for opencode — honest null, not a guess.
  assert.equal(result?.numTurns, null);
  assert.equal(result?.model, null);
  // opencode's inputTokens already excludes cachedReadTokens (unlike Devin's) — no adjustment.
  assert.equal(result?.usage?.inputTokens, 326);
  assert.equal(result?.usage?.outputTokens, 31);
  assert.equal(result?.usage?.cacheReadInputTokens, 71424);
  assert.equal(result?.usage?.cacheCreationInputTokens, 0);
  assert.ok(result?.result.includes('README.md') && result.result.includes('scratch repo for ACP probing'));

  // 3 real tool calls (read dir, glob, read file), each a genuine `call_...` toolCallId, each
  // firing an `in_progress` update before its terminal `completed` — only the terminal one should
  // produce a tool_result.
  const log = collectActivityLog(activities);
  const toolLines = log.filter(l => l.startsWith('▶'));
  assert.equal(toolLines.length, 3);
  assert.ok(
    toolLines.every(l => l.endsWith('✓')),
    `every tool call should resolve, got: ${toolLines}`,
  );
  assert.equal(activities.filter(a => a.kind === 'thinking').length, 5);
});

test("opencode-acp.jsonl: the session/load resume replay (no stopReason of its own) never clobbers the real turn's result", () => {
  const lines = loadFixture('opencode-acp.jsonl'); // full 40 lines, including the session/load replay
  const state: ParseState = { streamedText: '', activities: [], result: null };
  let result: StreamedResult | null = null;
  for (const l of lines) {
    assert.doesNotThrow(() => {
      const out = parseOpencodeAcpLine(l, state);
      if (out.result) result = out.result;
    });
  }
  // session/load's own response has `configOptions` but no `stopReason` — parseOpencodeAcpLine
  // correctly produces no `result` for it, so the real turn's result (from the earlier
  // session/prompt response) is still what a caller sees.
  assert.ok(result);
  assert.equal((result as unknown as StreamedResult).stopReason, 'end_turn');
});

test('opencode-acp-build-write.jsonl: a live-verified write under `build` mode — real `edit`-kind tool_call, no session/request_permission anywhere', () => {
  const lines = loadFixture('opencode-acp-build-write.jsonl');
  // The single blocking unknown docs/acp-harness-assessment.md §4/§7 left open for opencode ACP:
  // does `build` mode ever call back session/request_permission (which this project's ACP client
  // auto-declines)? This fixture is that second live run's answer — it never does.
  assert.ok(!lines.some(l => l.includes('request_permission')), 'expected no session/request_permission call');

  const { activities, result } = replay(lines, parseOpencodeAcpLine);
  assert.ok(result);
  assert.equal(result?.stopReason, 'end_turn');
  assert.equal(result?.isError, false);
  const log = collectActivityLog(activities);
  const writeRow = log.find(l => l.includes('write'));
  assert.ok(writeRow?.endsWith('✓'), `expected the write tool_call to resolve, got: ${writeRow}`);
});
