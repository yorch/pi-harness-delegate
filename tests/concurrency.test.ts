import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DelegateConfig } from '../extensions/config.ts';
import { withEnv } from './helpers/env.ts';

function withAgentDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'concurrency-test-'));
  return withEnv({ PI_CODING_AGENT_DIR: dir }, () => fn(dir)).finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}

function makeConfig(maxConcurrent: DelegateConfig['maxConcurrent']): DelegateConfig {
  return {
    timeoutMs: 60_000,
    defaultMode: 'general',
    defaultHarness: 'claude',
    allowDangerous: false,
    inspectThinking: false,
    autoDelegateHints: false,
    modelAliases: {},
    maxConcurrent,
    maxTranscripts: 100,
    harnesses: {},
  };
}

/** Yield to the event loop once — a condition-free "let other work run" with no wall-clock duration. */
function yieldTurn(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

/**
 * A manually-stepped replacement for acquireSlot's poll `sleep`. Each poll parks until `step()`, so
 * a test can observe "the waiter has polled N times and is still blocked" deterministically instead
 * of sleeping a fixed duration and hoping the waiter got far enough. Honors the abort signal.
 */
function manualPoller() {
  let polls = 0;
  let parked: Array<() => void> = [];
  const pollWatchers: Array<{ n: number; resolve: () => void }> = [];
  const sleep = (_ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('aborted'));
      const onAbort = () => reject(new Error('aborted'));
      signal?.addEventListener('abort', onAbort, { once: true });
      parked.push(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      });
      polls++;
      for (const w of pollWatchers.splice(0)) {
        if (polls >= w.n) w.resolve();
        else pollWatchers.push(w);
      }
    });
  return {
    sleep,
    get polls() {
      return polls;
    },
    /** Resolves once at least `n` polls have parked in total. */
    untilPolls(n: number): Promise<void> {
      return polls >= n ? Promise.resolve() : new Promise(resolve => pollWatchers.push({ n, resolve }));
    },
    /** Wake every currently-parked poll. */
    step(): void {
      const wake = parked;
      parked = [];
      for (const w of wake) w();
    },
  };
}

test('acquireSlot: wait:false throws immediately at global capacity', async () => {
  await withAgentDir(async () => {
    const { acquireSlot, ConcurrencyLimitError } = await import('../extensions/concurrency.ts');
    const config = makeConfig(1);
    const release = await acquireSlot({ harness: 'claude', mode: 'review', config, wait: false });
    await assert.rejects(
      () => acquireSlot({ harness: 'codex', mode: 'review', config, wait: false }),
      (err: unknown) => err instanceof ConcurrencyLimitError && /global limit/.test((err as Error).message),
    );
    release();
  });
});

test('acquireSlot: wait:false throws immediately at per-harness capacity', async () => {
  await withAgentDir(async () => {
    const { acquireSlot, ConcurrencyLimitError } = await import('../extensions/concurrency.ts');
    const config = makeConfig({ global: 4, perHarness: { claude: 1 } });
    const release = await acquireSlot({ harness: 'claude', mode: 'review', config, wait: false });
    await assert.rejects(
      () => acquireSlot({ harness: 'claude', mode: 'plan', config, wait: false }),
      (err: unknown) =>
        err instanceof ConcurrencyLimitError && /claude run is already in progress/.test((err as Error).message),
    );
    // a different harness still has headroom under the global cap
    const releaseOther = await acquireSlot({ harness: 'codex', mode: 'review', config, wait: false });
    release();
    releaseOther();
  });
});

test('acquireSlot: wait:true queues until a slot frees instead of throwing', async () => {
  await withAgentDir(async () => {
    const { acquireSlot } = await import('../extensions/concurrency.ts');
    const config = makeConfig(1);
    const release = await acquireSlot({ harness: 'claude', mode: 'review', config, wait: false });

    let acquired = false;
    const poller = manualPoller();
    const waiter = acquireSlot({ harness: 'codex', mode: 'review', config, wait: true, sleep: poller.sleep }).then(
      r => {
        acquired = true;
        return r;
      },
    );

    // two full polls that each found the slot held — the waiter queued instead of throwing
    await poller.untilPolls(1);
    poller.step();
    await poller.untilPolls(2);
    assert.equal(acquired, false, 'waiter must not acquire while the slot is held');
    release();
    poller.step();
    const releaseWaiter = await waiter;
    assert.equal(acquired, true);
    releaseWaiter();
  });
});

