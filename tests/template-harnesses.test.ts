import assert from 'node:assert/strict';
import { test } from 'node:test';
import { templateHarnessDefault } from '../extensions/command.ts';
import { parseTemplate, parseTemplateHarnesses } from '../extensions/templates.ts';
import { unwrap } from './helpers/dialog.ts';
import {
  CLAUDE_RESULT,
  CODEX_RESULT_LINES,
  loadExtension,
  readArgs,
  tpl,
  uiCtx,
  withFakeBinaries,
  withOnlyFakes,
  withSandbox,
} from './helpers/sandbox.ts';

const OUTPUT = [CLAUDE_RESULT, ...CODEX_RESULT_LINES];

/** A delegated run (not a `--version` detection probe) reached this fake binary. */
function ran(argsFile: string, name: string): boolean {
  const argv = readArgs(`${argsFile}.${name}`);
  return argv !== null && !(argv.length === 1 && argv[0] === '--version');
}

test('parseTemplateHarnesses: lowercased, deduped; `all` and non-name entries are dropped with a warning', () => {
  assert.deepEqual(parseTemplateHarnesses(undefined), { harnesses: undefined, warnings: [] });
  assert.deepEqual(parseTemplateHarnesses('Codex, claude,codex , '), { harnesses: ['codex', 'claude'], warnings: [] });
  // unknown-but-well-formed names are kept — the run-time fan-out reporting names them
  assert.deepEqual(parseTemplateHarnesses('nope').harnesses, ['nope']);
  const r = parseTemplateHarnesses('all, claude, --yolo, a b, \u001b[31mx');
  assert.deepEqual(r.harnesses, ['claude']);
  assert.equal(r.warnings.length, 4);
  assert.match(r.warnings[0], /"all" ignored — name the harnesses explicitly/);
  assert.match(r.warnings[1], /entry "--yolo" ignored/);
  assert.ok(r.warnings.every(w => !w.includes('\u001b')));
  const t = parseTemplate(tpl('fan', 'readonly', 'harnesses: all'));
  assert.equal(t?.harnesses, undefined);
  assert.equal(t?.permission, 'readonly', 'a harnesses: problem never touches the tier');
  assert.match(t?.fieldWarnings?.[0] ?? '', /"all" ignored/);
});

test('templateHarnessDefault: the whole list as a normalized spec — one name single, several a fan-out', () => {
  assert.equal(templateHarnessDefault(undefined), undefined);
  assert.equal(templateHarnessDefault([]), undefined);
  assert.equal(templateHarnessDefault(['codex', 'claude']), 'codex,claude');
  assert.equal(templateHarnessDefault(['omp']), 'amp');
  assert.equal(templateHarnessDefault(['nope', 'omp', 'claude']), 'nope,omp,claude'); // aliases resolved by resolveHarnessList
});

test('/delegate: a template harnesses list fans out when no harness is given, reporting unknown/uninstalled', async () => {
  await withSandbox(
    { templates: { fan: tpl('fan', 'readonly', 'harnesses: claude, codex, amp, nope') } },
    async ({ cwd }) => {
      const { takePendingReport } = await import('../extensions/engine.ts');
      await withFakeBinaries(['claude', 'codex'], OUTPUT, async argsFile => {
        await withOnlyFakes(argsFile, async () => {
          const { commands } = await loadExtension(async () => ({ stdout: '', stderr: '', code: 0 }));
          const { ctx } = uiCtx(cwd, true);
          await commands.get('delegate')?.handler('fan check things', ctx);
          assert.ok(ran(argsFile, 'claude'));
          assert.ok(ran(argsFile, 'codex'));
          const report = takePendingReport();
          assert.ok(report);
          assert.match(report.content, /2\/2 ok/);
          assert.match(report.content, /nope/, 'unknown name reported');
          assert.match(report.content, /amp/, 'uninstalled harness reported as skipped');
        });
      });
    },
  );
});

