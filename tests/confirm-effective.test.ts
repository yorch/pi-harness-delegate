/**
 * What a confirmation says will apply must be what the engine does. The `will apply` row resolves the verify
 * command against the tier the run will ACTUALLY have — `danger` as soon as `allowDangerous` is being confirmed,
 * whatever the template says — and these tests compare the displayed text with what really happens: the fake
 * `pi.exec` is called with `sh -c <verify>` or it is not, and the dialog must have said so.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig, outputsDir } from '../extensions/config.ts';
import { effectiveRunLines } from '../extensions/effective.ts';
import { delegate, resolveRunPermission } from '../extensions/engine.ts';
import { getHarness } from '../extensions/harnesses/registry.ts';
import type { RunRecord } from '../extensions/run-record.ts';
import { unwrap } from './helpers/dialog.ts';
import {
  type CapturedTool,
  CLAUDE_RESULT,
  CODEX_RESULT_LINES,
  fakeCtx,
  fakePi,
  loadExtension,
  tpl,
  uiCtx,
  withFakeBinaries,
  withOnlyFakes,
  withSandbox,
} from './helpers/sandbox.ts';

const TIERS = ['readonly', 'edit', 'danger'] as const;
const VERIFY = 'echo VERIFY-RAN';
const TEMPLATES = Object.fromEntries(
  TIERS.flatMap(t => [
    [`claude/${t}`, tpl(t, t, `verify: ${VERIFY}`)],
    [`codex/${t}`, tpl(t, t, `verify: ${VERIFY}`)],
  ]),
);

/** A fake `pi.exec` that remembers whether the verify command was run on the host (`sh -c <cmd>`). */
function recorder() {
  const verifies: string[] = [];
  const exec = async (cmd: string, args: string[]) => {
    if (cmd === 'sh' && args[0] === '-c') verifies.push(args[1]);
    return { stdout: '', stderr: '', code: 0 };
  };
  return { verifies, exec };
}

/** What the dialog says about the verify command: `run`, `skip` (a readonly tier), or `none`. Never both. */
function shownVerify(text: string): 'run' | 'skip' | 'none' {
  const t = unwrap(text);
  const run = /verify "echo VERIFY-RAN" \([^)]*; runs on this machine/.test(t);
  const skip = /verify "echo VERIFY-RAN" \([^)]*; NOT run: readonly tier/.test(t);
  assert.ok(!(run && skip), `the dialog cannot say both\n${t}`);
  return run ? 'run' : skip ? 'skip' : 'none';
}

test('resolveRunPermission is what the engine uses: allowDangerous escalates any template to danger', async () => {
  await withSandbox({ templates: TEMPLATES }, async ({ cwd }) => {
    const harness = getHarness('claude');
    assert.ok(harness);
    if (!harness) return;
    const { loadTemplates } = await import('../extensions/templates.ts');
    const templates = loadTemplates(cwd, 'claude', true);
    for (const tier of TIERS)
      for (const allow of [false, true]) {
        const t = templates.get(tier);
        assert.ok(t);
        if (!t) continue;
        const p = resolveRunPermission(harness, t, allow);
        assert.equal(p.permission, tier === 'danger' || allow ? 'danger' : tier, `${tier} allow=${allow}`);
      }
  });
});

for (const tier of TIERS)
  for (const allow of [false, true])
    test(`effectiveRunLines vs delegate(): ${tier} template, allowDangerous=${allow}: the verify line matches what ran`, async () => {
      await withSandbox({ templates: TEMPLATES }, async ({ cwd }) => {
        await withFakeBinaries(['claude'], [CLAUDE_RESULT], async argsFile => {
          await withOnlyFakes(argsFile, async () => {
            const ctx = fakeCtx(cwd);
            const shown = shownVerify(
              effectiveRunLines(ctx, loadConfig(), ['claude'], tier, { allowDangerous: allow }).join('\n'),
            );
            const rec = recorder();
            const refused = tier === 'danger' && !allow; // the engine refuses a danger template without allowDangerous
            const run = delegate(fakePi(rec.exec), ctx, {
              harness: 'claude',
              mode: tier,
              task: 'look',
              allowDangerous: allow,
            });
            if (refused) await assert.rejects(run, /requires danger permission/);
            else await run;
            assert.equal(shown === 'skip', tier === 'readonly' && !allow, `${tier} allow=${allow}: shown ${shown}`);
            // (a refused run never gets as far as verify — and the dialog for it is never shown)
            if (!refused)
              assert.equal(shown === 'run', rec.verifies.length > 0, `shown ${shown}, ran ${rec.verifies.length}x`);
            else assert.equal(rec.verifies.length, 0);
          });
        });
      });
    });

