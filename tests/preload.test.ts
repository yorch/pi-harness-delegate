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
import { PRELOAD_AGENT_DIR_PREFIX, preloadState } from './helpers/preload-state.ts';

// The preload (tests/helpers/preload.ts, wired in bunfig.toml) pins PI_CODING_AGENT_DIR to a temp dir for
// the whole `bun test` process — live mode included (tests/live.test.ts un-pins only around its own runs).

/** The preload's state, failing loudly (not skipping) when bun never ran it. */
function requirePreload() {
  const state = preloadState();
  assert.ok(
    state,
    'tests/helpers/preload.ts did not run in this `bun test` process. bun reads bunfig.toml (which wires ' +
      'the preload) only from its current directory — run `bun test` from the repo root (or `bun run test`, ' +
      'which runs from the package root wherever you are), not from tests/ or another subdirectory. Without the preload, PI_CODING_AGENT_DIR is not pinned and ' +
      'a straggling run can write into your real ~/.pi/agent.',
  );
  return state;
}

test('preload: bunfig.toml wires the preload into bun test', () => {
  const bunfig = readFileSync(join(import.meta.dirname, '..', 'bunfig.toml'), 'utf8');
  assert.match(bunfig, /preload\s*=\s*\[[^\]]*"\.\/tests\/helpers\/preload\.ts"/);
});

test('preload: actually ran in this process (bun test must be started from the repo root)', () => {
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
 * Start a child `bun test` from the repo root (so bunfig.toml — and so the preload — applies) on a
 * throwaway test file holding `body`, outside tests/ so the main suite never picks it up. `env` is
 * the child's whole environment.
 */
function startChildBunTest(body: string, env: NodeJS.ProcessEnv): ChildRun {
  const dir = mkdtempSync(join(tmpdir(), 'preload-child-'));
  const file = join(dir, 'child.test.ts');
  writeFileSync(file, `import { test } from 'node:test';\n${body}\n`);
  const child = spawn(process.execPath, ['test', file], { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
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
