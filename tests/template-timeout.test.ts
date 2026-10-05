import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseDelegateCommand } from '../extensions/command.ts';
import { defaultDelegateConfig, resolveRunTimeoutMs } from '../extensions/config.ts';
import {
  callTimeoutError,
  parseTemplate,
  parseTemplateTimeout,
  TEMPLATE_TIMEOUT_MAX_SEC,
  TEMPLATE_TIMEOUT_MIN_SEC,
} from '../extensions/templates.ts';
import {
  CLAUDE_RESULT,
  CODEX_RESULT_LINES,
  fakeCtx,
  fakePi,
  loadExtension,
  readArgs,
  tpl,
  uiCtx,
  withFakeBinaries,
  withOnlyFakes,
  withSandbox,
} from './helpers/sandbox.ts';

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

test('resolveRunTimeoutMs: template > per-harness config > global; a model call only lowers it, a human call replaces it', () => {
  const cfg = defaultDelegateConfig();
  cfg.timeoutMs = 600_000;
  // neither call nor template: unchanged precedence (per-harness ?? global)
  assert.equal(resolveRunTimeoutMs(cfg, 'claude'), 600_000);
  cfg.harnesses.codex = { timeoutMs: 120_000 };
  assert.equal(resolveRunTimeoutMs(cfg, 'codex'), 120_000);
  // template beats the global default — up or down
  assert.equal(resolveRunTimeoutMs(cfg, 'claude', 1800), 1_800_000);
  assert.equal(resolveRunTimeoutMs(cfg, 'claude', 30), 30_000);
  // template beats the per-harness config too — up or down
  assert.equal(resolveRunTimeoutMs(cfg, 'codex', 1800), 1_800_000);
  assert.equal(resolveRunTimeoutMs(cfg, 'codex', 60), 60_000);
  // a model-set (default) per-call timeout can only LOWER the configured one, never raise it
  assert.equal(resolveRunTimeoutMs(cfg, 'codex', 1800, 45), 45_000);
  assert.equal(resolveRunTimeoutMs(cfg, 'codex', undefined, 3000), 120_000, 'per-harness 120s is not raised');
  assert.equal(resolveRunTimeoutMs(cfg, 'codex', undefined, 30), 30_000);
  assert.equal(resolveRunTimeoutMs(cfg, 'claude', 30, 900), 30_000, 'template 30s is not raised');
  assert.equal(resolveRunTimeoutMs(cfg, 'claude', undefined, 7200), 600_000, 'global 600s is not raised');
  // a human-typed per-call timeout (callMayRaise) replaces it — up or down
  assert.equal(resolveRunTimeoutMs(cfg, 'codex', 1800, 45, true), 45_000);
  assert.equal(resolveRunTimeoutMs(cfg, 'codex', undefined, 3000, true), 3_000_000);
  assert.equal(resolveRunTimeoutMs(cfg, 'claude', 30, 900, true), 900_000);
  // defense in depth: never above the hard cap, whatever reaches here
  assert.equal(resolveRunTimeoutMs(cfg, 'claude', 1_000_000), TEMPLATE_TIMEOUT_MAX_SEC * 1000);
  assert.equal(resolveRunTimeoutMs(cfg, 'claude', undefined, 1_000_000, true), TEMPLATE_TIMEOUT_MAX_SEC * 1000);
  assert.equal(resolveRunTimeoutMs(cfg, 'claude', 60, Number.POSITIVE_INFINITY, true), 60_000);
  // garbage per-harness / template / call values don't produce a zero/NaN timeout
  cfg.harnesses.amp = { timeoutMs: -5 };
  assert.equal(resolveRunTimeoutMs(cfg, 'amp'), 600_000);
  assert.equal(resolveRunTimeoutMs(cfg, 'amp', Number.NaN, 0), 600_000);
  assert.equal(resolveRunTimeoutMs(cfg, 'amp', Number.NaN, 0, true), 600_000);
});

test('callTimeoutError: whole seconds within the template bounds, anything else is an error', () => {
  assert.equal(callTimeoutError(TEMPLATE_TIMEOUT_MIN_SEC), null);
  assert.equal(callTimeoutError(TEMPLATE_TIMEOUT_MAX_SEC), null);
  for (const bad of [9, 7201, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '60', null])
    assert.match(
      callTimeoutError(bad) ?? '',
      /^timeout must be a whole number of seconds from 10 to 7200/,
      String(bad),
    );
});

