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

test('fan-out + sessionId is rejected up front on both the tool and the command path', async () => {
  await withSandbox({ templates: { tinker: EDIT_TEMPLATE } }, async ({ cwd }) => {
    const { tools, commands } = await loadExtension(async () => {
      throw new Error('must not run');
    });
    const ctx = { cwd, hasUI: false, isProjectTrusted: () => true };
    await assert.rejects(
      () =>
        tools
          .get('delegate')
          ?.execute('t', { harness: 'all', task: 'x', sessionId: 'abc' }, undefined, undefined, ctx) ??
        Promise.resolve(),
      /across a fan-out/,
    );
    const handler = commands.get('delegate')?.handler;
    assert.ok(handler);
    const err = await captureStderr(() => handler('claude,codex tinker --resume=abc continue', ctx));
    assert.match(err, /across a fan-out/);
  });
});

/**
 * Put a fake `<name>` executable first on PATH for the duration of `fn`. The script records its
 * argv (one per line) to `$FAKE_ARGS_FILE` and prints `stdoutLines`, so a real `delegate()` run can
 * be driven end to end without the real CLI.
 */
async function withFakeBinaries<T>(
  names: string[],
  stdoutLines: string[],
  fn: (argsFile: string) => Promise<T>,
  opts: { sleepAfterSec?: number } = {},
): Promise<T> {
  const { chmodSync, mkdtempSync } = await import('node:fs');
  const binDir = mkdtempSync(join(tmpdir(), 'fake-bin-'));
  const argsFile = join(binDir, 'args.txt');
  const body = stdoutLines.map(l => `printf '%s\\n' '${l.replace(/'/g, `'\\''`)}'`).join('\n');
  const script = `#!/bin/sh\nprintf '%s\\n' "$@" > "$FAKE_ARGS_FILE"\n${body}\n${opts.sleepAfterSec ? `exec sleep ${opts.sleepAfterSec}\n` : ''}`;
  for (const name of names) {
    writeFileSync(join(binDir, name), script);
    chmodSync(join(binDir, name), 0o755);
  }
  const prevPath = process.env.PATH;
  const prevArgs = process.env.FAKE_ARGS_FILE;
  process.env.PATH = `${binDir}:${prevPath}`;
  process.env.FAKE_ARGS_FILE = argsFile;
  try {
    return await fn(argsFile);
  } finally {
    process.env.PATH = prevPath;
    if (prevArgs === undefined) delete process.env.FAKE_ARGS_FILE;
    else process.env.FAKE_ARGS_FILE = prevArgs;
    rmSync(binDir, { recursive: true, force: true });
  }
}

const CLAUDE_RESULT = JSON.stringify({
  type: 'result',
  result: 'all good',
  total_cost_usd: 0.01,
  num_turns: 1,
  session_id: 'sess-1',
});

test('delegate: addDirs from the template and the call reach the harness argv, resolved and deduped', async () => {
  const tpl = '---\nname: tinker\ndescription: t\npermission: edit\naddDirs: ../shared, /opt/lib\n---\nDo it.\n';
  await withSandbox({ templates: { tinker: tpl } }, async ({ cwd }) => {
    const { delegate } = await import('../extensions/index.ts');
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    await withFakeBinaries(['claude'], [CLAUDE_RESULT], async argsFile => {
      const run = await delegate(
        fakePi(async () => ({ stdout: '', stderr: '', code: 0 })),
        fakeCtx(cwd),
        {
          harness: 'claude',
          mode: 'tinker',
          task: 'x',
          addDirs: ['/opt/lib', 'extra'],
        },
      );
      assert.equal(run.content, 'all good');
      const argv = readFileSync(argsFile, 'utf8').trim().split('\n');
      const dirs = argv.flatMap((a, i) => (a === '--add-dir' ? [argv[i + 1]] : []));
      assert.deepEqual(dirs, [resolve(cwd, '../shared'), '/opt/lib', resolve(cwd, 'extra')]);
    });
  });
});

test('mergeAddDirs: undefined when nothing is declared, so harness args stay unchanged', async () => {
  const { mergeAddDirs } = await import('../extensions/index.ts');
  assert.equal(mergeAddDirs('/repo'), undefined);
  assert.deepEqual(mergeAddDirs('/repo', ['a'], ['/repo/a', 'b']), ['/repo/a', '/repo/b']);
});

test('delegate: a budget on a harness that reports no cost is flagged as unenforced, in result and transcript', async () => {
  await withSandbox({ templates: {} }, async ({ cwd }) => {
    const { delegate } = await import('../extensions/index.ts');
    const { readFileSync } = await import('node:fs');
    const lines = [
      JSON.stringify({ type: 'thread.started', thread_id: 't-1' }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'codex says hi' } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }),
    ];
    await withFakeBinaries(['codex'], lines, async () => {
      const run = await delegate(
        fakePi(async () => ({})),
        fakeCtx(cwd),
        {
          harness: 'codex',
          mode: 'general',
          task: 'x',
          maxBudgetUsd: 2,
        },
      );
      assert.match(run.content, /^⚠ maxBudgetUsd \$2\.000 was not enforced — codex/);
      assert.equal((run.details.budget as { enforcement: string }).enforcement, 'unenforced');
      const transcript = readFileSync(run.details.file as string, 'utf8');
      assert.ok(transcript.includes('- budget: $2.000 (NOT enforced)'));
    });
  });
});

test('delegate: a host-enforced budget stops the run and records budget exceeded', async () => {
  await withSandbox({ templates: {} }, async ({ cwd }) => {
    const { delegate } = await import('../extensions/index.ts');
    const { readFileSync } = await import('node:fs');
    const step = (cost: number) => JSON.stringify({ type: 'step_finish', sessionID: 's', part: { cost, tokens: {} } });
    const lines = [JSON.stringify({ type: 'text', part: { text: 'working' } }), step(0.4), step(0.4)];
    await withFakeBinaries(
      ['opencode'],
      lines,
      async () => {
        const run = await delegate(
          fakePi(async () => ({})),
          fakeCtx(cwd),
          {
            harness: 'opencode',
            mode: 'general',
            task: 'x',
            maxBudgetUsd: 0.5,
          },
        );
        assert.match(run.content, /budget exceeded: opencode reported \$0\.800 against a \$0\.500 cap — run stopped/);
        assert.equal(run.result.stopReason, 'budget_exceeded');
        assert.equal((run.details.budget as { exceeded: boolean }).exceeded, true);
        const transcript = readFileSync(run.details.file as string, 'utf8');
        assert.ok(transcript.includes('(host-enforced) · budget exceeded'));
      },
      { sleepAfterSec: 20 },
    );
  });
});
