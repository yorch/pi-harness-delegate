import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// `fn` is always an async callback, so this must itself stay async and `await` it (not just
// `return fn(dir)` from a sync try/finally): every one of these tests' first statement is an
// `await import(...)`, which suspends immediately and returns control to this function before the
// test body runs — a bare `try { return fn(dir) } finally {...}` would run `finally` right then,
// resetting the env var and deleting `dir` before the test body executes a single line, silently
// pointing every test at the real ~/.pi/agent instead of an isolated tmp dir.
function withAgentDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = join(tmpdir(), `run-registry-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  return fn(dir).finally(() => {
    process.env.PI_CODING_AGENT_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  });
}

test('run-registry: acquire then release removes the entry', async () => {
  await withAgentDir(async () => {
    const { acquireRun, releaseRun, countActiveRuns } = await import('../extensions/run-registry.ts');
    assert.equal(countActiveRuns(), 0);
    const handle = acquireRun('claude', 'review');
    assert.ok(handle);
    assert.equal(countActiveRuns(), 1);
    assert.equal(countActiveRuns('claude'), 1);
    assert.equal(countActiveRuns('codex'), 0);
    releaseRun(handle);
    assert.equal(countActiveRuns(), 0);
  });
});

test('run-registry: counts multiple active runs, filtered per harness', async () => {
  await withAgentDir(async () => {
    const { acquireRun, releaseRun, countActiveRuns } = await import('../extensions/run-registry.ts');
    const a = acquireRun('claude', 'review');
    const b = acquireRun('claude', 'plan');
    const c = acquireRun('codex', 'general');
    assert.equal(countActiveRuns(), 3);
    assert.equal(countActiveRuns('claude'), 2);
    assert.equal(countActiveRuns('codex'), 1);
    releaseRun(a);
    releaseRun(b);
    releaseRun(c);
    assert.equal(countActiveRuns(), 0);
  });
});

test('run-registry: cleans up stale entries from dead pids', async () => {
  await withAgentDir(async dir => {
    const { countActiveRuns } = await import('../extensions/run-registry.ts');
    const runsDir = join(dir, 'delegate', 'runs');
    mkdirSync(runsDir, { recursive: true });
    // pid 999999999 is very unlikely to be alive
    writeFileSync(
      join(runsDir, 'stale.json'),
      JSON.stringify({ pid: 999_999_999, harness: 'claude', mode: 'review', startedAt: Date.now() }),
    );
    assert.equal(countActiveRuns(), 0);
    // the stale entry should have been removed as a side effect
    assert.equal(countActiveRuns(), 0);
  });
});

test('run-registry: cleans up entries with a non-numeric pid instead of counting them forever', async () => {
  await withAgentDir(async dir => {
    const { countActiveRuns } = await import('../extensions/run-registry.ts');
    const runsDir = join(dir, 'delegate', 'runs');
    mkdirSync(runsDir, { recursive: true });
    // a corrupt-but-valid-JSON entry: pid parses as a string, not a number
    writeFileSync(
      join(runsDir, 'corrupt-pid.json'),
      JSON.stringify({ pid: 'not-a-number', harness: 'claude', mode: 'review', startedAt: Date.now() }),
    );
    assert.equal(countActiveRuns(), 0);
    // removed as a side effect, not silently counted as active forever
    assert.equal(countActiveRuns(), 0);
  });
});

test('run-registry: never throws when the registry dir is missing', async () => {
  await withAgentDir(async () => {
    const { countActiveRuns, releaseRun } = await import('../extensions/run-registry.ts');
    assert.equal(countActiveRuns(), 0);
    assert.doesNotThrow(() => releaseRun({ file: '/nonexistent/path/x.json' }));
  });
});

test('acquireRunWithinLimits: acquires when under both limits', async () => {
  await withAgentDir(async () => {
    const { acquireRunWithinLimits, countActiveRuns } = await import('../extensions/run-registry.ts');
    const claim = acquireRunWithinLimits('claude', 'review', 2, 2);
    assert.equal(claim.status, 'acquired');
    assert.equal(countActiveRuns(), 1);
  });
});

test('acquireRunWithinLimits: 0 means no limit for that dimension', async () => {
  await withAgentDir(async () => {
    const { acquireRunWithinLimits } = await import('../extensions/run-registry.ts');
    const claim = acquireRunWithinLimits('claude', 'review', 0, 0);
    assert.equal(claim.status, 'acquired');
  });
});

test('acquireRunWithinLimits: closes the count-then-act race — a write that would push the global count over the limit is undone, not left standing', async () => {
  await withAgentDir(async () => {
    const { acquireRun, acquireRunWithinLimits, countActiveRuns } = await import('../extensions/run-registry.ts');
    // simulate a racer whose write already landed between our (racy) pre-check and our own write —
    // the exact window the old countActiveRuns()-then-acquireRun() pattern couldn't see.
    const racer = acquireRun('codex', 'plan');
    assert.ok(racer);
    assert.equal(countActiveRuns(), 1);

    const claim = acquireRunWithinLimits('claude', 'review', 1, 0);
    assert.equal(claim.status, 'full');
    // the losing write must not be left behind — count stays at exactly the racer's one entry,
    // never 2 (over the limit of 1) and never 0 (the racer wrongly evicted).
    assert.equal(countActiveRuns(), 1);
  });
});

test('acquireRunWithinLimits: closes the race for the per-harness limit specifically, leaving the global limit alone', async () => {
  await withAgentDir(async () => {
    const { acquireRun, acquireRunWithinLimits, countActiveRuns } = await import('../extensions/run-registry.ts');
    const racer = acquireRun('claude', 'plan'); // same harness, already holding the one claude slot
    assert.ok(racer);

    const claim = acquireRunWithinLimits('claude', 'review', 10, 1);
    assert.equal(claim.status, 'full');
    assert.equal(countActiveRuns('claude'), 1);
    assert.equal(countActiveRuns(), 1);

    // a different harness still fits under the same per-harness limit (it's scoped per-harness)
    const other = acquireRunWithinLimits('codex', 'review', 10, 1);
    assert.equal(other.status, 'acquired');
    assert.equal(countActiveRuns(), 2);
  });
});

test('acquireRunWithinLimits: never over-admits across many repeated claims against a tight cap', async () => {
  await withAgentDir(async () => {
    const { acquireRunWithinLimits, countActiveRuns, releaseRun } = await import('../extensions/run-registry.ts');
    const claims = Array.from({ length: 8 }, () => acquireRunWithinLimits('claude', 'review', 3, 0));
    const acquired = claims.filter(c => c.status === 'acquired');
    assert.ok(acquired.length <= 3, `acquired ${acquired.length} claims but the global cap was 3`);
    assert.equal(countActiveRuns(), acquired.length);
    for (const c of acquired) if (c.status === 'acquired') releaseRun(c.handle);
    assert.equal(countActiveRuns(), 0);
  });
});
