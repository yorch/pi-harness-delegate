import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join, sep } from 'node:path';
import { test } from 'node:test';
import { agentDir } from '../extensions/config.ts';
import { withEnv } from './helpers/env.ts';
// Never import ./helpers/preload.ts here: that would run the pin as a side effect of this import and
// hide a run where bun didn't apply the preload at all. Only the side-effect-free state module.
import {
  CLEANUP_SIGNALS,
  type CleanupProcess,
  coercedEnvVars,
  PRELOAD_AGENT_DIR_PREFIX,
  preloadState,
  registerPinnedDirCleanup,
} from './helpers/preload-state.ts';
import { waitFor } from './helpers/wait.ts';

// The preload (tests/helpers/preload.ts, wired in bunfig.toml) pins PI_CODING_AGENT_DIR to a temp dir for
// the whole `bun test` process — live mode included (tests/live.test.ts hands only its spawned harness CLIs the outer value).

/** The preload's state, failing loudly (not skipping) when bun never ran it. */
function requirePreload() {
  const state = preloadState();
  assert.ok(
    state,
    'tests/helpers/preload.ts did not run in this `bun test` process. bun reads bunfig.toml (which wires ' +
      'the preload) only from its current directory — run `bun test` from the repo root or tests/ (or `bun run test`, ' +
      'which runs from the package root wherever you are), not from another directory. Without the preload, PI_CODING_AGENT_DIR is not pinned and ' +
      'a straggling run can write into your real ~/.pi/agent.',
  );
  return state;
}

test('preload: bunfig.toml (repo root and tests/) wires the preload into bun test', () => {
  const root = readFileSync(join(import.meta.dirname, '..', 'bunfig.toml'), 'utf8');
  assert.match(root, /preload\s*=\s*\[[^\]]*"\.\/tests\/helpers\/preload\.ts"/);
  const tests = readFileSync(join(import.meta.dirname, 'bunfig.toml'), 'utf8');
  assert.match(tests, /preload\s*=\s*\[[^\]]*"\.\/helpers\/preload\.ts"/);
});

test('preload: actually ran in this process (bun test must be started from the repo root or tests/)', () => {
  requirePreload();
});

test('preload: with no per-test override, agentDir() is a temp dir, never the real ~/.pi/agent', () => {
  const { pinnedAgentDir } = requirePreload();
  const dir = agentDir();
  assert.equal(dir, pinnedAgentDir);
  assert.equal(dir, process.env.PI_CODING_AGENT_DIR);
  assert.ok(existsSync(dir), `pinned agent dir should exist: ${dir}`);
  assert.ok(basename(dir).startsWith(PRELOAD_AGENT_DIR_PREFIX), dir);
  assert.ok(realpathSync(dir).startsWith(realpathSync(tmpdir()) + sep), `${dir} is not under os.tmpdir()`);
  assert.notEqual(dir, join(homedir(), '.pi', 'agent'));
});

test('preload: withEnv restores PI_CODING_AGENT_DIR to the pinned value, not to unset', async () => {
  const { pinnedAgentDir: pinned } = requirePreload();

  await withEnv({ PI_CODING_AGENT_DIR: '/tmp/some-test-override' }, () => {
    assert.equal(agentDir(), '/tmp/some-test-override');
  });
  assert.equal(process.env.PI_CODING_AGENT_DIR, pinned);

  // Even a test that explicitly unsets it gets the pinned value back afterwards.
  await withEnv({ PI_CODING_AGENT_DIR: undefined }, () => {
    assert.equal('PI_CODING_AGENT_DIR' in process.env, false);
  });
  assert.equal(process.env.PI_CODING_AGENT_DIR, pinned);

  await assert.rejects(
    withEnv({ PI_CODING_AGENT_DIR: '/tmp/another-override' }, () => {
      throw new Error('boom');
    }),
    /boom/,
  );
  assert.equal(process.env.PI_CODING_AGENT_DIR, pinned);
});

const REPO_ROOT = join(import.meta.dirname, '..');

interface ChildRun {
  child: ChildProcess;
  /** stdout + stderr so far. */
  output: () => string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  cleanup: () => void;
}

