import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { defaultDelegateConfig, resolveRunTimeoutMs } from '../extensions/config.ts';
import {
  parseTemplate,
  parseTemplateTimeout,
  TEMPLATE_TIMEOUT_MAX_SEC,
  TEMPLATE_TIMEOUT_MIN_SEC,
} from '../extensions/templates.ts';
import { CLAUDE_RESULT, fakeCtx, fakePi, tpl, withFakeBinaries, withSandbox } from './helpers/sandbox.ts';

test('parseTemplateTimeout: accepts whole seconds within bounds, ignores everything else with a warning', () => {
  assert.deepEqual(parseTemplateTimeout(undefined), {});
  assert.deepEqual(parseTemplateTimeout('  '), {});
  assert.deepEqual(parseTemplateTimeout(String(TEMPLATE_TIMEOUT_MIN_SEC)), { timeoutSec: TEMPLATE_TIMEOUT_MIN_SEC });
  assert.deepEqual(parseTemplateTimeout(' 900 '), { timeoutSec: 900 });
  assert.deepEqual(parseTemplateTimeout(String(TEMPLATE_TIMEOUT_MAX_SEC)), { timeoutSec: TEMPLATE_TIMEOUT_MAX_SEC });
  for (const bad of ['9', '7201', '0', '-30', '1.5', '1e3', 'abc', '600s', 'Infinity', '99999999999999']) {
    const r = parseTemplateTimeout(bad);
    assert.equal(r.timeoutSec, undefined, bad);
    assert.match(r.warning ?? '', /^timeout: ".*" ignored — must be a whole number of seconds from 10 to 7200/, bad);
  }
});

test('parseTemplate: timeout lands on the template; an invalid one is a field warning, not a permission one', () => {
  const ok = parseTemplate(tpl('t', 'edit', 'timeout: 120'));
  assert.equal(ok?.timeoutSec, 120);
  assert.equal(ok?.fieldWarnings, undefined);
  const bad = parseTemplate(tpl('t', 'edit', 'timeout: 99999'));
  assert.equal(bad?.timeoutSec, undefined);
  assert.equal(bad?.permissionWarning, undefined);
  assert.equal(bad?.permission, 'edit');
  assert.match(bad?.fieldWarnings?.[0] ?? '', /timeout: "99999" ignored/);
  // a hostile value is quoted and capped in the warning, never echoed raw
  const hostile = parseTemplate(tpl('t', 'edit', `timeout: \u001b[31m${'x'.repeat(500)}`));
  const w = hostile?.fieldWarnings?.[0] ?? '';
  assert.ok(!w.includes('\u001b'), w);
  assert.ok(w.length < 250, w);
});

test('resolveRunTimeoutMs: template over global default, per-harness config is a ceiling, hard cap holds', () => {
  const cfg = defaultDelegateConfig();
  cfg.timeoutMs = 600_000;
  // no template timeout: unchanged precedence (per-harness ?? global)
  assert.equal(resolveRunTimeoutMs(cfg, 'claude'), 600_000);
  cfg.harnesses.codex = { timeoutMs: 120_000 };
  assert.equal(resolveRunTimeoutMs(cfg, 'codex'), 120_000);
  // template replaces the global default — up or down
  assert.equal(resolveRunTimeoutMs(cfg, 'claude', 1800), 1_800_000);
  assert.equal(resolveRunTimeoutMs(cfg, 'claude', 30), 30_000);
  // an explicit per-harness timeout caps a template, but a shorter template still wins
  assert.equal(resolveRunTimeoutMs(cfg, 'codex', 1800), 120_000);
  assert.equal(resolveRunTimeoutMs(cfg, 'codex', 60), 60_000);
  // defense in depth: never above the template max, whatever reaches here
  assert.equal(resolveRunTimeoutMs(cfg, 'claude', 1_000_000), TEMPLATE_TIMEOUT_MAX_SEC * 1000);
  // garbage per-harness / template values don't produce a zero/NaN timeout
  cfg.harnesses.amp = { timeoutMs: -5 };
  assert.equal(resolveRunTimeoutMs(cfg, 'amp'), 600_000);
  assert.equal(resolveRunTimeoutMs(cfg, 'amp', Number.NaN), 600_000);
});

test('delegate: a template timeout replaces a short global timeout for the real run', async () => {
  // global timeoutMs 200ms would kill a harness that takes ~0.8s; the template's 10s lets it finish
  await withSandbox(
    { settings: { timeoutMs: 200 }, templates: { 'claude/slow': tpl('slow', 'edit', 'timeout: 10') } },
    async ({ cwd }) => {
      const { delegate } = await import('../extensions/engine.ts');
      await withFakeBinaries(
        ['claude'],
        [CLAUDE_RESULT],
        async () => {
          const run = await delegate(
            fakePi(async () => ({})),
            fakeCtx(cwd),
            { harness: 'claude', mode: 'slow', task: 'x' },
          );
          assert.equal(run.content, 'all good');
          assert.equal(run.details.timeoutMs, 10_000);
        },
        { sleepAfterSec: 0.8 },
      );
    },
  );
});

test('delegate: an explicit per-harness timeout still caps a longer template timeout', async () => {
  await withSandbox(
    {
      settings: { harnesses: { claude: { timeoutMs: 200 } } },
      templates: { 'claude/slow': tpl('slow', 'edit', 'timeout: 3600') },
    },
    async ({ cwd }) => {
      const { delegate } = await import('../extensions/engine.ts');
      await withFakeBinaries(
        ['claude'],
        [CLAUDE_RESULT],
        async () => {
          await assert.rejects(
            () =>
              delegate(
                fakePi(async () => ({})),
                fakeCtx(cwd),
                { harness: 'claude', mode: 'slow', task: 'x' },
              ),
            /timed out after 200ms/,
          );
        },
        { sleepAfterSec: 5 },
      );
    },
  );
});

test('delegate: an invalid template timeout is ignored with a run-time warning, config timeout applies', async () => {
  await withSandbox({ templates: { 'claude/t': tpl('t', 'edit', 'timeout: 86400') } }, async ({ cwd }) => {
    const { delegate } = await import('../extensions/engine.ts');
    const notes: string[] = [];
    const ctx = {
      cwd,
      hasUI: true,
      isProjectTrusted: () => true,
      ui: { notify: (m: string) => notes.push(m) },
    } as never;
    await withFakeBinaries(['claude'], [CLAUDE_RESULT], async () => {
      const run = await delegate(
        fakePi(async () => ({})),
        ctx,
        { harness: 'claude', mode: 't', task: 'x' },
      );
      const want = '⚠ template "t": timeout: "86400" ignored';
      assert.ok(run.content.startsWith(want), run.content);
      assert.ok(run.content.endsWith('all good'));
      assert.equal(run.details.timeoutMs, 600_000);
      assert.match(String((run.details.templateWarnings as string[])[0]), /timeout: "86400" ignored/);
      assert.ok(notes.some(n => n.startsWith(want)));
      assert.match(
        readFileSync(String(run.details.file), 'utf8'),
        /- warning: ⚠ template "t": timeout: "86400" ignored/,
      );
    });
  });
});