for (const tier of TIERS)
  test(`tool danger confirm: ${tier} template + allowDangerous: the dialog's verify line is what runs`, async () => {
    await withSandbox({ templates: TEMPLATES }, async ({ cwd }) => {
      await withFakeBinaries(['claude'], [CLAUDE_RESULT], async argsFile => {
        await withOnlyFakes(argsFile, async () => {
          const rec = recorder();
          const { tools } = await loadExtension(rec.exec);
          const u = uiCtx(cwd, true);
          await (tools.get('delegate') as CapturedTool).execute(
            't',
            { harness: 'claude', mode: tier, task: 'look', allowDangerous: true },
            undefined,
            undefined,
            u.ctx,
          );
          assert.equal(u.asked.length, 1);
          const shown = shownVerify(u.asked[0]);
          assert.equal(shown, 'run', 'an approved allowDangerous run is danger: its verify command runs');
          assert.equal(rec.verifies.length, 1, 'and it really did');
          assert.equal(shown === 'run', rec.verifies.length > 0);
        });
      });
    });
  });

for (const tier of TIERS)
  for (const allow of [false, true])
    test(`command: ${tier} template, ${allow ? '--allow-dangerous (confirmed)' : 'no --allow-dangerous'}, typed --verify: what the dialog says is what runs`, async () => {
      await withSandbox({ templates: TEMPLATES }, async ({ cwd }) => {
        await withFakeBinaries(['claude'], [CLAUDE_RESULT], async argsFile => {
          await withOnlyFakes(argsFile, async () => {
            const rec = recorder();
            const { commands } = await loadExtension(rec.exec);
            const u = uiCtx(cwd, true);
            const quiet = process.stdout.write.bind(process.stdout);
            process.stdout.write = (() => true) as typeof process.stdout.write;
            try {
              await commands
                .get('delegate')
                ?.handler(`claude ${tier} ${allow ? '--allow-dangerous ' : ''}--verify="${VERIFY}" look`, u.ctx);
            } finally {
              process.stdout.write = quiet;
            }
            if (allow) {
              assert.equal(u.asked.length, 1);
              const shown = shownVerify(u.asked[0]);
              assert.equal(shown, 'run');
              assert.equal(rec.verifies.length > 0, true, 'the verify command ran');
              return;
            }
            // no danger dialog without the flag: the same resolution, asked directly with the tier the run has
            const shown = shownVerify(
              effectiveRunLines(u.ctx as never, loadConfig(), ['claude'], tier, { verify: VERIFY }).join('\n'),
            );
            const ran = rec.verifies.length > 0;
            if (tier === 'danger') assert.equal(ran, false, 'a danger template is refused without --allow-dangerous');
            else assert.equal(shown === 'run', ran, `${tier}: shown ${shown}, ran ${ran}`);
          });
        });
      });
    });

test('command fan-out danger confirm: a readonly template escalated by --allow-dangerous runs verify on every member, and says so', async () => {
  await withSandbox({ templates: TEMPLATES }, async ({ cwd }) => {
    await withFakeBinaries(['claude', 'codex'], [CLAUDE_RESULT, ...CODEX_RESULT_LINES], async argsFile => {
      await withOnlyFakes(argsFile, async () => {
        const rec = recorder();
        const { commands } = await loadExtension(rec.exec);
        const u = uiCtx(cwd, true);
        const quiet = process.stdout.write.bind(process.stdout);
        process.stdout.write = (() => true) as typeof process.stdout.write;
        try {
          await commands.get('delegate')?.handler('claude,codex readonly --allow-dangerous look around', u.ctx);
        } finally {
          process.stdout.write = quiet;
        }
        assert.equal(u.asked.length, 1);
        assert.equal(shownVerify(u.asked[0]), 'run');
        assert.equal(rec.verifies.length, 2, 'both members ran the verify command');
      });
    });
  });
});

