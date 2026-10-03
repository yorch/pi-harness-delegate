import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acpView, runAcpHarness } from '../extensions/acp-runner.ts';
import { buildTranscript, describeBudget, formatBudgetLine } from '../extensions/activity.ts';
import { claudeHarness } from '../extensions/harnesses/claude.ts';
import { opencodeHarness } from '../extensions/harnesses/opencode.ts';
import type { Harness } from '../extensions/harnesses/types.ts';
import { isCostOverBudget, isOverBudget, runHarness } from '../extensions/runner.ts';

test('describeBudget: undefined when no budget was set', () => {
  assert.equal(
    describeBudget({ harness: 'codex', limitUsd: undefined, native: false, costUsd: null, stoppedByHost: false }),
    undefined,
  );
});

test('describeBudget: no native flag and no reported cost is flagged as unenforced', () => {
  const b = describeBudget({ harness: 'codex', limitUsd: 2, native: false, costUsd: null, stoppedByHost: false });
  assert.equal(b?.enforcement, 'unenforced');
  assert.equal(b?.exceeded, false);
  assert.match(b?.message ?? '', /not enforced — codex has no native budget flag and reported no cost/);
  assert.match(formatBudgetLine(b as NonNullable<typeof b>), /NOT enforced/);
});

test('describeBudget: a host-stopped run is recorded as budget exceeded', () => {
  const b = describeBudget({ harness: 'opencode', limitUsd: 0.5, native: false, costUsd: 0.6, stoppedByHost: true });
  assert.equal(b?.enforcement, 'host');
  assert.equal(b?.exceeded, true);
  assert.match(b?.message ?? '', /budget exceeded: opencode reported \$0\.600 against a \$0\.500 cap — run stopped/);
  assert.match(b?.message ?? '', /best-effort: .*can overshoot the cap/);
});

test('describeBudget: host-enforced and within budget is silent; native is never flagged unenforced', () => {
  const ok = describeBudget({ harness: 'amp', limitUsd: 1, native: false, costUsd: 0.2, stoppedByHost: false });
  assert.deepEqual(ok, { limitUsd: 1, enforcement: 'host', exceeded: false, message: null });
  const native = describeBudget({ harness: 'claude', limitUsd: 1, native: true, costUsd: null, stoppedByHost: false });
  assert.equal(native?.enforcement, 'native');
  assert.equal(native?.message, null);
});

test('buildTranscript: records the budget line and its message', () => {
  const budget = describeBudget({
    harness: 'opencode',
    limitUsd: 0.5,
    native: false,
    costUsd: 0.6,
    stoppedByHost: true,
  });
  const t = buildTranscript({
    harness: 'opencode',
    mode: 'general',
    model: null,
    cwd: '/r',
    sessionId: null,
    resumed: false,
    numTurns: 2,
    totalCostUsd: 0.6,
    isError: true,
    stopReason: 'budget_exceeded',
    durationMs: null,
    usage: null,
    contextPercent: null,
    contextWindow: null,
    activityLog: [],
    output: 'partial',
    budget,
  });
  assert.ok(t.includes('- budget: $0.500 (host-enforced, best-effort) · budget exceeded'));
  assert.ok(t.includes('run stopped'));
});

test('isOverBudget: only for non-native harnesses with a measured running cost over the cap', () => {
  const r = (cost: number | null) => ({ totalCostUsd: cost }) as Parameters<typeof isOverBudget>[2];
  assert.equal(isOverBudget(opencodeHarness, 1, r(1.5)), true);
  assert.equal(isOverBudget(opencodeHarness, 1, r(1)), false);
  assert.equal(isOverBudget(opencodeHarness, 1, r(null)), false);
  assert.equal(isOverBudget(opencodeHarness, undefined, r(5)), false);
  assert.equal(isOverBudget(claudeHarness, 1, r(5)), false, 'claude enforces natively');
});

function nodeHarness(base: Harness, script: string): Harness {
  return { ...base, binary: process.execPath, buildArgs: () => ['-e', script] };
}

test('runHarness: kills a non-native harness as soon as its streamed cost exceeds maxBudgetUsd', async () => {
  const step = (cost: number) => JSON.stringify({ type: 'step_finish', sessionID: 's', part: { cost, tokens: {} } });
  // two steps cross the 0.5 cap, then the "harness" would keep going for 20s if not stopped
  const script = `console.log(${JSON.stringify(step(0.3))}); console.log(${JSON.stringify(step(0.3))}); setTimeout(() => {}, 20000);`;
  const started = Date.now();
  const res = await runHarness({
    harness: nodeHarness(opencodeHarness, script),
    prompt: 'p',
    cwd: process.cwd(),
    permission: 'edit',
    maxBudgetUsd: 0.5,
    timeoutMs: 30_000,
  });
  assert.ok(Date.now() - started < 10_000, 'must stop well before the harness would have exited');
  assert.equal(res.budgetExceeded, true);
  assert.equal(res.isError, true);
  assert.equal(res.stopReason, 'budget_exceeded');
  assert.ok(Math.abs((res.totalCostUsd ?? 0) - 0.6) < 1e-9);
});