/**
 * Start a child `bun test` from the repo root by default (so bunfig.toml — and so the preload — applies) on a
 * throwaway test file holding `body`, outside tests/ so the main suite never picks it up. `env` is
 * the child's whole environment.
 */
function startChildBunTest(body: string, env: NodeJS.ProcessEnv, cwd = REPO_ROOT): ChildRun {
  const dir = mkdtempSync(join(tmpdir(), 'preload-child-'));
  const file = join(dir, 'child.test.ts');
  writeFileSync(file, `import { test } from 'node:test';\n${body}\n`);
  const child = spawn(process.execPath, ['test', file], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout?.on('data', d => (out += d));
  child.stderr?.on('data', d => (out += d));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve =>
    child.on('close', (code, signal) => resolve({ code, signal })),
  );
  return { child, output: () => out, exited, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** The current env minus `drop`, plus `add` — never mutates process.env. */
function childEnv(add: Record<string, string>, drop: string[] = []): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...add };
  for (const name of drop) delete env[name];
  return env;
}

/** Child test body: prints the child's PI_CODING_AGENT_DIR on a `PINNED=` line. */
const PRINT_AGENT_DIR = "test('child', () => { console.log('PINNED=' + process.env.PI_CODING_AGENT_DIR); });";

test('preload: live mode (PI_DELEGATE_LIVE=1) still pins the agent dir for every file', {
  timeout: 60_000,
}, async () => {
  const outer = mkdtempSync(join(tmpdir(), 'preload-outer-agent-'));
  const run = startChildBunTest(PRINT_AGENT_DIR, childEnv({ PI_DELEGATE_LIVE: '1', PI_CODING_AGENT_DIR: outer }));
  try {
    const { code } = await run.exited;
    assert.equal(code, 0, run.output());
    const pinned = /PINNED=(.*)/.exec(run.output())?.[1]?.trim();
    assert.ok(pinned, run.output());
    assert.notEqual(pinned, outer, 'an unfiltered live run must not leave other files on the outer agent dir');
    assert.ok(basename(pinned).startsWith(PRELOAD_AGENT_DIR_PREFIX), pinned);
    assert.equal(existsSync(pinned), false, 'the pinned dir is removed when the child exits');
  } finally {
    run.cleanup();
    rmSync(outer, { recursive: true, force: true });
  }
});

test('preload: a bun test started from tests/ is pinned too (tests/bunfig.toml)', { timeout: 60_000 }, async () => {
  const run = startChildBunTest(PRINT_AGENT_DIR, childEnv({}, ['PI_DELEGATE_LIVE']), import.meta.dirname);
  try {
    const { code } = await run.exited;
    assert.equal(code, 0, run.output());
    const pinned = /PINNED=(.*)/.exec(run.output())?.[1]?.trim();
    assert.ok(pinned && basename(pinned).startsWith(PRELOAD_AGENT_DIR_PREFIX), run.output());
  } finally {
    run.cleanup();
  }
});

/** Child test body: prints its pinned dir, then hangs until signalled. */
const HANG_AFTER_PRINT =
  "test('child', { timeout: 120_000 }, async () => { console.log('PINNED=' + process.env.PI_CODING_AGENT_DIR); " +
  'await new Promise(r => setTimeout(r, 120_000)); });';

for (const [sig, status] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
] as const) {
  test(`preload: ${sig} mid-run removes the pinned dir and still kills bun test by ${sig}`, {
    timeout: 60_000,
  }, async () => {
    const run = startChildBunTest(HANG_AFTER_PRINT, childEnv({}, ['PI_DELEGATE_LIVE']));
    try {
      const pinned = await waitFor(() => /PINNED=(.*)\n/.exec(run.output())?.[1]?.trim(), {
        timeoutMs: 30_000,
        label: 'the child to print its pinned dir',
      });
      assert.ok(basename(pinned).startsWith(PRELOAD_AGENT_DIR_PREFIX), pinned);
      assert.ok(existsSync(pinned), 'pinned dir exists while the child runs');
      run.child.kill(sig);
      const { code, signal } = await run.exited;
      // Re-raised, not swallowed: the child dies *by the signal* (128+n in a shell), never exits 0/1.
      assert.equal(signal, sig, `expected death by ${sig}, got code=${code} signal=${signal} (status ${status})`);
      assert.equal(existsSync(pinned), false, `pinned dir must be removed on ${sig}: ${pinned}`);
    } finally {
      run.child.kill('SIGKILL');
      run.cleanup();
    }
  });
}

