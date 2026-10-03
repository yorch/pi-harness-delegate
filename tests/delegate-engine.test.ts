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

interface CapturedTool {
  name: string;
  execute: (id: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: unknown) => Promise<unknown>;
}

async function loadExtension(exec: (cmd: string, args: string[]) => Promise<unknown> = async () => ({})) {
  const mod = await import('../extensions/index.ts');
  const tools = new Map<string, CapturedTool>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const pi = {
    exec,
    registerTool: (t: CapturedTool) => tools.set(t.name, t),
    registerCommand: (name: string, c: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
      commands.set(name, c),
    on: () => {},
  };
  mod.default(pi as never);
  return { tools, commands };
}

test('delegate tool: allowDangerous with no UI is refused before anything runs', async () => {
  await withSandbox({ templates: { tinker: EDIT_TEMPLATE } }, async ({ cwd }) => {
    const { tools } = await loadExtension(async () => {
      throw new Error('must not run');
    });
    for (const name of ['delegate', 'claude_delegate']) {
      await assert.rejects(
        () =>
          tools
            .get(name)
            ?.execute(
              't',
              { harness: 'claude', mode: 'tinker', task: 'x', allowDangerous: true },
              undefined,
              undefined,
              {
                cwd,
                hasUI: false,
                isProjectTrusted: () => true,
              },
            ) ?? Promise.resolve(),
        /no interactive UI/,
      );
    }
  });
});

test('delegate tool: allowDangerous asks the human; a decline stops it, an approval proceeds', async () => {
  await withSandbox({ templates: { tinker: EDIT_TEMPLATE } }, async ({ cwd }) => {
    const { tools } = await loadExtension();
    const tool = tools.get('delegate');
    assert.ok(tool);
    let answer = false;
    let asked = 0;
    const ctx = {
      cwd,
      hasUI: true,
      isProjectTrusted: () => true,
      ui: {
        confirm: async () => {
          asked++;
          return answer;
        },
        notify: () => {},
      },
    };
    await assert.rejects(
      () =>
        tool.execute(
          't',
          { harness: 'claude', mode: 'tinker', task: 'x', allowDangerous: true },
          undefined,
          undefined,
          ctx,
        ),
      /declined/,
    );
    answer = true;
    // past the gate — fails on the unknown mode instead, without spawning anything
    await assert.rejects(
      () =>
        tool.execute(
          't',
          { harness: 'claude', mode: 'nope', task: 'x', allowDangerous: true },
          undefined,
          undefined,
          ctx,
        ),
      /unknown delegate mode "nope"/,
    );
    assert.equal(asked, 2);
  });
});

test('delegate tool: flag-shaped sessionId/model/pr are rejected before a slot or process is used', async () => {
  await withSandbox({ templates: { tinker: EDIT_TEMPLATE } }, async ({ cwd }) => {
    const { tools } = await loadExtension(async () => {
      throw new Error('must not run');
    });
    const tool = tools.get('delegate');
    assert.ok(tool);
    const ctx = { cwd, hasUI: false, isProjectTrusted: () => true };
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ sessionId: '--dangerously-skip' }, /invalid sessionId/],
      [{ model: '--yolo' }, /invalid model/],
      [{ pr: '--repo=evil/x' }, /invalid pr/],
      [{ harness: 'claude,codex', pr: '-1' }, /invalid pr/], // fan-out validates up front too
    ];
    for (const [extra, re] of cases) {
      await assert.rejects(
        () => tool.execute('t', { harness: 'claude', mode: 'tinker', task: 'x', ...extra }, undefined, undefined, ctx),
        re,
      );
    }
    const { activeCount } = await import('../extensions/concurrency.ts');
    assert.equal(activeCount(), 0);
  });
});

async function captureStderr(fn: () => Promise<void>): Promise<string> {
  const orig = process.stderr.write.bind(process.stderr);
  let out = '';
  process.stderr.write = ((chunk: string | Uint8Array) => {
    out += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    process.stderr.write = orig;
  }
  return out;
}

test('/delegate command: flag-shaped --resume/--pr are rejected on both single and fan-out paths', async () => {
  await withSandbox({ templates: { tinker: EDIT_TEMPLATE } }, async ({ cwd }) => {
    const { commands } = await loadExtension(async () => {
      throw new Error('must not run');
    });
    const handler = commands.get('delegate')?.handler;
    assert.ok(handler);
    const ctx = { cwd, hasUI: false, isProjectTrusted: () => true };
    const single = await captureStderr(() => handler('claude tinker --resume=--evil do it', ctx));
    assert.match(single, /invalid sessionId/);
    const fanout = await captureStderr(() => handler('claude,codex tinker --pr=--repo=x do it', ctx));
    assert.match(fanout, /invalid pr/);
  });
});