test('/delegate: an explicit harness (flag, first word, alias command) ignores the template default', async () => {
  await withSandbox({ templates: { fan: tpl('fan', 'readonly', 'harnesses: codex, claude') } }, async ({ cwd }) => {
    await withFakeBinaries(['claude', 'codex'], OUTPUT, async argsFile => {
      const { rmSync } = await import('node:fs');
      const { commands } = await loadExtension(async () => ({ stdout: '', stderr: '', code: 0 }));
      for (const [cmd, args] of [
        ['delegate', 'claude fan check'],
        ['delegate', '--harness=claude fan check'],
        ['claude', 'fan check'],
      ] as const) {
        rmSync(`${argsFile}.claude`, { force: true });
        rmSync(`${argsFile}.codex`, { force: true });
        const { ctx, notes } = uiCtx(cwd, true);
        await commands.get(cmd)?.handler(args, ctx);
        assert.ok(ran(argsFile, 'claude'), `${cmd} ${args}: ${notes.join(' | ')}`);
        assert.equal(readArgs(`${argsFile}.codex`), null, `${cmd} ${args}: codex never probed or run`);
      }
    });
  });
});

test('/delegate: a template fan-out keeps the --allow-dangerous gate — one confirm naming every harness, headless refused', async () => {
  await withSandbox({ templates: { fan: tpl('fan', 'edit', 'harnesses: claude, codex') } }, async ({ cwd }) => {
    await withFakeBinaries(['claude', 'codex'], OUTPUT, async argsFile => {
      await withOnlyFakes(argsFile, async () => {
        const { commands } = await loadExtension(async () => ({ stdout: '', stderr: '', code: 0 }));
        const declined = uiCtx(cwd, false);
        await commands.get('delegate')?.handler('fan --allow-dangerous do it', declined.ctx);
        assert.equal(declined.asked.length, 1);
        assert.match(declined.asked[0], /all 2 harnesses \(claude, codex\)/);
        assert.ok(!ran(argsFile, 'claude') && !ran(argsFile, 'codex'), 'a decline runs nothing');

        const errs: string[] = [];
        const orig = process.stderr.write.bind(process.stderr);
        process.stderr.write = ((c: string | Uint8Array) => {
          errs.push(String(c));
          return true;
        }) as typeof process.stderr.write;
        try {
          await commands
            .get('delegate')
            ?.handler('fan --allow-dangerous do it', { cwd, hasUI: false, isProjectTrusted: () => true });
        } finally {
          process.stderr.write = orig;
        }
        assert.match(errs.join(''), /needs interactive confirmation, but there is no UI/);
        assert.ok(!ran(argsFile, 'claude') && !ran(argsFile, 'codex'), 'headless runs nothing');

        const approved = uiCtx(cwd, true);
        await commands.get('delegate')?.handler('fan --allow-dangerous do it', approved.ctx);
        assert.equal(approved.asked.length, 1, 'one confirm covers the whole template fan-out');
        assert.ok(readArgs(`${argsFile}.claude`)?.includes('bypassPermissions'));
        assert.ok(readArgs(`${argsFile}.codex`)?.includes('danger-full-access'));
      });
    });
  });
});

test('/delegate: --resume with a template fan-out default is rejected, never resumed across harnesses', async () => {
  await withSandbox({ templates: { fan: tpl('fan', 'readonly', 'harnesses: claude, codex') } }, async ({ cwd }) => {
    await withFakeBinaries(['claude', 'codex'], OUTPUT, async argsFile => {
      const { commands } = await loadExtension(async () => ({ stdout: '', stderr: '', code: 0 }));
      const { ctx, notes } = uiCtx(cwd, true);
      await commands.get('delegate')?.handler('fan --resume=abc continue', ctx);
      assert.ok(
        notes.some(n => /across a fan-out/.test(n)),
        notes.join(' | '),
      );
      assert.equal(readArgs(`${argsFile}.claude`), null);
      assert.equal(readArgs(`${argsFile}.codex`), null);
    });
  });
});

const headless = (cwd: string) => ({ cwd, hasUI: false, isProjectTrusted: () => true });