test('tool resumeFanout plan: the verify line follows the tier the resumed run will have (readonly template: skipped, unless allowDangerous is requested)', async () => {
  const templates = {
    'claude/ro': tpl('ro', 'readonly', `verify: ${VERIFY}`),
    'codex/ro': tpl('ro', 'readonly', `verify: ${VERIFY}`),
  };
  for (const allow of [false, true])
    await withSandbox({ templates }, async ({ cwd }) => {
      await withFakeBinaries(['claude', 'codex'], [CLAUDE_RESULT, ...CODEX_RESULT_LINES], async argsFile => {
        await withOnlyFakes(argsFile, async () => {
          const rec = recorder();
          const { commands, tools } = await loadExtension(rec.exec);
          const quiet = process.stdout.write.bind(process.stdout);
          process.stdout.write = (() => true) as typeof process.stdout.write;
          try {
            await commands.get('delegate')?.handler('claude,codex ro first pass', fakeCtx(cwd));
          } finally {
            process.stdout.write = quiet;
          }
          const dir = outputsDir('claude');
          const name = readdirSync(dir).find(f => f.endsWith('.json')) as string;
          const id = (JSON.parse(readFileSync(join(dir, name), 'utf8')) as RunRecord).fanoutId as string;
          rec.verifies.length = 0;
          const u = uiCtx(cwd, true);
          await (tools.get('delegate') as CapturedTool).execute(
            't',
            { task: 'again', resumeFanout: id, allowDangerous: allow },
            undefined,
            undefined,
            u.ctx,
          );
          const plan = shownVerify(u.asked[0]);
          assert.equal(plan, allow ? 'run' : 'skip', `plan dialog, allowDangerous=${allow}`);
          if (allow) assert.equal(shownVerify(u.asked[1]), 'run', 'the danger dialog agrees');
          assert.equal(plan === 'run', rec.verifies.length > 0, `plan said ${plan}; ran ${rec.verifies.length}x`);
        });
      });
    });
});

// ── what the template adds to the run, shown (and equal to what is passed on) ───────────────────────────────

const argvOf = (file: string): string[] => readFileSync(file, 'utf8').trim().split('\n');

test('a template addDirs: is in the will-apply row, resolved the way the engine passes it to the harness', async () => {
  await withSandbox(
    { templates: { 'claude/dirs': tpl('dirs', 'edit', 'addDirs: ./shared, /abs/other') } },
    async ({ cwd }) => {
      await withFakeBinaries(['claude'], [CLAUDE_RESULT], async argsFile => {
        await withOnlyFakes(argsFile, async () => {
          const row = effectiveRunLines(fakeCtx(cwd), loadConfig(), ['claude'], 'dirs', {}).join('\n');
          assert.ok(row.includes(`template addDirs (2): ${JSON.stringify(join(cwd, 'shared'))} · "/abs/other"`), row);
          await delegate(fakePi(recorder().exec), fakeCtx(cwd), { harness: 'claude', mode: 'dirs', task: 'x' });
          const argv = argvOf(argsFile);
          assert.deepEqual(
            argv.flatMap((a, i) => (a === '--add-dir' ? [argv[i + 1]] : [])),
            [join(cwd, 'shared'), '/abs/other'],
            'the harness got exactly the directories the dialog listed',
          );
        });
      });
    },
  );
});

