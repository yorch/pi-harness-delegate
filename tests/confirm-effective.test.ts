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