test('delegate tool: a template harnesses list fans out through runFanoutTool, reporting unknown/uninstalled', async () => {
  await withSandbox(
    { templates: { fan: tpl('fan', 'readonly', 'harnesses: nope, codex, claude, amp') } },
    async ({ cwd }) => {
      await withFakeBinaries(['claude', 'codex'], OUTPUT, async argsFile => {
        await withOnlyFakes(argsFile, async () => {
          const { tools } = await loadExtension(async () => ({ stdout: '', stderr: '', code: 0 }));
          const res = (await tools
            .get('delegate')
            ?.execute('t', { mode: 'fan', task: 'x' }, undefined, undefined, headless(cwd))) as {
            content: { text: string }[];
            details: Record<string, unknown>;
          };
          assert.ok(ran(argsFile, 'codex'));
          assert.ok(ran(argsFile, 'claude'));
          assert.equal(res.details.fanout, true);
          assert.deepEqual(res.details.harnesses, ['codex', 'claude']);
          assert.deepEqual(res.details.unknown, ['nope']);
          assert.deepEqual(res.details.skipped, ['amp']);
          assert.match(res.content[0].text, /2\/2 ok/);
        });
      });
    },
  );
});

test('delegate tool: a one-harness template default is a plain single run on that harness', async () => {
  await withSandbox({ templates: { one: tpl('one', 'readonly', 'harnesses: codex') } }, async ({ cwd }) => {
    await withFakeBinaries(['claude', 'codex'], OUTPUT, async argsFile => {
      const { tools } = await loadExtension(async () => ({ stdout: '', stderr: '', code: 0 }));
      const res = (await tools
        .get('delegate')
        ?.execute('t', { mode: 'one', task: 'x' }, undefined, undefined, headless(cwd))) as {
        details: Record<string, unknown>;
      };
      assert.ok(ran(argsFile, 'codex'));
      assert.equal(readArgs(`${argsFile}.claude`), null, 'claude neither probed nor run');
      assert.equal(res.details.harness, 'codex');
      assert.equal(res.details.fanout, undefined);
    });
  });
});

test('delegate tool: the allowDangerous confirm names every template harness; decline / headless run nothing', async () => {
  await withSandbox({ templates: { fan: tpl('fan', 'edit', 'harnesses: claude, codex') } }, async ({ cwd }) => {
    await withFakeBinaries(['claude', 'codex'], OUTPUT, async argsFile => {
      await withOnlyFakes(argsFile, async () => {
        const { tools } = await loadExtension(async () => ({ stdout: '', stderr: '', code: 0 }));
        const params = { mode: 'fan', task: 'x', allowDangerous: true };
        const declined = uiCtx(cwd, false);
        await assert.rejects(
          () => tools.get('delegate')?.execute('t', params, undefined, undefined, declined.ctx) ?? Promise.resolve(),
          /declined/,
        );
        assert.equal(declined.asked.length, 1);
        assert.match(unwrap(declined.asked[0]), /run claude,codex fan with DANGER/);
        await assert.rejects(
          () => tools.get('delegate')?.execute('t', params, undefined, undefined, headless(cwd)) ?? Promise.resolve(),
          /no interactive UI to confirm it with/,
        );
        assert.equal(readArgs(`${argsFile}.claude`), null, 'nothing probed or run');
        assert.equal(readArgs(`${argsFile}.codex`), null, 'nothing probed or run');

        const approved = uiCtx(cwd, true);
        await tools.get('delegate')?.execute('t', params, undefined, undefined, approved.ctx);
        assert.equal(approved.asked.length, 1, 'one confirm covers the whole template fan-out');
        assert.ok(readArgs(`${argsFile}.claude`)?.includes('bypassPermissions'));
        assert.ok(readArgs(`${argsFile}.codex`)?.includes('danger-full-access'));
      });
    });
  });
});