test('the native permission the run passes on is shown: a safe one as declared, an unlisted one (confirmed) as declared, none once escalated', async () => {
  await withSandbox(
    {
      templates: {
        'claude/nat': tpl('nat', 'plan'),
        'claude/odd': tpl('odd', 'weirdmode'),
      },
    },
    async ({ cwd }) => {
      await withFakeBinaries(['claude'], [CLAUDE_RESULT], async argsFile => {
        await withOnlyFakes(argsFile, async () => {
          const ctx = fakeCtx(cwd);
          const row = (mode: string, allow: boolean): string =>
            effectiveRunLines(ctx, loadConfig(), ['claude'], mode, { allowDangerous: allow }).join('\n');
          assert.match(row('nat', false), /native permission "plan" \(as the template declares\)/);
          await delegate(fakePi(recorder().exec), ctx, { harness: 'claude', mode: 'nat', task: 'x' });
          assert.ok(argvOf(argsFile).includes('plan'), 'plan is what the harness got');
          // escalated: the template's native value is dropped, and so it is not claimed
          assert.doesNotMatch(row('nat', true), /native permission/);
          await delegate(fakePi(recorder().exec), ctx, {
            harness: 'claude',
            mode: 'nat',
            task: 'x',
            allowDangerous: true,
          });
          assert.ok(!argvOf(argsFile).includes('plan'));
          // an unlisted native mode runs as declared once confirmed
          assert.match(row('odd', true), /native permission "weirdmode"/);
          await delegate(fakePi(recorder().exec), ctx, {
            harness: 'claude',
            mode: 'odd',
            task: 'x',
            allowDangerous: true,
          });
          assert.ok(argvOf(argsFile).includes('weirdmode'), 'weirdmode is what the harness got');
        });
      });
    },
  );
});

