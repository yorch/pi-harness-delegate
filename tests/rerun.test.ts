import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DelegateCommandArgs } from '../extensions/command.ts';
import { outputsDir } from '../extensions/config.ts';
import { planRerun, type RerunEnv, type RerunFlags, selectRecord } from '../extensions/rerun.ts';
import {
  buildRunRecord,
  newFanoutId,
  newRunId,
  type RunRecord,
  recordPathFor,
  writeRunRecord,
} from '../extensions/run-record.ts';
import {
  CLAUDE_RESULT,
  CODEX_RESULT_LINES,
  fakeCtx,
  fakePi,
  loadExtension,
  readArgs,
  tpl,
  withFakeBinaries,
  withOnlyFakes,
  withSandbox,
} from './helpers/sandbox.ts';

const record = (over: Partial<RunRecord> = {}, input: Partial<RunRecord['input']> = {}): RunRecord => ({
  ...buildRunRecord({
    runId: newRunId(),
    harness: 'claude',
    mode: 'review',
    permission: 'readonly',
    nativeClass: 'none',
    model: 'actual-model',
    sessionId: 'sess-1',
    resumed: false,
    startedAtMs: 1_700_000_000_000,
    endedAtMs: 1_700_000_001_000,
    durationMs: 1000,
    isError: false,
    stopReason: null,
    timeoutMs: 60_000,
    numTurns: null,
    totalCostUsd: null,
    usage: null,
    transcriptFile: '/o/a.md',
    cwd: '/proj',
    task: 'check the auth flow',
    scope: 'src/a.ts',
    pr: '12',
    addDirs: ['../shared'],
    requestedModel: 'fast',
    budgetUsd: 2,
    timeoutSec: 120,
    hadVerify: false,
  }),
  ...over,
  ...(Object.keys(input).length ? { input: { ...record0().input, ...input } } : {}),
});
const record0 = (): RunRecord => record();

const flags = (f: Partial<RerunFlags> = {}): RerunFlags => ({ here: false, fanout: false, resumeOwn: false, ...f });
const env = (over: Partial<RerunEnv> = {}): RerunEnv => ({
  cwd: '/proj',
  isKnownHarness: n => ['claude', 'codex', 'amp'].includes(n),
  modeAvailable: () => true,
  siblings: [],
  ...over,
});
const none = (): DelegateCommandArgs => ({ task: '' });

test('planRerun: defaults replay harness/mode/task/scope/pr/addDirs/budget/timeout/model and start a fresh session', () => {
  const plan = planRerun(record(), none(), flags(), env());
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(
    { ...plan.args },
    {
      task: 'check the auth flow',
      harness: 'claude',
      mode: 'review',
      scope: 'src/a.ts',
      pr: '12',
      addDirs: ['../shared'],
      model: 'fast',
      budget: 2,
      timeoutSec: 120,
    },
  );
  assert.ok(plan.notices.some(n => /fresh session/.test(n)));
  assert.equal(plan.args?.sessionId, undefined);
  assert.equal(plan.args?.allowDangerous, undefined);
  assert.equal(plan.args?.verify, undefined);
});

test('planRerun: overrides win; bare --resume uses the recorded session, and needs one', () => {
  const over: DelegateCommandArgs = { task: '', harness: 'codex', model: 'm2', budget: 5, timeoutSec: 30 };
  const plan = planRerun(record(), over, flags({ resumeOwn: true }), env());
  assert.equal(plan.args?.harness, 'codex');
  assert.equal(plan.args?.model, 'm2');
  assert.equal(plan.args?.budget, 5);
  assert.equal(plan.args?.timeoutSec, 30);
  assert.equal(plan.args?.sessionId, 'sess-1');
  assert.match(
    planRerun(record({ sessionId: null }), none(), flags({ resumeOwn: true }), env()).errors[0],
    /no recorded session/,
  );
  assert.equal(planRerun(record(), { task: '', sessionId: 'other' }, flags(), env()).args?.sessionId, 'other');
  assert.match(planRerun(record(), { task: 'new prompt' }, flags(), env()).errors[0], /takes no new prompt/);
});

test('planRerun: danger and verify are never replayed — only noticed', () => {
  const plan = planRerun(record({ permission: 'danger' }, { hadVerify: true }), none(), flags(), env());
  assert.equal(plan.args?.allowDangerous, undefined);
  assert.equal(plan.args?.verify, undefined);
  assert.ok(plan.notices.some(n => /danger permission.*never replayed.*--allow-dangerous/.test(n)));
  assert.ok(plan.notices.some(n => /verify command.*not replayed.*--verify=/.test(n)));
  // the human may pass them again
  const again = planRerun(
    record({ permission: 'danger' }, { hadVerify: true }),
    { task: '', allowDangerous: true, verify: 'bun test' },
    flags(),
    env(),
  );
  assert.equal(again.args?.allowDangerous, true);
  assert.equal(again.args?.verify, 'bun test');
});