test('delegate tool: addDirs outside cwd on a template fan-out is gated once — headless refuses before anything runs', async () => {
  await withSandbox({ templates: { fan: tpl('fan', 'readonly', 'harnesses: claude, codex') } }, async ({ cwd }) => {
    await withFakeBinaries(['claude', 'codex'], OUTPUT, async argsFile => {
      await withOnlyFakes(argsFile, async () => {
        const { tools } = await loadExtension(async () => ({ stdout: '', stderr: '', code: 0 }));
        await assert.rejects(
          () =>
            tools
              .get('delegate')
              ?.execute('t', { mode: 'fan', task: 'x', addDirs: ['/'] }, undefined, undefined, headless(cwd)) ??
            Promise.resolve(),
          /addDirs outside the working directory requested/,
        );
        assert.equal(readArgs(`${argsFile}.claude`), null);
        assert.equal(readArgs(`${argsFile}.codex`), null);
      });
    });
  });
});

test('delegate tool: sessionId with a template fan-out default is rejected, never resumed across harnesses', async () => {
  await withSandbox({ templates: { fan: tpl('fan', 'readonly', 'harnesses: claude, codex') } }, async ({ cwd }) => {
    await withFakeBinaries(['claude', 'codex'], OUTPUT, async argsFile => {
      const { tools } = await loadExtension(async () => ({ stdout: '', stderr: '', code: 0 }));
      await assert.rejects(
        () =>
          tools
            .get('delegate')
            ?.execute('t', { mode: 'fan', task: 'x', sessionId: 'abc' }, undefined, undefined, headless(cwd)) ??
          Promise.resolve(),
        /across a fan-out/,
      );
      assert.equal(readArgs(`${argsFile}.claude`), null);
      assert.equal(readArgs(`${argsFile}.codex`), null);
    });
  });
});

test('delegate tool: a single template harness still fails fast at capacity; a template fan-out queues for slots', async () => {
  await withSandbox(
    {
      settings: { maxConcurrent: 1 },
      templates: {
        one: tpl('one', 'readonly', 'harnesses: claude'),
        fan: tpl('fan', 'readonly', 'harnesses: claude, codex'),
      },
    },
    async ({ cwd }) => {
      const { acquireSlot } = await import('../extensions/concurrency.ts');
      const { loadConfig } = await import('../extensions/config.ts');
      await withFakeBinaries(['claude', 'codex'], OUTPUT, async argsFile => {
        await withOnlyFakes(argsFile, async () => {
          const { tools } = await loadExtension(async () => ({ stdout: '', stderr: '', code: 0 }));
          const release = await acquireSlot({ harness: 'claude', mode: 'held', config: loadConfig(), wait: false });
          let released = false;
          try {
            for (const params of [
              { harness: 'claude', mode: 'one', task: 'x' },
              { mode: 'one', task: 'x' },
            ]) {
              const signal = AbortSignal.timeout(2000);
              await assert.rejects(
                () =>
                  tools.get('delegate')?.execute('t', params, signal, undefined, headless(cwd)) ?? Promise.resolve(),
                /already in progress|claimed the last available slot/,
              );
              assert.equal(signal.aborted, false, `${JSON.stringify(params)}: rejected immediately, not queued`);
            }
            // the fan-out waits for the held slot instead of failing, then runs both (one at a time)
            const fan = tools
              .get('delegate')
              ?.execute('t', { mode: 'fan', task: 'x' }, undefined, undefined, headless(cwd));
            await new Promise(r => setTimeout(r, 400));
            assert.ok(!ran(argsFile, 'claude') && !ran(argsFile, 'codex'), 'queued behind the held slot');
            release();
            released = true;
            const res = (await fan) as { details: Record<string, unknown>; content: { text: string }[] };
            assert.equal(res.details.fanout, true);
            assert.match(res.content[0].text, /2\/2 ok/);
          } finally {
            if (!released) release();
          }
        });
      });
    },
  );
});