/**
 * Child body: two tests time out (200ms) while their run is still in flight (a fake harness child that
 * sleeps 2s), with PI_CODING_AGENT_DIR swapped to the outer value by `swap` — the live suite's shape —
 * then later tests (one waiting until both runs have finished) print what this process sees.
 */
function overlappingRunsBody(swap: 'withEnvSync' | 'withEnv'): string {
  const helpers = join(import.meta.dirname, 'helpers', 'env.ts');
  const runner = join(REPO_ROOT, 'extensions', 'runner.ts');
  const claude = join(REPO_ROOT, 'extensions', 'harnesses', 'claude.ts');
  const script = 'setTimeout(() => console.log(JSON.stringify({ type: "result", result: "ok" })), 2000);';
  return [
    `import { withEnv, withEnvSync } from ${JSON.stringify(helpers)};`,
    `import { runHarness } from ${JSON.stringify(runner)};`,
    `import { claudeHarness } from ${JSON.stringify(claude)};`,
    `const harness = { ...claudeHarness, binary: process.execPath, buildArgs: () => ['-e', ${JSON.stringify(script)}] };`,
    'const start = () => runHarness({ harness, prompt: "hi", cwd: process.cwd(), permission: "readonly", timeoutMs: 30_000 });',
    `const live = () => ${swap === 'withEnvSync' ? 'withEnvSync({ PI_CODING_AGENT_DIR: undefined }, start)' : 'withEnv({ PI_CODING_AGENT_DIR: undefined }, start)'};`,
    "const show = (t) => console.log(t + '=' + ('PI_CODING_AGENT_DIR' in process.env ? 'PINNED' : 'UNSET'));",
    "test('run a', { timeout: 200 }, async () => { await live(); });",
    "test('run b', { timeout: 200 }, async () => { await live(); });",
    "test('right after', () => show('AFTER0'));",
    "test('after both runs', { timeout: 20_000 }, async () => { await new Promise(r => setTimeout(r, 4000)); show('AFTER1'); });",
    "test('later', () => show('AFTER2'));",
  ].join('\n');
}

test('live swap: timed-out, overlapping runs can never leave the process unpinned (withEnvSync)', {
  timeout: 60_000,
}, async () => {
  const run = startChildBunTest(overlappingRunsBody('withEnvSync'), childEnv({}, ['PI_DELEGATE_LIVE']));
  try {
    await run.exited;
    const out = run.output();
    assert.match(out, /\(fail\) run a/, 'the runs really did outlive their tests');
    for (const t of ['AFTER0', 'AFTER1', 'AFTER2']) assert.match(out, new RegExp(`${t}=PINNED`), out);
  } finally {
    run.cleanup();
  }
});

test('live swap: the same shape with an async withEnv does leave the process unpinned (why live uses withEnvSync)', {
  timeout: 60_000,
}, async () => {
  const run = startChildBunTest(overlappingRunsBody('withEnv'), childEnv({}, ['PI_DELEGATE_LIVE']));
  try {
    await run.exited;
    const out = run.output();
    assert.match(out, /\(fail\) run a/, out);
    assert.match(out, /AFTER1=UNSET/, `expected the out-of-order restore to unpin the process:\n${out}`);
    assert.match(out, /AFTER2=UNSET/, out);
  } finally {
    run.cleanup();
  }
});

/** Child test body: installs its own SIGINT listener, prints its pinned dir, waits for a SIGINT, then
 *  reports whether the pinned dir still exists — the run must carry on with a usable agent dir. */
const OWN_SIGINT_LISTENER =
  "test('child', { timeout: 120_000 }, async () => { const { existsSync } = await import('node:fs'); " +
  "let got = false; process.on('SIGINT', () => { got = true; }); " +
  "console.log('PINNED=' + process.env.PI_CODING_AGENT_DIR); " +
  'while (!got) await new Promise(r => setTimeout(r, 20)); ' +
  "console.log('AFTER_SIGINT_EXISTS=' + existsSync(process.env.PI_CODING_AGENT_DIR)); });";