test('an empty tool task runs the template defaultTask: the will-apply row says so; a given task shows nothing extra; defaultScope is not applied on the tool path', async () => {
  await withSandbox(
    { templates: { 'claude/dflt': tpl('dflt', 'edit', 'defaultTask: do the template job\ndefaultScope: src/only') } },
    async ({ cwd }) => {
      await withFakeBinaries(['claude'], [CLAUDE_RESULT], async argsFile => {
        await withOnlyFakes(argsFile, async () => {
          const ctx = fakeCtx(cwd);
          const row = (task: string): string =>
            effectiveRunLines(ctx, loadConfig(), ['claude'], 'dflt', { task }).join('\n');
          assert.match(row(''), /no task given: the template's default task runs: "do the template job"/);
          assert.doesNotMatch(row('real task'), /default task/);
          await delegate(fakePi(recorder().exec), ctx, { harness: 'claude', mode: 'dflt', task: '' });
          const prompt = argvOf(argsFile).join('\n');
          assert.ok(prompt.includes('do the template job'), 'the engine ran the default task the dialog named');
          assert.ok(
            !prompt.includes('src/only'),
            'defaultScope is only applied by the command path (which shows it), never on the tool path',
          );
        });
      });
    },
  );
});

test('a long template default task is shown by its head with the exact count left out — never silently cut', async () => {
  await withSandbox(
    { templates: { 'claude/long': tpl('long', 'edit', `defaultTask: ${'x'.repeat(150)}`) } },
    async ({ cwd }) => {
      const row = effectiveRunLines(fakeCtx(cwd), loadConfig(), ['claude'], 'long', { task: '' }).join('\n');
      assert.ok(row.includes(`${'x'.repeat(100)}" (+50 more characters)`), row);
    },
  );
});

// ── the budget / timeout / transport resolution, pinned (a reverted rule shows a different value than the engine's) ──

test('will-apply budget: a stored budget can only lower the configured one; a typed one replaces it', async () => {
  await withSandbox({ settings: { maxBudgetUsd: 2 }, templates: TEMPLATES }, async ({ cwd }) => {
    const budget = (call: Parameters<typeof effectiveRunLines>[4]): string =>
      effectiveRunLines(fakeCtx(cwd), loadConfig(), ['claude'], 'edit', call)
        .join('\n')
        .match(/budget (\$[\d.]+)/)?.[1] ?? '';
    assert.equal(budget({ budgetUsd: 10, budgetNarrowOnly: true }), '$2', 'stored 10 cannot raise the configured 2');
    assert.equal(budget({ budgetUsd: 1, budgetNarrowOnly: true }), '$1', 'stored 1 lowers it');
    assert.equal(budget({ budgetUsd: 10 }), '$10', 'a typed 10 replaces it');
    assert.equal(budget({}), '$2', 'nothing given: the configured one');
  });
});

test('will-apply timeout: a model-set / stored timeout only lowers the configured one; a typed one may raise it', async () => {
  await withSandbox({ settings: { timeoutMs: 60_000 }, templates: TEMPLATES }, async ({ cwd }) => {
    const timeout = (call: Parameters<typeof effectiveRunLines>[4]): string =>
      effectiveRunLines(fakeCtx(cwd), loadConfig(), ['claude'], 'edit', call)
        .join('\n')
        .match(/timeout (\d+)s/)?.[1] ?? '';
    assert.equal(timeout({ timeoutSec: 120 }), '60', 'model-set 120s cannot raise the configured 60s');
    assert.equal(timeout({ timeoutSec: 30 }), '30');
    assert.equal(timeout({ timeoutSec: 120, timeoutMayRaise: true }), '120', 'a typed one may raise it');
    assert.equal(timeout({}), '60');
  });
});

test('will-apply transport: the configured one, or INVALID for one the harness does not support — never a hard-coded stdout', async () => {
  await withSandbox(
    { settings: { harnesses: { opencode: { transport: 'acp' }, claude: { transport: 'acp' } } }, templates: TEMPLATES },
    async ({ cwd }) => {
      const rows = effectiveRunLines(fakeCtx(cwd), loadConfig(), ['opencode', 'claude'], 'implement', {}).join('\n');
      assert.match(rows, /\(opencode\).*transport acp/);
      assert.match(rows, /\(claude\).*transport INVALID/);
      assert.doesNotMatch(rows, /\(claude\).*transport stdout/);
    },
  );
});

test('a fan-out will-apply: one shared row, and a member lists only what differs from it (or lacks)', async () => {
  await withSandbox(
    { templates: { 'claude/m': tpl('m', 'edit', 'addDirs: ./only-claude'), 'codex/m': tpl('m', 'edit') } },
    async ({ cwd }) => {
      const rows = effectiveRunLines(fakeCtx(cwd), loadConfig(), ['claude', 'codex'], 'm', { model: 'same' });
      assert.equal(rows[0], 'will apply (all 2): model "same", budget none, timeout 600s, transport stdout');
      assert.equal(rows.length, 2, rows.join('\n'));
      assert.match(rows[1], /^will apply \(claude\): template addDirs \(1\)/);
      // three members, two sharing a value: the minority lists its own
      const three = effectiveRunLines(fakeCtx(cwd), loadConfig(), ['claude', 'codex', 'devin'], 'implement', {
        model: 'same',
      });
      assert.match(three[0], /^will apply \(all 3\): model "same", budget none, timeout 600s, transport stdout$/);
      assert.deepEqual(three.slice(1), ['will apply (devin): transport acp']);
    },
  );
});

test('a fan-out member that LACKS a fact the others share says so (the shared row would otherwise claim it for everyone)', async () => {
  await withSandbox(
    {
      templates: {
        'claude/v': tpl('v', 'edit', `verify: ${VERIFY}`),
        'codex/v': tpl('v', 'edit', `verify: ${VERIFY}`),
        'opencode/v': tpl('v', 'edit'),
      },
    },
    async ({ cwd }) => {
      const rows = effectiveRunLines(fakeCtx(cwd), loadConfig(), ['claude', 'codex', 'opencode'], 'v', {
        model: 'same',
      });
      assert.match(
        rows[0],
        /^will apply \(all 3\): model "same".*verify "echo VERIFY-RAN" \(from the template; runs on this machine/,
      );
      assert.deepEqual(rows.slice(1), ['will apply (opencode): no verify command']);
    },
  );
});

test('a stored (narrow-only) budget / timeout is labelled as such in the will-apply row', async () => {
  await withSandbox({ settings: { maxBudgetUsd: 2, timeoutMs: 60_000 }, templates: TEMPLATES }, async ({ cwd }) => {
    const row = effectiveRunLines(fakeCtx(cwd), loadConfig(), ['claude'], 'edit', {
      budgetUsd: 1,
      budgetNarrowOnly: true,
      timeoutSec: 30,
    }).join('\n');
    assert.match(row, /budget \$1 \(stored: only lowers\)/);
    assert.match(row, /timeout 30s \(only lowers\)/);
    const typed = effectiveRunLines(fakeCtx(cwd), loadConfig(), ['claude'], 'edit', {
      budgetUsd: 1,
      timeoutSec: 30,
      timeoutMayRaise: true,
    }).join('\n');
    assert.doesNotMatch(typed, /only lowers/);
  });
});

test('tool danger confirm with an empty task and a template defaultTask: the dialog says which task actually runs', async () => {
  await withSandbox(
    { templates: { 'claude/dflt': tpl('dflt', 'edit', 'defaultTask: do the template job') } },
    async ({ cwd }) => {
      await withFakeBinaries(['claude'], [CLAUDE_RESULT], async argsFile => {
        await withOnlyFakes(argsFile, async () => {
          const rec = recorder();
          const { tools } = await loadExtension(rec.exec);
          const u = uiCtx(cwd, true);
          await (tools.get('delegate') as CapturedTool).execute(
            't',
            { harness: 'claude', mode: 'dflt', task: '', allowDangerous: true },
            undefined,
            undefined,
            u.ctx,
          );
          assert.match(unwrap(u.asked[0]), /no task given: the template's default task runs: "do the template job"/);
          assert.ok(argvOf(argsFile).join('\n').includes('do the template job'));
          // a task that was given is the one that runs: nothing about a default task
          const given = uiCtx(cwd, true);
          await (tools.get('delegate') as CapturedTool).execute(
            't',
            { harness: 'claude', mode: 'dflt', task: 'my own task', allowDangerous: true },
            undefined,
            undefined,
            given.ctx,
          );
          assert.doesNotMatch(unwrap(given.asked[0]), /default task/);
        });
      });
    },
  );
});

test('command resume plan: the verify line follows the tier the resumed run will have (--allow-dangerous escalates a readonly template)', async () => {
  const templates = {
    'claude/ro': tpl('ro', 'readonly', `verify: ${VERIFY}`),
    'codex/ro': tpl('ro', 'readonly', `verify: ${VERIFY}`),
  };
  for (const allow of [false, true])
    await withSandbox({ templates }, async ({ cwd }) => {
      await withFakeBinaries(['claude', 'codex'], [CLAUDE_RESULT, ...CODEX_RESULT_LINES], async argsFile => {
        await withOnlyFakes(argsFile, async () => {
          const rec = recorder();
          const { commands } = await loadExtension(rec.exec);
          const quiet = process.stdout.write.bind(process.stdout);
          process.stdout.write = (() => true) as typeof process.stdout.write;
          const h = commands.get('delegate')?.handler as (a: string, c: unknown) => Promise<void>;
          try {
            await h('claude,codex ro first pass', fakeCtx(cwd));
            const dir = outputsDir('claude');
            const name = readdirSync(dir).find(f => f.endsWith('.json')) as string;
            const id = (JSON.parse(readFileSync(join(dir, name), 'utf8')) as RunRecord).fanoutId as string;
            rec.verifies.length = 0;
            const u = uiCtx(cwd, true);
            await h(`--resume=${id} ${allow ? '--allow-dangerous ' : ''}again`, u.ctx);
            const plan = shownVerify(u.asked[0]);
            assert.equal(plan, allow ? 'run' : 'skip', `plan dialog, --allow-dangerous=${allow}`);
            assert.equal(plan === 'run', rec.verifies.length > 0, `plan said ${plan}; ran ${rec.verifies.length}x`);
          } finally {
            process.stdout.write = quiet;
          }
        });
      });
    });
});