test('an untrusted project template cannot pick the harness — its harnesses: is never read', async () => {
  // the project overrides the builtin `review` to default to codex; untrusted, the builtin runs on claude
  await withSandbox({ templates: { review: tpl('review', 'readonly', 'harnesses: codex') } }, async ({ cwd }) => {
    await withFakeBinaries(['claude', 'codex'], OUTPUT, async argsFile => {
      const { rmSync } = await import('node:fs');
      const { tools, commands } = await loadExtension(async () => ({ stdout: '', stderr: '', code: 0 }));
      await tools.get('delegate')?.execute('t', { mode: 'review', task: 'x' }, undefined, undefined, {
        cwd,
        hasUI: false,
        isProjectTrusted: () => false,
      });
      assert.ok(ran(argsFile, 'claude'));
      assert.equal(readArgs(`${argsFile}.codex`), null);
      rmSync(`${argsFile}.claude`, { force: true });
      const { ctx } = uiCtx(cwd, true, false);
      await commands.get('delegate')?.handler('review look', ctx);
      assert.ok(ran(argsFile, 'claude'));
      assert.equal(readArgs(`${argsFile}.codex`), null);
      // trusted, the same template does pick codex
      await tools.get('delegate')?.execute('t', { mode: 'review', task: 'x' }, undefined, undefined, {
        cwd,
        hasUI: false,
        isProjectTrusted: () => true,
      });
      assert.ok(ran(argsFile, 'codex'));
    });
  });
});

/** The `delegate_modes` block for one mode (from its `- mode:` line up to the next blank line). */
async function modesBlock(cwd: string, mode: string, trusted = true): Promise<string> {
  const { tools } = await loadExtension();
  const res = (await tools
    .get('delegate_modes')
    ?.execute('t', {}, undefined, undefined, { cwd, hasUI: false, isProjectTrusted: () => trusted })) as {
    content: { text: string }[];
  };
  const text = res.content[0].text;
  const start = text.indexOf(`- mode: ${JSON.stringify(mode)}`);
  assert.ok(start >= 0, text);
  const end = text.indexOf('\n\n', start);
  return text.slice(start, end < 0 ? undefined : end);
}

test('a mode kept only in another harness partition: its harnesses: picks the harness (tool, command, delegate_modes agree)', async () => {
  await withSandbox(
    { userTemplates: { 'codex/onlycodex': tpl('onlycodex', 'readonly', 'harnesses: codex') } },
    async ({ cwd }) => {
      await withFakeBinaries(['claude', 'codex'], OUTPUT, async argsFile => {
        const { rmSync } = await import('node:fs');
        assert.match(await modesBlock(cwd, 'onlycodex'), /default harness when none given: codex\b/);
        const { tools, commands } = await loadExtension(async () => ({ stdout: '', stderr: '', code: 0 }));
        const res = (await tools
          .get('delegate')
          ?.execute('t', { mode: 'onlycodex', task: 'x' }, undefined, undefined, headless(cwd))) as {
          details: Record<string, unknown>;
        };
        assert.equal(res.details.harness, 'codex');
        assert.ok(ran(argsFile, 'codex'));
        assert.equal(readArgs(`${argsFile}.claude`), null, 'claude neither probed nor run');
        rmSync(`${argsFile}.codex`, { force: true });
        const { ctx, notes } = uiCtx(cwd, true);
        await commands.get('delegate')?.handler('onlycodex check things', ctx);
        assert.ok(ran(argsFile, 'codex'), notes.join(' | '));
        assert.equal(readArgs(`${argsFile}.claude`), null);
        // an explicit harness still wins — the mode doesn't exist there, so it fails as before
        await assert.rejects(
          () =>
            tools
              .get('delegate')
              ?.execute(
                't',
                { harness: 'claude', mode: 'onlycodex', task: 'x' },
                undefined,
                undefined,
                headless(cwd),
              ) ?? Promise.resolve(),
          /unknown delegate mode "onlycodex" for harness "claude"/,
        );
      });
    },
  );
});

