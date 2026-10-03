import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

/**
 * Exercises `delegate()` (the shared engine in index.ts) directly with a fake `pi`/`ctx`, so the
 * paths that run *before* any harness is spawned — permission checks, scope resolution, slot
 * accounting — are tested without a real binary.
 */

interface Sandbox {
  agentDir: string;
  cwd: string;
}

async function withSandbox<T>(
  opts: { maxConcurrent?: number; templates?: Record<string, string> },
  fn: (s: Sandbox) => Promise<T>,
): Promise<T> {
  const root = join(tmpdir(), `delegate-engine-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const agentDir = join(root, 'agent');
  const cwd = join(root, 'project');
  mkdirSync(agentDir, { recursive: true });
  const tplDir = join(cwd, '.pi', 'delegate', 'templates', 'claude');
  mkdirSync(tplDir, { recursive: true });
  writeFileSync(
    join(agentDir, 'settings.json'),
    JSON.stringify({ delegate: { maxConcurrent: opts.maxConcurrent ?? 1, maxTranscripts: 5 } }),
  );
  for (const [name, body] of Object.entries(opts.templates ?? {})) writeFileSync(join(tplDir, `${name}.md`), body);
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    return await fn({ agentDir, cwd });
  } finally {
    process.env.PI_CODING_AGENT_DIR = prev;
    rmSync(root, { recursive: true, force: true });
  }
}

const DANGER_TEMPLATE = '---\nname: yolo\ndescription: test\npermission: danger\n---\nDo it.\n';
const EDIT_TEMPLATE = '---\nname: tinker\ndescription: test\npermission: edit\n---\nDo it.\n';

function fakeCtx(cwd: string): never {
  return { cwd, hasUI: false, isProjectTrusted: () => true } as never;
}

function fakePi(exec: (cmd: string, args: string[]) => Promise<unknown>): never {
  return { exec } as never;
}

test('delegate: a refused danger template never holds a slot, however many times it is retried', async () => {
  await withSandbox({ maxConcurrent: 1, templates: { yolo: DANGER_TEMPLATE } }, async ({ cwd }) => {
    const { delegate } = await import('../extensions/index.ts');
    const { activeCount } = await import('../extensions/concurrency.ts');
    const pi = fakePi(async () => {
      throw new Error('exec must not be reached');
    });
    // well over maxConcurrent (1): a leak would turn attempt #2 into a ConcurrencyLimitError
    for (let i = 0; i < 4; i++) {
      await assert.rejects(
        () => delegate(pi, fakeCtx(cwd), { harness: 'claude', mode: 'yolo', task: 'x' }),
        /requires danger permission/,
      );
    }
    assert.equal(activeCount(), 0);
  });
});

test('delegate: a throw during scope resolution releases the slot', async () => {
  await withSandbox({ maxConcurrent: 1, templates: { tinker: EDIT_TEMPLATE } }, async ({ cwd }) => {
    const { delegate } = await import('../extensions/index.ts');
    const { activeCount } = await import('../extensions/concurrency.ts');
    let calls = 0;
    const pi = fakePi(async () => {
      calls++;
      throw new Error('git exploded');
    });
    for (let i = 0; i < 3; i++) {
      await assert.rejects(
        () => delegate(pi, fakeCtx(cwd), { harness: 'claude', mode: 'tinker', task: 'x', scope: 'diff' }),
        /git exploded/,
      );
    }
    assert.equal(calls, 3, 'every attempt must get past acquireSlot — none blocked by a leaked slot');
    assert.equal(activeCount(), 0);
  });
});

test('delegate: a cancel that lands right after the slot is won spawns nothing and frees the slot', async () => {
  await withSandbox({ maxConcurrent: 1, templates: { tinker: EDIT_TEMPLATE } }, async ({ cwd }) => {
    const { delegate } = await import('../extensions/index.ts');
    const { activeCount } = await import('../extensions/concurrency.ts');
    // acquireSlot reads `aborted` once (false — the slot is granted), then delegate() re-checks it
    // (true) — the window between the grant and the spawn.
    let reads = 0;
    const signal = {
      get aborted() {
        return reads++ > 0;
      },
      addEventListener() {},
      removeEventListener() {},
    } as unknown as AbortSignal;
    let execCalls = 0;
    const pi = fakePi(async () => {
      execCalls++;
      return { stdout: '', stderr: '', code: 0 };
    });
    let acquired = false;
    await assert.rejects(
      () =>
        delegate(pi, fakeCtx(cwd), {
          harness: 'claude',
          mode: 'tinker',
          task: 'x',
          scope: 'diff',
          signal,
          onAcquired: () => {
            acquired = true;
          },
        }),
      /cancelled/,
    );
    assert.equal(execCalls, 0);
    assert.equal(acquired, false);
    assert.equal(activeCount(), 0);
  });
});