test('runHarness: a native-budget harness is never killed by the host check', async () => {
  const line = JSON.stringify({ type: 'result', result: 'ok', total_cost_usd: 5, num_turns: 1 });
  const res = await runHarness({
    harness: nodeHarness(claudeHarness, `console.log(${JSON.stringify(line)})`),
    prompt: 'p',
    cwd: process.cwd(),
    permission: 'edit',
    maxBudgetUsd: 1,
  });
  assert.equal(res.budgetExceeded, undefined);
  assert.equal(res.isError, false);
});

test('isCostOverBudget: only the delta over the baseline counts', () => {
  assert.equal(isCostOverBudget(opencodeHarness, 0.5, 5.2, 5), false);
  assert.equal(isCostOverBudget(opencodeHarness, 0.5, 5.6, 5), true);
  assert.equal(isCostOverBudget(opencodeHarness, 0.5, 0.6), true);
  assert.equal(isCostOverBudget(opencodeHarness, 0.5, null), false);
});

/**
 * A fake opencode ACP agent. `costs` are the session-cumulative `usage_update.cost.amount` values
 * sent after `session/prompt`; `replayCost` (on `session/load`) simulates a replayed prior-turn
 * total. With `hang`, the prompt response is never sent — only a host-side kill ends the run.
 */
function fakeOpencodeAcp(opts: { costs: number[]; replayCost?: number; hang?: boolean }): Harness {
  const script = `
const readline = require('node:readline');
const opts = ${JSON.stringify(opts)};
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const upd = (u) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1', update: u } });
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
  else if (msg.method === 'session/new') send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's1', modes: {} } });
  else if (msg.method === 'session/load') {
    upd({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OLD' } });
    if (opts.replayCost !== undefined) upd({ sessionUpdate: 'usage_update', size: 1000, used: 10, cost: { amount: opts.replayCost, currency: 'USD' } });
    send({ jsonrpc: '2.0', id: msg.id, result: { modes: {} } });
  } else if (msg.method === 'session/set_mode') send({ jsonrpc: '2.0', id: msg.id, result: {} });
  else if (msg.method === 'session/prompt') {
    upd({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'NEW' } });
    for (const c of opts.costs) upd({ sessionUpdate: 'usage_update', size: 1000, used: 10, cost: { amount: c, currency: 'USD' } });
    if (opts.hang) setTimeout(() => {}, 20000);
    else send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } } });
  }
});`;
  const view = acpView(opencodeHarness);
  return { ...view, binary: process.execPath, buildArgs: () => ['-e', script] };
}

test('runAcpHarness: kills a fresh run mid-turn as soon as the streamed cost exceeds maxBudgetUsd', async () => {
  const started = Date.now();
  const res = await runAcpHarness({
    harness: fakeOpencodeAcp({ costs: [0.2, 0.6], hang: true }),
    prompt: 'p',
    cwd: process.cwd(),
    permission: 'edit',
    maxBudgetUsd: 0.5,
    timeoutMs: 30_000,
  });
  assert.ok(Date.now() - started < 10_000, 'must stop before the turn ends, not wait for the prompt response');
  assert.equal(res.budgetExceeded, true);
  assert.equal(res.stopReason, 'budget_exceeded');
  assert.equal(res.totalCostUsd, 0.6);
  assert.equal(res.sessionId, 's1');
});

test('runAcpHarness: a fresh run within budget completes normally', async () => {
  const res = await runAcpHarness({
    harness: fakeOpencodeAcp({ costs: [0.1, 0.3] }),
    prompt: 'p',
    cwd: process.cwd(),
    permission: 'edit',
    maxBudgetUsd: 0.5,
    timeoutMs: 10_000,
  });
  assert.equal(res.budgetExceeded, undefined);
  assert.equal(res.isError, false);
  assert.equal(res.totalCostUsd, 0.3);
});