test('harness-partition defaults: the default harness copy alone decides; other copies never mix in', async () => {
  await withSandbox(
    {
      userTemplates: {
        // the default harness (claude) has its own copy without harnesses: — it runs on claude, the
        // codex copy's harnesses: is never consulted
        'claude/both': tpl('both', 'readonly'),
        'codex/both': tpl('both', 'readonly', 'harnesses: codex'),
        // only in other partitions: the first copy (registry order) declaring harnesses: decides,
        // a copy without one is skipped, and the lists are never merged
        'codex/split': tpl('split', 'readonly'),
        'opencode/split': tpl('split', 'readonly', 'harnesses: opencode'),
        'amp/split': tpl('split', 'readonly', 'harnesses: codex, amp'),
        // no copy anywhere declares harnesses:
        'codex/bare': tpl('bare', 'readonly'),
      },
    },
    async ({ cwd }) => {
      const { templateForHarnessDefault, templateViews } = await import('../extensions/modes.ts');
      const view = templateViews(cwd, true);
      assert.equal(templateForHarnessDefault(view, 'claude', 'both')?.harnesses, undefined);
      assert.deepEqual(templateForHarnessDefault(view, 'claude', 'split')?.harnesses, ['opencode']);
      assert.equal(templateForHarnessDefault(view, 'claude', 'bare'), undefined);
      // a different default harness sees its own copy
      assert.deepEqual(templateForHarnessDefault(view, 'codex', 'both')?.harnesses, ['codex']);
      const both = await modesBlock(cwd, 'both');
      assert.doesNotMatch(both, /default harness when none given/);
      assert.match(await modesBlock(cwd, 'split'), /default harness when none given: opencode\b/);
      assert.match(
        await modesBlock(cwd, 'bare'),
        /default harness when none given: none — not available on claude, pass harness/,
      );
      await withFakeBinaries(['claude', 'codex'], OUTPUT, async argsFile => {
        const { tools } = await loadExtension(async () => ({ stdout: '', stderr: '', code: 0 }));
        const res = (await tools
          .get('delegate')
          ?.execute('t', { mode: 'both', task: 'x' }, undefined, undefined, headless(cwd))) as {
          details: Record<string, unknown>;
        };
        assert.equal(res.details.harness, 'claude');
        assert.equal(readArgs(`${argsFile}.codex`), null);
      });
    },
  );
});

test('an untrusted project harness-partition copy never picks the harness', async () => {
  await withSandbox(
    { templates: { 'codex/onlycodex': tpl('onlycodex', 'readonly', 'harnesses: codex') } },
    async ({ cwd }) => {
      const { templateForHarnessDefault, templateViews } = await import('../extensions/modes.ts');
      assert.equal(templateForHarnessDefault(templateViews(cwd, false), 'claude', 'onlycodex'), undefined);
      assert.deepEqual(templateForHarnessDefault(templateViews(cwd, true), 'claude', 'onlycodex')?.harnesses, [
        'codex',
      ]);
      await withFakeBinaries(['claude', 'codex'], OUTPUT, async argsFile => {
        const { tools } = await loadExtension(async () => ({ stdout: '', stderr: '', code: 0 }));
        await assert.rejects(
          () =>
            tools.get('delegate')?.execute('t', { mode: 'onlycodex', task: 'x' }, undefined, undefined, {
              cwd,
              hasUI: false,
              isProjectTrusted: () => false,
            }) ?? Promise.resolve(),
          /unknown delegate mode "onlycodex" for harness "claude"/,
        );
        assert.equal(readArgs(`${argsFile}.codex`), null);
      });
    },
  );
});

test('harness-partition fan-out default keeps the single allowDangerous confirm naming every harness', async () => {
  await withSandbox(
    { userTemplates: { 'codex/pfan': tpl('pfan', 'edit', 'harnesses: codex, claude') } },
    async ({ cwd }) => {
      await withFakeBinaries(['claude', 'codex'], OUTPUT, async argsFile => {
        await withOnlyFakes(argsFile, async () => {
          const { tools } = await loadExtension(async () => ({ stdout: '', stderr: '', code: 0 }));
          const declined = uiCtx(cwd, false);
          await assert.rejects(
            () =>
              tools
                .get('delegate')
                ?.execute('t', { mode: 'pfan', task: 'x', allowDangerous: true }, undefined, undefined, declined.ctx) ??
              Promise.resolve(),
            /declined/,
          );
          assert.equal(declined.asked.length, 1);
          assert.match(unwrap(declined.asked[0]), /run codex,claude pfan with DANGER/);
          assert.ok(!ran(argsFile, 'claude') && !ran(argsFile, 'codex'));
        });
      });
    },
  );
});