test('planRerun: refuses a different cwd unless --here; a missing mode is a clear error', () => {
  const r = record({ cwd: '/elsewhere' });
  assert.match(planRerun(r, none(), flags(), env()).errors[0], /pass --here/);
  const here = planRerun(r, none(), flags({ here: true }), env());
  assert.deepEqual(here.errors, []);
  assert.ok(here.notices.some(n => /current directory/.test(n)));
  const gone = planRerun(record(), none(), flags(), env({ modeAvailable: () => false }));
  assert.match(gone.errors[0], /mode "review" is not available for claude now.*untrust|trust/);
});

test('planRerun: --fanout reruns every member harness; refused for a non-fan-out run or with --resume', () => {
  const fid = newFanoutId();
  const a = record({ fanoutId: fid, harness: 'claude' });
  const b = record({ fanoutId: fid, harness: 'codex' });
  const plan = planRerun(a, none(), flags({ fanout: true }), env({ siblings: [a, b] }));
  assert.equal(plan.args?.harness, 'claude,codex');
  assert.match(planRerun(record(), none(), flags({ fanout: true }), env()).errors[0], /not part of a fan-out/);
  assert.match(planRerun(a, none(), flags({ fanout: true, resumeOwn: true }), env()).errors[0], /not supported/);
  // without --fanout: just this member, with a hint
  const solo = planRerun(a, none(), flags(), env({ siblings: [a, b] }));
  assert.equal(solo.args?.harness, 'claude');
  assert.ok(solo.notices.some(n => n.includes(fid)));
});

test('planRerun: a hostile record is refused — argv-shaped, control-char, truncated or out-of-range values', () => {
  const bad = (rec: RunRecord, over: DelegateCommandArgs = none(), f: Partial<RerunFlags> = {}) =>
    planRerun(rec, over, flags(f), env());
  assert.match(
    bad(record({ sessionId: '--dangerously-skip' }), none(), { resumeOwn: true }).errors[0],
    /invalid sessionId/,
  );
  assert.match(bad(record({}, { model: '--evil' })).errors[0], /invalid model/);
  assert.match(bad(record({}, { model: 'a\u001b[31mb' })).errors[0], /invalid model/);
  assert.match(bad(record({}, { pr: '--repo=evil/x' })).errors[0], /invalid pr/);
  assert.match(bad(record({}, { addDirs: ['ok', 'bad\u0000dir'] })).errors[0], /invalid addDirs/);
  assert.match(bad(record({}, { task: 'do\u001b[2Jit' })).errors[0], /control characters/);
  assert.match(bad(record({}, { scope: 'a\u0007b' })).errors[0], /control characters/);
  assert.match(bad(record({}, { task: '   ' })).errors[0], /empty/);
  assert.match(bad(record({}, { taskTruncated: true })).errors[0], /truncated/);
  assert.match(bad(record({}, { budgetUsd: -1 })).errors[0], /budget/);
  assert.match(bad(record({}, { timeoutSec: 3 })).errors[0], /timeout/);
  assert.match(bad(record({ harness: '--yolo' })).errors[0], /unknown harness/);
  // the error text itself is sanitized
  assert.ok(!bad(record({}, { pr: '--x\u001b[31m' })).errors[0].includes('\u001b'));
});