test('preload: with a second SIGINT listener, SIGINT leaves the pinned dir for the ongoing run; exit removes it', {
  timeout: 60_000,
}, async () => {
  const run = startChildBunTest(OWN_SIGINT_LISTENER, childEnv({}, ['PI_DELEGATE_LIVE']));
  try {
    const pinned = await waitFor(() => /PINNED=(.*)\n/.exec(run.output())?.[1]?.trim(), {
      timeoutMs: 30_000,
      label: 'the child to print its pinned dir',
    });
    run.child.kill('SIGINT');
    const { code, signal } = await run.exited;
    assert.equal(signal, null, run.output());
    assert.equal(code, 0, run.output());
    assert.match(run.output(), /AFTER_SIGINT_EXISTS=true/, 'the dir must survive a SIGINT the run handles itself');
    assert.equal(existsSync(pinned), false, 'removed by the exit handler once the run ends');
  } finally {
    run.child.kill('SIGKILL');
    run.cleanup();
  }
});

test('env backstop: an outer "null" var is ignored only while unchanged — coercing it to "undefined" fails', {
  timeout: 60_000,
}, async () => {
  const body = [
    "test('leaves it alone', () => { console.log('FIRST_SEES=' + JSON.stringify(process.env.ZZ_BACKSTOP_OUTER)); });",
    "test('coerces', () => { Reflect.set(process.env, 'ZZ_BACKSTOP_OUTER', undefined); });",
    "test('next', () => { console.log('NEXT_SEES=' + JSON.stringify(process.env.ZZ_BACKSTOP_OUTER)); });",
  ].join('\n');
  const run = startChildBunTest(body, childEnv({ ZZ_BACKSTOP_OUTER: 'null' }, ['PI_DELEGATE_LIVE']));
  try {
    const { code } = await run.exited;
    const out = run.output();
    assert.notEqual(code, 0, out);
    assert.match(out, /FIRST_SEES="null"/, 'an unchanged outer value is not flagged');
    assert.match(out, /this test left ZZ_BACKSTOP_OUTER="undefined"/);
    assert.match(out, /\(fail\) coerces/);
    assert.match(out, /^\s*2 pass$/m, out);
    assert.match(out, /^\s*1 fail$/m, out);
    assert.match(out, /NEXT_SEES="null"/, 'put back to the outer value, not deleted');
  } finally {
    run.cleanup();
  }
});

/** A fake `process` recording listeners and re-raised signals. */
function fakeProcess() {
  const listeners = new Map<string, Array<(signal: NodeJS.Signals) => void>>();
  const killed: Array<[number, string]> = [];
  const proc: CleanupProcess = {
    pid: 4242,
    on: (event, l) => listeners.set(event, [...(listeners.get(event) ?? []), l]),
    off: (event, l) =>
      listeners.set(
        event,
        (listeners.get(event) ?? []).filter(x => x !== l),
      ),
    kill: (pid, signal) => killed.push([pid, signal]),
    listenerCount: event => (listeners.get(event) ?? []).length,
  };
  const emit = (event: string, ...args: unknown[]) => {
    for (const l of [...(listeners.get(event) ?? [])]) (l as (...a: unknown[]) => void)(...args);
  };
  return { proc, listeners, killed, emit };
}