test('acquireSlot: wait:true with an aborted signal rejects instead of hanging', async () => {
  await withAgentDir(async () => {
    const { acquireSlot } = await import('../extensions/concurrency.ts');
    const config = makeConfig(1);
    const release = await acquireSlot({ harness: 'claude', mode: 'review', config, wait: false });
    const ac = new AbortController();
    const waiter = acquireSlot({ harness: 'codex', mode: 'review', config, wait: true, signal: ac.signal });
    ac.abort();
    await assert.rejects(() => waiter, /aborted/i);
    release();
  });
});

test('acquireSlot: a bounded pool of concurrent waiters never exceeds the cap', async () => {
  await withAgentDir(async () => {
    const { acquireSlot } = await import('../extensions/concurrency.ts');
    const config = makeConfig(3);
    let current = 0;
    let peak = 0;
    const worker = async (i: number) => {
      const release = await acquireSlot({
        harness: `h${i % 5}`,
        mode: 'review',
        config,
        wait: true,
        sleep: yieldTurn,
      });
      current++;
      peak = Math.max(peak, current);
      for (let t = 0; t < 1 + (i % 4); t++) await yieldTurn();
      current--;
      release();
    };
    await Promise.all(Array.from({ length: 12 }, (_, i) => worker(i)));
    assert.ok(peak <= 3, `peak concurrent holders ${peak} exceeded cap of 3`);
    assert.equal(current, 0);
  });
});

test('acquireSlot: respects active runs already reported by the cross-process registry', async () => {
  await withAgentDir(async () => {
    const { acquireRun, releaseRun } = await import('../extensions/run-registry.ts');
    const { acquireSlot, ConcurrencyLimitError } = await import('../extensions/concurrency.ts');
    // simulate another pi process already holding both of the 2 available global slots
    const external1 = acquireRun('claude', 'review');
    const external2 = acquireRun('codex', 'plan');
    const config = makeConfig(2);
    await assert.rejects(
      () => acquireSlot({ harness: 'opencode', mode: 'review', config, wait: false }),
      ConcurrencyLimitError,
    );
    // freeing one external slot lets a waiter through
    let acquired = false;
    const poller = manualPoller();
    const waiter = acquireSlot({ harness: 'opencode', mode: 'review', config, wait: true, sleep: poller.sleep }).then(
      r => {
        acquired = true;
        return r;
      },
    );
    await poller.untilPolls(1);
    assert.equal(acquired, false);
    releaseRun(external1);
    poller.step();
    const release = await waiter;
    assert.equal(acquired, true);
    release();
    releaseRun(external2);
  });
});

test('activeCount: combines the in-process counter with the cross-process registry', async () => {
  await withAgentDir(async () => {
    const { acquireSlot, activeCount } = await import('../extensions/concurrency.ts');
    const { acquireRun, releaseRun } = await import('../extensions/run-registry.ts');
    assert.equal(activeCount(), 0);
    const release = await acquireSlot({ harness: 'claude', mode: 'review', config: makeConfig(5), wait: false });
    assert.equal(activeCount(), 1);
    assert.equal(activeCount('claude'), 1);
    // a foreign run recorded only in the registry (not via acquireSlot) still counts
    const external = acquireRun('codex', 'plan');
    assert.equal(activeCount(), 2);
    assert.equal(activeCount('codex'), 1);
    release();
    releaseRun(external);
    assert.equal(activeCount(), 0);
  });
});

test('acquireSlot: one shared AbortController cancels every still-queued waiter, like a fan-out cancel', async () => {
  await withAgentDir(async () => {
    const { acquireSlot, activeCount } = await import('../extensions/concurrency.ts');
    const config = makeConfig(1);
    // one "run" holds the only slot, simulating a harness already in flight
    const release = await acquireSlot({ harness: 'claude', mode: 'review', config, wait: false });

    const ac = new AbortController();
    const poller = manualPoller();
    const waiters = ['codex', 'opencode', 'amp'].map(h =>
      acquireSlot({ harness: h, mode: 'review', config, wait: true, signal: ac.signal, sleep: poller.sleep }),
    );

    await poller.untilPolls(3); // every waiter is parked in its poll, i.e. genuinely queued
    ac.abort();
    for (const waiter of waiters) {
      await assert.rejects(() => waiter, /aborted/i);
    }
    // the in-flight run's own slot is untouched by the other runs' cancellation — it must be
    // released explicitly, exactly like a real "still-running when cancel was pressed" harness
    assert.equal(activeCount(), 1);
    release();
    assert.equal(activeCount(), 0);
  });
});

