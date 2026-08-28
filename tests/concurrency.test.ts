import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DelegateConfig } from '../extensions/config.ts';

function withAgentDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = join(tmpdir(), `concurrency-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  return fn(dir).finally(() => {
    process.env.PI_CODING_AGENT_DIR = prev;
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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
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
    const waiter = acquireSlot({ harness: 'codex', mode: 'review', config, wait: true, pollIntervalMs: 20 }).then(r => {
      acquired = true;
      return r;
    });

    await sleep(60);
    assert.equal(acquired, false, 'waiter must not acquire while the slot is held');
    release();
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
        pollIntervalMs: 5,
      });
      current++;
      peak = Math.max(peak, current);
      await sleep(5 + (i % 4) * 3);
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
    const waiter = acquireSlot({ harness: 'opencode', mode: 'review', config, wait: true, pollIntervalMs: 10 }).then(
      r => {
        acquired = true;
        return r;
      },
    );
    await sleep(30);
    assert.equal(acquired, false);
    releaseRun(external1);
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
    const waiters = ['codex', 'opencode', 'amp'].map(h =>
      acquireSlot({ harness: h, mode: 'review', config, wait: true, signal: ac.signal, pollIntervalMs: 10 }),
    );

    await sleep(30);
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