test('preload cleanup: a signal removes the captured dir once, detaches every handler, and re-raises', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'preload-cleanup-unit-'));
  const other = mkdtempSync(join(tmpdir(), 'preload-cleanup-other-'));
  const { proc, listeners, killed, emit } = fakeProcess();
  try {
    registerPinnedDirCleanup(dir, proc);
    for (const ev of ['exit', ...CLEANUP_SIGNALS]) assert.equal(listeners.get(ev)?.length, 1, ev);
    // the removed path is the captured one, whatever the env says by then
    await withEnv({ PI_CODING_AGENT_DIR: other }, () => {
      emit('SIGTERM', 'SIGTERM');
      assert.equal(existsSync(dir), false, 'captured dir removed');
      assert.equal(existsSync(other), true, 'never re-reads PI_CODING_AGENT_DIR');
      assert.deepEqual(killed, [[4242, 'SIGTERM']], 're-raised exactly once, same signal, own pid');
      for (const ev of ['exit', ...CLEANUP_SIGNALS]) assert.equal(listeners.get(ev)?.length, 0, `${ev} detached`);
      emit('exit'); // nothing left to run — and cleanup is idempotent anyway
      assert.deepEqual(killed, [[4242, 'SIGTERM']]);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});

test('preload cleanup: with another listener for the signal, it leaves cleanup to exit (no remove, no re-raise)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'preload-cleanup-shared-'));
  const { proc, listeners, killed, emit } = fakeProcess();
  try {
    registerPinnedDirCleanup(dir, proc);
    const other = () => {};
    proc.on('SIGINT', other); // e.g. another module's own Ctrl-C handling
    emit('SIGINT', 'SIGINT');
    assert.equal(existsSync(dir), true, 'the run carries on, so the pinned dir must still exist');
    assert.deepEqual(killed, [], 'no re-raise — it would only reach the other listener');
    for (const ev of ['exit', ...CLEANUP_SIGNALS])
      assert.ok((listeners.get(ev)?.length ?? 0) >= 1, `${ev} still attached`);
    // once that listener is gone, a signal is ours alone again and does the full cleanup + re-raise
    proc.off('SIGINT', other);
    emit('SIGINT', 'SIGINT');
    assert.equal(existsSync(dir), false);
    assert.deepEqual(killed, [[4242, 'SIGINT']]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('preload cleanup: an exit after a shared signal still removes the dir', () => {
  const dir = mkdtempSync(join(tmpdir(), 'preload-cleanup-shared-exit-'));
  const { proc, killed, emit } = fakeProcess();
  registerPinnedDirCleanup(dir, proc);
  proc.on('SIGTERM', () => {});
  emit('SIGTERM', 'SIGTERM');
  assert.equal(existsSync(dir), true);
  emit('exit', 0);
  assert.equal(existsSync(dir), false);
  assert.deepEqual(killed, []);
});

test("preload cleanup: 'exit' removes the dir without re-raising anything", () => {
  const dir = mkdtempSync(join(tmpdir(), 'preload-cleanup-exit-'));
  const { proc, killed, emit } = fakeProcess();
  registerPinnedDirCleanup(dir, proc);
  emit('exit', 0);
  assert.equal(existsSync(dir), false);
  assert.deepEqual(killed, []);
});

test('env backstop: coercedEnvVars finds exactly the "undefined"/"null" values, minus unchanged outer ones', () => {
  const env = { A: 'undefined', B: 'null', C: 'x', D: '', E: 'Undefined', F: 'null ', G: 'undefined', H: 'undefined' };
  assert.deepEqual(coercedEnvVars(env), ['A', 'B', 'G', 'H']);
  // G held the same value outside (ignored); H was "null" outside and is now "undefined" (still caught)
  assert.deepEqual(coercedEnvVars(env, { G: 'undefined', H: 'null' }), ['A', 'B', 'H']);
});

test('env backstop: a test that coerces undefined into process.env fails, and the next test starts clean', {
  timeout: 60_000,
}, async () => {
  // A child run (outside tests/, so the static hygiene guard never sees this file) doing the exact
  // bug the backstop exists for (Reflect.set: same coercion as `process.env.X = prev`).
  const body = [
    "test('coerces', () => { const prev = undefined; Reflect.set(process.env, 'ZZ_BACKSTOP_PROBE', prev); });",
    "test('next', () => { console.log('NEXT_SEES=' + JSON.stringify(process.env.ZZ_BACKSTOP_PROBE)); });",
  ].join('\n');
  const run = startChildBunTest(body, childEnv({}, ['PI_DELEGATE_LIVE', 'ZZ_BACKSTOP_PROBE']));
  try {
    const { code } = await run.exited;
    const out = run.output();
    assert.notEqual(code, 0, out);
    assert.match(out, /env backstop \(tests\/helpers\/preload\.ts\): this test left ZZ_BACKSTOP_PROBE="undefined"/);
    assert.match(out, /\(fail\) coerces/);
    assert.match(out, /^\s*1 pass$/m, 'only the offending test fails');
    assert.match(out, /^\s*1 fail$/m);
    assert.match(out, /NEXT_SEES=undefined/, 'the backstop removes the coerced var so the failure does not cascade');
  } finally {
    run.cleanup();
  }
});