test('acquireSlot: in-process counters never absorb another process’s registry entries', async () => {
  await withAgentDir(async dir => {
    const { acquireSlot, activeCount, inProcessActiveCount } = await import('../extensions/concurrency.ts');
    const { countActiveRuns } = await import('../extensions/run-registry.ts');
    // a run owned by a different (live) pid — what another pi process would have written
    const runs = join(dir, 'delegate', 'runs');
    mkdirSync(runs, { recursive: true });
    const foreign = join(runs, `${process.ppid}-claude-foreign.json`);
    writeFileSync(foreign, JSON.stringify({ pid: process.ppid, harness: 'claude', mode: 'review', startedAt: 0 }));
    assert.equal(countActiveRuns('claude'), 1);

    const release = await acquireSlot({ harness: 'claude', mode: 'review', config: makeConfig(5), wait: false });
    assert.equal(inProcessActiveCount('claude'), 1, 'only our own run counts in-process');
    assert.equal(inProcessActiveCount(), 1);
    assert.equal(activeCount('claude'), 2, 'combined view still sees both');
    release();
    assert.equal(inProcessActiveCount('claude'), 0);
    assert.equal(inProcessActiveCount(), 0);

    // once the foreign run ends, nothing of it lingers in our counters
    rmSync(foreign, { force: true });
    assert.equal(activeCount('claude'), 0);
    assert.equal(activeCount(), 0);
  });
});

test('pollDelayMs: interval plus bounded jitter, deterministic given random', async () => {
  const { pollDelayMs, POLL_JITTER_FRACTION } = await import('../extensions/concurrency.ts');
  assert.equal(
    pollDelayMs(200, () => 0),
    200,
  );
  assert.equal(
    pollDelayMs(200, () => 0.5),
    200 + Math.floor(200 * POLL_JITTER_FRACTION * 0.5),
  );
  assert.equal(
    pollDelayMs(200, () => 0.999999),
    200 + Math.floor(200 * POLL_JITTER_FRACTION * 0.999999),
  );
  // out-of-range randoms are clamped — never below the interval, never past the jitter cap
  assert.equal(
    pollDelayMs(200, () => -3),
    200,
  );
  assert.equal(
    pollDelayMs(200, () => 7),
    200 + 200 * POLL_JITTER_FRACTION,
  );
  // non-finite draws get no jitter — NaN must never reach setTimeout (it would fire at 0ms)
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])
    assert.equal(
      pollDelayMs(200, () => bad),
      200,
      String(bad),
    );
  for (let i = 0; i < 100; i++) {
    const d = pollDelayMs(100);
    assert.ok(d >= 100 && d <= 100 + 100 * POLL_JITTER_FRACTION, String(d));
  }
});

test('acquireSlot: a waiting poll draws its jitter from the injected random', async () => {
  await withAgentDir(async () => {
    const { acquireSlot } = await import('../extensions/concurrency.ts');
    const config = makeConfig(1);
    const release = await acquireSlot({ harness: 'claude', mode: 'review', config, wait: false });
    let draws = 0;
    const poller = manualPoller();
    const waiter = acquireSlot({
      harness: 'codex',
      mode: 'review',
      config,
      wait: true,
      sleep: poller.sleep,
      random: () => {
        draws++;
        return 0;
      },
    });
    await poller.untilPolls(1);
    poller.step();
    await poller.untilPolls(2);
    assert.equal(draws, poller.polls, 'every poll pause goes through the injected random');
    release();
    poller.step();
    const release2 = await waiter;
    release2();
  });
});

test('acquireSlot: the jittered delay is what each poll actually sleeps for', async () => {
  await withAgentDir(async () => {
    const { acquireSlot, POLL_JITTER_FRACTION } = await import('../extensions/concurrency.ts');
    const config = makeConfig(1);
    const release = await acquireSlot({ harness: 'claude', mode: 'review', config, wait: false });
    const slept: number[] = [];
    const waiter = acquireSlot({
      harness: 'codex',
      mode: 'review',
      config,
      wait: true,
      pollIntervalMs: 100,
      random: () => 0.5,
      sleep: async ms => {
        slept.push(ms);
        if (slept.length === 3) release(); // free the slot after a few polls
        await yieldTurn();
      },
    });
    const release2 = await waiter;
    release2();
    assert.ok(slept.length >= 3, `polled ${slept.length} times`);
    // interval + floor(interval * fraction * 0.5) — the jitter is applied, not just drawn
    const expected = 100 + Math.floor(100 * POLL_JITTER_FRACTION * 0.5);
    assert.ok(expected > 100);
    for (const ms of slept) assert.equal(ms, expected);
  });
});
