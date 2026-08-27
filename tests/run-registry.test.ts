import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

function withAgentDir<T>(fn: (dir: string) => T): T {
  const dir = join(tmpdir(), `run-registry-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    return fn(dir);
  } finally {
    process.env.PI_CODING_AGENT_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
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