test('runAcpHarness: on resume, prior turns in a session-cumulative cost never count against the cap', async () => {
  for (const replayCost of [undefined, 5]) {
    const res = await runAcpHarness({
      harness: fakeOpencodeAcp({ costs: [5.1, 5.3], replayCost }),
      prompt: 'p',
      cwd: process.cwd(),
      permission: 'edit',
      maxBudgetUsd: 0.5,
      timeoutMs: 10_000,
      resumeSessionId: 's1',
    });
    assert.equal(res.budgetExceeded, undefined, `replayCost=${replayCost}`);
    assert.equal(res.isError, false);
  }
});

test('runAcpHarness: on resume, new spend past the cap still stops the run', async () => {
  const res = await runAcpHarness({
    harness: fakeOpencodeAcp({ costs: [5.1, 5.7], replayCost: 5, hang: true }),
    prompt: 'p',
    cwd: process.cwd(),
    permission: 'edit',
    maxBudgetUsd: 0.5,
    timeoutMs: 30_000,
    resumeSessionId: 's1',
  });
  assert.equal(res.budgetExceeded, true);
  assert.equal(res.stopReason, 'budget_exceeded');
});

// ── reported cost on a resumed session-cumulative run ──────────────────────

const close = (actual: number | null, expected: number, msg?: string) =>
  assert.ok(actual !== null && Math.abs(actual - expected) < 1e-9, `${msg ?? ''} expected ~${expected}, got ${actual}`);

test('runAcpHarness: a resumed run reports only its own spend, not the session total (no double count)', async () => {
  const run = (costs: number[], replayCost?: number, hang = false) =>
    runAcpHarness({
      harness: fakeOpencodeAcp({ costs, replayCost, hang }),
      prompt: 'p',
      cwd: process.cwd(),
      permission: 'edit',
      maxBudgetUsd: hang ? 0.5 : undefined,
      timeoutMs: 30_000,
      resumeSessionId: 's1',
    });
  // replayed baseline: an exact delta
  close((await run([5.1, 5.3], 5)).totalCostUsd, 0.3, 'replayed baseline');
  // no replayed baseline: the first post-prompt total is already partly this run's spend, so any
  // delta from it (0.2 here) would silently omit that first step — unmeasured instead
  assert.equal((await run([5.1, 5.3])).totalCostUsd, null);
  // one post-prompt sample and no replay: the delta would be a fake $0 — unmeasured instead
  assert.equal((await run([5.1])).totalCostUsd, null);
  // ...while the budget check still trips off that same first-sample baseline (documented bias)
  const stoppedNoReplay = await run([5.1, 5.7], undefined, true);
  assert.equal(stoppedNoReplay.budgetExceeded, true);
  assert.equal(stoppedNoReplay.totalCostUsd, null);
  // no cost at all during this run: whatever was replayed is prior spend, not this run's
  assert.equal((await run([], 5)).totalCostUsd, null);
  // a budget-stopped resume reports the delta too, not the cumulative total it was killed at
  const stopped = await run([5.1, 5.7], 5, true);
  assert.equal(stopped.budgetExceeded, true);
  close(stopped.totalCostUsd, 0.7, 'budget-stopped');
});

test('runAcpHarness: a fresh run still reports the running total as-is', async () => {
  const res = await runAcpHarness({
    harness: fakeOpencodeAcp({ costs: [0.1, 0.3] }),
    prompt: 'p',
    cwd: process.cwd(),
    permission: 'edit',
    timeoutMs: 10_000,
  });
  assert.equal(res.totalCostUsd, 0.3);
});

test('resumedRunCost: pure delta rules', async () => {
  const { resumedRunCost } = await import('../extensions/acp-runner.ts');
  const base = { resumed: true, baselineFromReplay: true, postPromptCostSamples: 2 };
  assert.equal(resumedRunCost({ ...base, resumed: false, totalCostUsd: 3, baselineUsd: 0 }), 3);
  assert.equal(resumedRunCost({ ...base, totalCostUsd: null, baselineUsd: 1 }), null);
  assert.equal(resumedRunCost({ ...base, totalCostUsd: 3, baselineUsd: 1 }), 2);
  assert.equal(resumedRunCost({ ...base, totalCostUsd: 3, baselineUsd: undefined }), null);
  assert.equal(resumedRunCost({ ...base, totalCostUsd: 3, baselineUsd: 1, postPromptCostSamples: 0 }), null);
  // first-sample baseline: never a measured-looking delta, however many samples followed
  for (const postPromptCostSamples of [1, 2, 5])
    assert.equal(
      resumedRunCost({ ...base, totalCostUsd: 3, baselineUsd: 2.5, baselineFromReplay: false, postPromptCostSamples }),
      null,
    );
  // never negative, even if an agent's running total goes backwards
  assert.equal(resumedRunCost({ ...base, totalCostUsd: 1, baselineUsd: 2 }), 0);
});