test('/delegate --timeout: parsed as whole seconds; out of range, malformed or valueless is an error', () => {
  const modes = new Set(['review']);
  assert.equal(parseDelegateCommand('--timeout=90 review x', modes).timeoutSec, 90);
  assert.equal(parseDelegateCommand('--timeout="120" review x', modes).timeoutSec, 120);
  // only plain decimal digits: Number() would accept every one of these as an in-range integer
  const numberLike = ['1e3', '0x3c', '0o74', '0b111100', '+60', '60.0'];
  for (const raw of [
    '--timeout=5 x',
    '--timeout=9000 x',
    '--timeout=1.5 x',
    '--timeout=60s x',
    '--timeout= x',
    ...numberLike.map(v => `--timeout=${v} x`),
  ]) {
    const p = parseDelegateCommand(raw, modes);
    assert.equal(p.timeoutSec, undefined, raw);
    assert.match(p.errors?.[0] ?? '', /--timeout must be a whole number of seconds from 10 to 7200/, raw);
  }
  const spaced = parseDelegateCommand('--timeout 60 x', modes);
  assert.equal(spaced.timeoutSec, undefined);
  assert.match(spaced.errors?.[0] ?? '', /--timeout needs a value: use --timeout=<sec>/);
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

test('delegate: a template timeout beats a short per-harness timeout; a per-call timeout beats both', async () => {
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
          const run = await delegate(
            fakePi(async () => ({})),
            fakeCtx(cwd),
            { harness: 'claude', mode: 'slow', task: 'x' },
          );
          assert.equal(run.content, 'all good');
          assert.equal(run.details.timeoutMs, 3_600_000);
          const call = await delegate(
            fakePi(async () => ({})),
            fakeCtx(cwd),
            { harness: 'claude', mode: 'slow', task: 'x', timeoutSec: 30 },
          );
          assert.equal(call.details.timeoutMs, 30_000);
        },
        { sleepAfterSec: 0.8 },
      );
    },
  );
});

test('delegate: an out-of-range per-call timeout fails before anything runs', async () => {
  await withSandbox({ templates: { 'claude/t': tpl('t', 'edit') } }, async ({ cwd }) => {
    const { delegate } = await import('../extensions/engine.ts');
    await withFakeBinaries(['claude'], [CLAUDE_RESULT], async argsFile => {
      await assert.rejects(
        () =>
          delegate(
            fakePi(async () => ({})),
            fakeCtx(cwd),
            { harness: 'claude', mode: 't', task: 'x', timeoutSec: 86_400 },
          ),
        /timeout must be a whole number of seconds from 10 to 7200 \(got 86400\)/,
      );
      assert.equal(readArgs(`${argsFile}.claude`), null, 'nothing spawned');
    });
  });
});

test('delegate tool: timeoutSec only lowers the run timeout; an invalid one is refused before any confirm prompt', async () => {
  await withSandbox({ templates: { 'claude/t': tpl('t', 'edit', 'timeout: 60') } }, async ({ cwd }) => {
    await withFakeBinaries(['claude'], [CLAUDE_RESULT], async () => {
      const { tools } = await loadExtension(async () => ({ stdout: '', stderr: '', code: 0 }));
      const run = async (timeoutSec: number) => {
        const res = (await tools
          .get('delegate')
          ?.execute('t', { harness: 'claude', mode: 't', task: 'x', timeoutSec }, undefined, undefined, {
            cwd,
            hasUI: false,
            isProjectTrusted: () => true,
          })) as { details: Record<string, unknown> };
        return res.details.timeoutMs;
      };
      assert.equal(await run(30), 30_000, 'lowers the template timeout');
      assert.equal(await run(600), 60_000, 'never raises it');
      const { ctx, asked } = uiCtx(cwd, true);
      await assert.rejects(
        () =>
          tools
            .get('delegate')
            ?.execute('t', { mode: 't', task: 'x', timeoutSec: 5, allowDangerous: true }, undefined, undefined, ctx) ??
          Promise.resolve(),
        /timeout must be a whole number of seconds/,
      );
      assert.equal(asked.length, 0, 'no confirm for a call that cannot run');
    });
  });
});

test('delegate tool: a model-set timeoutSec cannot raise a short per-harness config timeout (slot-hold guard)', async () => {
  await withSandbox(
    { settings: { harnesses: { claude: { timeoutMs: 30_000 } } }, templates: { 'claude/t': tpl('t', 'edit') } },
    async ({ cwd }) => {
      await withFakeBinaries(['claude'], [CLAUDE_RESULT], async () => {
        const { tools } = await loadExtension(async () => ({ stdout: '', stderr: '', code: 0 }));
        for (const tool of ['delegate', 'claude_delegate']) {
          const res = (await tools
            .get(tool)
            ?.execute('t', { harness: 'claude', mode: 't', task: 'x', timeoutSec: 7200 }, undefined, undefined, {
              cwd,
              hasUI: false,
              isProjectTrusted: () => true,
            })) as { details: Record<string, unknown> };
          assert.equal(res.details.timeoutMs, 30_000, tool);
        }
      });
    },
  );
});

