import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildTranscript, describeBudget, formatBudgetLine } from '../extensions/activity.ts';
import { claudeHarness } from '../extensions/harnesses/claude.ts';
import { opencodeHarness } from '../extensions/harnesses/opencode.ts';
import type { Harness } from '../extensions/harnesses/types.ts';
import { isOverBudget, runHarness } from '../extensions/runner.ts';

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
  assert.ok(t.includes('- budget: $0.500 (host-enforced) · budget exceeded'));
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