test('selectRecord: run id, no selector (latest completed), numeric view position, legacy and bad selectors', async () => {
  await withSandbox({}, async () => {
    const dir = outputsDir('claude');
    mkdirSync(dir, { recursive: true });
    const old = record({ startedAt: '2026-01-01T00:00:00.000Z' });
    const recent = record({ startedAt: '2026-06-01T00:00:00.000Z' });
    const partial = record({ startedAt: '2026-09-01T00:00:00.000Z', partial: true });
    writeRunRecord(join(dir, 'old.md'), old);
    writeRunRecord(join(dir, 'recent.md'), recent);
    writeRunRecord(join(dir, 'p-partial.md'), partial);
    const sel = (s: string | undefined, view: Parameters<typeof selectRecord>[1] = []) => selectRecord(s, view);
    assert.equal((sel(undefined) as { record: RunRecord }).record.runId, recent.runId);
    assert.equal((sel(old.runId) as { record: RunRecord }).record.runId, old.runId);
    assert.equal(
      (sel(partial.runId) as { record: RunRecord }).record.runId,
      partial.runId,
      'a partial run is reachable by id',
    );
    assert.equal(sel('run_0000000000000000').ok, false);
    assert.equal(sel('0').ok, false);
    assert.equal(sel('nope').ok, false);
    const view = [
      { file: join(dir, 'recent.md'), hasRecord: true, mode: 'review' },
      { file: join(dir, 'legacy.md'), hasRecord: false, mode: 'plan' },
    ] as never;
    assert.equal((sel('1', view) as { record: RunRecord }).record.runId, recent.runId);
    assert.match((sel('2', view) as { error: string }).error, /predates run records/);
    assert.match((sel('3', view) as { error: string }).error, /no run #3/);
  });
});

const ARGS = (argsFile: string, name = 'claude'): string => (readArgs(`${argsFile}.${name}`) ?? []).join('\n');
const ran = (argsFile: string, name = 'claude'): boolean => {
  const argv = readArgs(`${argsFile}.${name}`);
  return argv !== null && !(argv.length === 1 && argv[0] === '--version');
};

async function captureStderr<T>(fn: () => Promise<T>): Promise<{ value: T; err: string }> {
  const errs: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((c: string | Uint8Array) => {
    errs.push(String(c));
    return true;
  }) as typeof process.stderr.write;
  try {
    return { value: await fn(), err: errs.join('') };
  } finally {
    process.stderr.write = orig;
  }
}

test('/delegate rerun (e2e): repeats the run via the normal path with a fresh session; verify is not replayed', async () => {
  await withSandbox({ templates: { 'claude/tinker': tpl('tinker', 'edit') } }, async ({ cwd }) => {
    await withFakeBinaries(['claude'], [CLAUDE_RESULT], async argsFile => {
      const execs: string[] = [];
      const { commands } = await loadExtension(async (cmd, args) => {
        execs.push(`${cmd} ${args.join(' ')}`);
        return { stdout: '', stderr: '', code: 0 };
      });
      const ctx = fakeCtx(cwd);
      const h = commands.get('delegate')?.handler as (a: string, c: unknown) => Promise<void>;
      await h('claude tinker --verify="echo verifying" fix the widget', ctx);
      assert.ok(
        execs.some(e => e.startsWith('sh -c echo verifying')),
        'original verify ran',
      );
      execs.length = 0;
      rmSync(`${argsFile}.claude`, { force: true });
      const { err } = await captureStderr(() => h('rerun', ctx));
      assert.ok(ran(argsFile), err);
      assert.match(ARGS(argsFile), /fix the widget/);
      assert.ok(!ARGS(argsFile).includes('--resume'), 'fresh session by default');
      assert.deepEqual(execs, [], 'verify command is not replayed');
      assert.match(err, /verify command.*not replayed/);
      assert.match(err, /fresh session/);
      // --resume continues the recorded session
      rmSync(`${argsFile}.claude`, { force: true });
      await captureStderr(() => h('rerun --resume', ctx));
      assert.match(ARGS(argsFile), /--resume\nsess-1/);
      assert.equal(readdirSync(outputsDirFor()).filter(f => f.endsWith('.json')).length, 3);
    });
  });
});

function outputsDirFor(): string {
  return outputsDir('claude');
}

test('/delegate rerun (e2e): a danger run is not replayed as danger; --allow-dangerous needs the human again', async () => {
  await withSandbox({ templates: { 'claude/tinker': tpl('tinker', 'edit') } }, async ({ cwd }) => {
    const { delegate } = await import('../extensions/engine.ts');
    await withFakeBinaries(['claude'], [CLAUDE_RESULT], async argsFile => {
      // original: escalated to danger via the engine (as a confirmed --allow-dangerous would)
      const first = await delegate(
        fakePi(async () => ({})),
        fakeCtx(cwd),
        {
          harness: 'claude',
          mode: 'tinker',
          task: 'risky thing',
          allowDangerous: true,
        },
      );
      assert.equal(first.details.permission, 'danger');
      assert.match(ARGS(argsFile), /bypassPermissions/);
      rmSync(`${argsFile}.claude`, { force: true });
      const { commands } = await loadExtension(async () => ({ stdout: '', stderr: '', code: 0 }));
      const h = commands.get('delegate')?.handler as (a: string, c: unknown) => Promise<void>;
      const plain = await captureStderr(() => h('rerun', fakeCtx(cwd)));
      assert.ok(ran(argsFile), plain.err);
      assert.ok(!/bypassPermissions/.test(ARGS(argsFile)), 'the rerun runs at the template tier, not danger');
      assert.match(plain.err, /never replayed/);
      // typing --allow-dangerous again headless: refused, nothing runs
      rmSync(`${argsFile}.claude`, { force: true });
      const again = await captureStderr(() => h('rerun --allow-dangerous', fakeCtx(cwd)));
      assert.match(again.err, /needs interactive confirmation/);
      assert.ok(!ran(argsFile));
    });
  });
});

test('/delegate rerun (e2e): a hand-edited hostile sidecar never reaches a harness', async () => {
  await withSandbox({ templates: { 'claude/tinker': tpl('tinker', 'edit') } }, async ({ cwd }) => {
    await withFakeBinaries(['claude'], [CLAUDE_RESULT], async argsFile => {
      const dir = outputsDir('claude');
      const { commands } = await loadExtension(async () => ({ stdout: '', stderr: '', code: 0 }));
      const h = commands.get('delegate')?.handler as (a: string, c: unknown) => Promise<void>;
      await captureStderr(() => h('claude tinker seed run', fakeCtx(cwd)));
      const name = readdirSync(dir).find(f => f.endsWith('.json')) as string;
      const good = JSON.parse(readFileSync(join(dir, name), 'utf8')) as RunRecord;
      const attempts: Array<[string, (r: Record<string, unknown>) => void, string]> = [
        [
          'leading-dash model',
          r => ((r.input as Record<string, unknown>).model = '--dangerously-bypass'),
          'invalid model',
        ],
        ['argv-shaped pr', r => ((r.input as Record<string, unknown>).pr = '--repo=evil/x'), 'invalid pr'],
        ['control-char addDir', r => ((r.input as Record<string, unknown>).addDirs = ['a\u0000b']), 'invalid addDirs'],
        [
          'control-char task',
          r => ((r.input as Record<string, unknown>).task = 'x\u001b]0;pwned\u0007'),
          'control characters',
        ],
        ['wrong type', r => (r.harness = 7), 'no run record'],
        ['oversized task', r => ((r.input as Record<string, unknown>).task = 'x'.repeat(50_000)), 'no run record'],
        ['unknown mode', r => (r.mode = 'does-not-exist'), 'not available'],
        ['unknown harness', r => (r.harness = 'evil'), 'unknown harness'],
      ];
      for (const [label, edit, expected] of attempts) {
        const copy = JSON.parse(JSON.stringify(good)) as Record<string, unknown>;
        edit(copy);
        writeFileSync(join(dir, name), JSON.stringify(copy));
        rmSync(`${argsFile}.claude`, { force: true });
        const { err } = await captureStderr(() => h(`rerun ${good.runId}`, fakeCtx(cwd)));
        assert.match(err, new RegExp(expected), `${label}: ${err}`);
        assert.ok(!ran(argsFile), `${label}: nothing may run`);
        assert.ok(!err.includes('\u001b'), `${label}: no raw escapes echoed`);
      }
    });
  });
});

test('/delegate rerun (e2e): another cwd needs --here; --fanout reruns every recorded member', async () => {
  await withSandbox({}, async ({ cwd }) => {
    await withFakeBinaries(['claude', 'codex'], [CLAUDE_RESULT, ...CODEX_RESULT_LINES], async argsFile => {
      await withOnlyFakes(argsFile, async () => {
        const { commands } = await loadExtension(async () => ({ stdout: '', stderr: '', code: 0 }));
        const h = commands.get('delegate')?.handler as (a: string, c: unknown) => Promise<void>;
        await captureStderr(() => h('claude,codex general compare approaches', fakeCtx(cwd)));
        assert.ok(ran(argsFile, 'claude') && ran(argsFile, 'codex'));
        rmSync(`${argsFile}.claude`, { force: true });
        rmSync(`${argsFile}.codex`, { force: true });
        // single member only, by default
        await captureStderr(() => h('rerun', fakeCtx(cwd)));
        assert.equal([ran(argsFile, 'claude'), ran(argsFile, 'codex')].filter(Boolean).length, 1);
        rmSync(`${argsFile}.claude`, { force: true });
        rmSync(`${argsFile}.codex`, { force: true });
        const other = join(cwd, '..', 'elsewhere');
        mkdirSync(other, { recursive: true });
        const moved = await captureStderr(() => h('rerun', fakeCtx(other)));
        assert.match(moved.err, /pass --here/);
        assert.ok(!ran(argsFile, 'claude') && !ran(argsFile, 'codex'));
        const member = readdirSync(outputsDir('codex'))
          .filter(f => f.endsWith('.json'))
          .map(f => JSON.parse(readFileSync(join(outputsDir('codex'), f), 'utf8')) as RunRecord)
          .find(r => r.fanoutId);
        assert.ok(member);
        await captureStderr(() => h(`rerun ${member.runId} --fanout`, fakeCtx(cwd)));
        assert.ok(ran(argsFile, 'claude') && ran(argsFile, 'codex'), 'both members rerun');
      });
    });
  });
});

test('recordPathFor is what the rerun reads', () => {
  assert.equal(recordPathFor('/a/b.md'), '/a/b.json');
});