test('delegate(): timeoutSecMayRaise is what lets a per-call timeout raise the configured one', async () => {
  await withSandbox(
    { settings: { harnesses: { claude: { timeoutMs: 30_000 } } }, templates: { 'claude/t': tpl('t', 'edit') } },
    async ({ cwd }) => {
      const { delegate } = await import('../extensions/engine.ts');
      await withFakeBinaries(['claude'], [CLAUDE_RESULT], async () => {
        const opts = { harness: 'claude', mode: 't', task: 'x', timeoutSec: 900 };
        const plain = await delegate(
          fakePi(async () => ({})),
          fakeCtx(cwd),
          opts,
        );
        assert.equal(plain.details.timeoutMs, 30_000, 'default: narrow only');
        const human = await delegate(
          fakePi(async () => ({})),
          fakeCtx(cwd),
          { ...opts, timeoutSecMayRaise: true },
        );
        assert.equal(human.details.timeoutMs, 900_000);
      });
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

// ── per-call timeout propagation through every path (the transcript records the timeout the run got) ──

const OUTPUTS = [CLAUDE_RESULT, ...CODEX_RESULT_LINES];

/** The `- timeout: Ns` line of a transcript file. */
function transcriptTimeout(file: unknown): string | undefined {
  return readFileSync(String(file), 'utf8').match(/^- timeout: (\d+s)$/m)?.[1];
}

/** Every transcript path named in an injected report (`transcript: <path>` / `_transcript: <path>_`). */
function reportTranscripts(content: string): string[] {
  return [...content.matchAll(/transcript: (\S+?\.md)/g)].map(m => m[1]);
}

test('transcript: records the harness timeout the run was given', async () => {
  await withSandbox({ templates: { 'claude/t': tpl('t', 'edit', 'timeout: 75') } }, async ({ cwd }) => {
    const { delegate } = await import('../extensions/engine.ts');
    await withFakeBinaries(['claude'], [CLAUDE_RESULT], async () => {
      const run = await delegate(
        fakePi(async () => ({})),
        fakeCtx(cwd),
        { harness: 'claude', mode: 't', task: 'x' },
      );
      assert.equal(transcriptTimeout(run.details.file), '75s');
    });
  });
});

test('delegate tool fan-out: timeoutSec reaches every row', async () => {
  await withSandbox({}, async ({ cwd }) => {
    await withFakeBinaries(['claude', 'codex'], OUTPUTS, async argsFile => {
      await withOnlyFakes(argsFile, async () => {
        const { tools } = await loadExtension(async () => ({ stdout: '', stderr: '', code: 0 }));
        const res = (await tools
          .get('delegate')
          ?.execute(
            't',
            { harness: 'claude,codex', mode: 'general', task: 'x', timeoutSec: 30 },
            undefined,
            undefined,
            {
              cwd,
              hasUI: false,
              isProjectTrusted: () => true,
            },
          )) as { details: { runs: { harness: string; ok: boolean; file?: string }[] } };
        assert.equal(res.details.runs.length, 2);
        for (const r of res.details.runs) {
          assert.ok(r.ok && r.file, JSON.stringify(r));
          assert.equal(transcriptTimeout(r.file), '30s', r.harness);
        }
      });
    });
  });
});

test('/delegate fan-out: a human --timeout reaches every row and may raise the configured timeout', async () => {
  await withSandbox({ settings: { timeoutMs: 30_000 } }, async ({ cwd }) => {
    const { takePendingReport } = await import('../extensions/engine.ts');
    await withFakeBinaries(['claude', 'codex'], OUTPUTS, async argsFile => {
      await withOnlyFakes(argsFile, async () => {
        const { commands } = await loadExtension(async () => ({ stdout: '', stderr: '', code: 0 }));
        const { ctx, notes } = uiCtx(cwd, true);
        await commands.get('delegate')?.handler('--harness=claude,codex --timeout=900 general do it', ctx);
        const report = takePendingReport();
        assert.ok(report, notes.join(' | '));
        const files = reportTranscripts(report.content);
        assert.equal(files.length, 2, report.content);
        for (const f of files) assert.equal(transcriptTimeout(f), '900s', f);
      });
    });
  });
});

test('/delegate single run: a human --timeout reaches the run and may raise the configured timeout', async () => {
  await withSandbox({ settings: { harnesses: { claude: { timeoutMs: 30_000 } } } }, async ({ cwd }) => {
    const { takePendingReport } = await import('../extensions/engine.ts');
    await withFakeBinaries(['claude'], [CLAUDE_RESULT], async () => {
      const { commands } = await loadExtension(async () => ({ stdout: '', stderr: '', code: 0 }));
      for (const [args, want] of [
        ['claude --timeout=900 general do it', '900s'],
        ['claude --timeout=12 general do it', '12s'],
      ] as const) {
        const { ctx, notes } = uiCtx(cwd, true);
        await commands.get('delegate')?.handler(args, ctx);
        const report = takePendingReport();
        assert.ok(report, notes.join(' | '));
        const [file] = reportTranscripts(report.content);
        assert.equal(transcriptTimeout(file), want, args);
      }
    });
  });
});
