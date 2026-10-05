/**
 * A confirmation must be fully on screen on the terminal it is shown on — measured with pi's own components in
 * BOTH of its layouts (regular: the document tail; fullscreen: the real VStack dock that clips the dialog's
 * bottom) and with the working status / footer rows at their worst. Covers: the real terminal width (rows are laid
 * out at it and prefixed, pi never re-wraps), the 40-column floor with its refusal naming the real size, an unknown
 * size being 80x24, and the ordinary danger requests that used to be refused at 80x24.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../extensions/config.ts';
import {
  currentViewport,
  DEFAULT_ROWS,
  dialogFrameRows,
  layoutConfirmation,
  MIN_COLUMNS,
  messageRowBudget,
  type Viewport,
} from '../extensions/confirm-layout.ts';
import { effectiveRunLines } from '../extensions/effective.ts';
import { HARNESS_NAMES } from '../extensions/harnesses/registry.ts';
import { confirmDangerousCommand, confirmDangerousToolCall, confirmToolAddDirs } from '../extensions/validate.ts';
import { renderDialog, unwrap, withViewport } from './helpers/dialog.ts';
import {
  type CapturedTool,
  CLAUDE_RESULT,
  fakeCtx,
  loadExtension,
  tpl,
  uiCtx,
  withFakeBinaries,
  withOnlyFakes,
  withSandbox,
} from './helpers/sandbox.ts';
import { type Chrome, COMMON_CHROME, SCREEN_MODES, type ScreenMode, screenOf, WORST_CHROME } from './helpers/screen.ts';

const TITLE = 'Allow dangerous delegation?';
const CHROMES: Chrome[] = [WORST_CHROME, COMMON_CHROME];

const capture = () => {
  const asked: string[] = [];
  const ctx = {
    hasUI: true,
    cwd: '/proj',
    ui: {
      confirm: async (_t: string, m: string) => {
        asked.push(m);
        return true;
      },
    },
  } as never;
  return { asked, ctx };
};

/** A screen as text with pi's 1-column padding off and the wrap points joined back — both ways, since a soft wrap drops a trailing space. */
function texts(rows: string[]): string[] {
  const body = rows.map(r => (r.startsWith(' ') ? r.slice(1) : r)).join('\n');
  return [unwrap(body), body.replace(/\n {2}┆ /g, ' ')];
}

/**
 * The whole message is on the real screen of a `vp` terminal in BOTH layouts and both chromes: every needle is
 * visible, so are Yes / No and the hint; every row we wrote fits (pi did not re-wrap: the dialog is exactly our
 * rows plus its 10); (continuation-row prefixes: `tests/confirm-layout.test.ts`).
 */
function assertOnScreen(message: string, vp: Viewport, needles: (string | RegExp)[], label: string): void {
  const d = renderDialog(TITLE, message, vp);
  assert.equal(
    d.all.length,
    message.split('\n').length + dialogFrameRows(vp.columns),
    `${label}: pi re-wrapped a row\n${d.all.join('\n')}`,
  );
  for (const r of d.all) assert.ok(Array.from(r).length <= vp.columns, `${label}: row wider than the terminal: ${r}`);
  for (const mode of SCREEN_MODES)
    for (const chrome of CHROMES) {
      const screen = screenOf(mode, TITLE, message, vp.columns, vp.rows, chrome);
      const where = `${label} ${mode} ${vp.columns}x${vp.rows} status=${chrome.status} footer=${chrome.footer}\n${screen.join('\n')}`;
      const [joined, spaced] = texts(screen);
      for (const n of needles)
        assert.ok(
          typeof n === 'string' ? joined.includes(n) || spaced.includes(n) : n.test(joined) || n.test(spaced),
          `${n} is not on screen: ${where}`,
        );
      for (const k of ['Yes', 'No', 'cancel', TITLE]) assert.ok(joined.includes(k), `${k} is not on screen: ${where}`);
    }
}

const eff = ['will apply (claude): model "opus", budget $5, timeout 600s, transport stdout'];
const TASK = 'Fix the flaky test in tests/runner.test.ts and make sure the whole suite passes afterwards.';

/** An ordinary model-set danger request: task, model, budget, a resumed session, a pr and an addDir. */
async function ordinary(vp: Viewport): Promise<{ message?: string; error?: string }> {
  const t = capture();
  try {
    await confirmDangerousToolCall(
      t.ctx,
      {
        harness: 'claude',
        mode: 'fix',
        task: TASK,
        model: 'opus',
        maxBudgetUsd: 5,
        sessionId: 'abc-123',
        pr: 'owner/repo#7',
        addDirs: ['./inside'],
      },
      { harnesses: ['claude'], mode: 'fix', effective: eff, viewport: vp },
    );
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  return { message: t.asked[0] };
}

for (const [columns, rows] of [
  [40, 30],
  [50, 30],
  [60, 24],
  [60, 30],
  [80, 24],
  [100, 30],
  [80, 40],
] as const)
  test(`an ordinary model-set danger request at ${columns}x${rows}: refused naming the real size, or fully on the real screen (both layouts)`, async () => {
    const vp = { columns, rows };
    const r = await ordinary(vp);
    if (r.error !== undefined) {
      assert.match(r.error, new RegExp(`${columns}x${rows}`), 'a refusal names the REAL terminal size');
      return;
    }
    assertOnScreen(
      r.message as string,
      vp,
      [
        'DANGER',
        'claude/fix',
        'session: resumes "abc-123"',
        'pr: "owner/repo#7"',
        'will apply (claude)',
        'addDirs (1): "./inside"',
        TASK,
        'task: 91 chars',
      ],
      'ordinary',
    );
  });

test('ordinary requests that fit at all are accepted from 50x30 and 60x24 up (the real width is used, not 80)', async () => {
  for (const [columns, rows] of [
    [50, 30],
    [60, 24],
    [80, 24],
  ] as const) {
    const r = await ordinary({ columns, rows });
    assert.equal(r.error, undefined, `${columns}x${rows}`);
  }
});

test('a task with 12 numbered lines at 50x30 and 60x24: every line is on screen in both layouts, or the call is refused naming the size', async () => {
  for (const [columns, rows] of [
    [50, 30],
    [60, 24],
    [40, 24],
  ] as const) {
    const vp = { columns, rows };
    for (let n = 1; n <= 14; n++) {
      const task = Array.from(
        { length: n },
        (_, i) => `L${i}: please refactor the module and keep behaviour ${i}`,
      ).join('\n');
      const t = capture();
      try {
        await confirmDangerousToolCall(
          t.ctx,
          { harness: 'claude', mode: 'fix', task },
          { harnesses: ['claude'], mode: 'fix', effective: eff, viewport: vp },
        );
      } catch (err) {
        assert.match(String(err), new RegExp(`${columns}x${rows}|at most \\d+ whole`), `${columns}x${rows} n=${n}`);
        continue;
      }
      assertOnScreen(
        t.asked[0],
        vp,
        ['DANGER', 'claude/fix', 'will apply', ...Array.from({ length: n }, (_, i) => `L${i}: please refactor`)],
        `${n} lines`,
      );
    }
  }
});

test('a terminal under 40 columns is refused with its REAL size (never laid out for 80), on every dialog', async () => {
  for (const [columns, rows] of [
    [39, 40],
    [20, 24],
    [1, 1],
  ] as const) {
    const vp = { columns, rows };
    const msg = new RegExp(`${columns}x${rows}.*at least ${MIN_COLUMNS} columns`);
    const t = capture();
    await assert.rejects(
      () => confirmDangerousToolCall(t.ctx, { harness: 'claude', mode: 'fix', task: 'x' }, { viewport: vp }),
      msg,
    );
    await assert.rejects(
      () => confirmDangerousCommand(t.ctx, { harnesses: ['claude'], mode: 'fix', task: 'x', viewport: vp }),
      msg,
    );
    assert.equal(t.asked.length, 0, 'nothing is shown');
    // the addDirs dialog reads the real terminal
    await withViewport(columns, rows, () =>
      assert.rejects(() => confirmToolAddDirs({ ...(t.ctx as object), cwd: '/proj' } as never, ['/outside']), msg),
    );
    const direct = layoutConfirmation({
      blocks: [],
      critical: ['x'],
      summaries: [],
      onOverflow: 'refuse',
      viewport: vp,
    });
    assert.equal(direct.ok, false);
  }
  // exactly 40 is shown: pi wraps its own hint row there (counted in the frame), and nothing of ours is re-wrapped
  const ok = layoutConfirmation({
    blocks: [{ label: 'Task', text: 'hi', limits: { full: 100, maxRows: 5 }, summaryLabel: 'task' }],
    critical: ['DANGER: x'],
    summaries: [],
    onOverflow: 'refuse',
    viewport: { columns: 40, rows: 30 },
  });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    const d = renderDialog(TITLE, ok.lines.join('\n'), { columns: 40, rows: 30 });
    assert.equal(d.all.length, ok.rows + dialogFrameRows(40));
    assert.ok(
      d.all.some(r => r.includes('cancel')),
      'the hint is on screen at 40 columns',
    );
  }
});

test('an unknown terminal size is 80x24: the row budget is the 24-row one and the whole dialog fits a real 24-row screen', async () => {
  await withViewport(undefined, undefined, async () => {
    assert.equal(currentViewport().rows, DEFAULT_ROWS);
    assert.equal(messageRowBudget(currentViewport()), 12);
    const t = capture();
    await confirmDangerousToolCall(t.ctx, { harness: 'claude', mode: 'fix', task: 'x' }, { effective: eff });
    assertOnScreen(t.asked[0], { columns: 80, rows: 24 }, ['DANGER', 'claude/fix', 'task: 1 chars'], 'unknown size');
    // a task that needed the 40 rows the old default assumed is refused now, not hidden on a 24-row screen
    const tall = Array.from({ length: 14 }, (_, i) => `line ${i}`).join('\n');
    await assert.rejects(
      () => confirmDangerousToolCall(t.ctx, { harness: 'claude', mode: 'fix', task: tall }, { effective: eff }),
      /refused/,
    );
  });
  for (const unknown of [undefined, 0, Number.NaN])
    await withViewport(unknown, unknown, () => assert.deepEqual(currentViewport(), { columns: 80, rows: 24 }));
});

test('capacity table: the largest model-set task (one-row lines) the minimal danger confirmation accepts, per terminal', async () => {
  const table: Record<string, number> = {};
  for (const [columns, rows] of [
    [80, 24],
    [80, 30],
    [100, 30],
    [80, 40],
  ] as const) {
    let n = 0;
    for (; n < 40; n++) {
      const task = Array.from({ length: n + 1 }, (_, i) => `L${i}`).join('\n');
      const t = capture();
      try {
        await confirmDangerousToolCall(
          t.ctx,
          { harness: 'claude', mode: 'fix', task },
          { harnesses: ['claude'], mode: 'fix', effective: eff, viewport: { columns, rows } },
        );
      } catch {
        break;
      }
    }
    table[`${columns}x${rows}`] = n;
  }
  assert.deepEqual(table, { '80x24': 7, '80x30': 13, '100x30': 13, '80x40': 20 });
});

// ── the three ordinary requests that used to be refused at 80x24 ─────────────────────────────────

test('repro: a tool call with a one-line task, model, budget and session is ACCEPTED at 80x24 with everything visible', async () => {
  await withSandbox({ templates: { 'claude/fix': tpl('fix', 'edit') } }, async ({ cwd }) => {
    await withFakeBinaries(['claude'], [CLAUDE_RESULT], async argsFile => {
      await withOnlyFakes(argsFile, async () => {
        await withViewport(80, 24, async () => {
          const { tools } = await loadExtension(async () => ({ stdout: '', stderr: '', code: 0 }));
          const u = uiCtx(cwd, false);
          await assert.rejects(
            () =>
              (tools.get('delegate') as CapturedTool).execute(
                't',
                {
                  harness: 'claude',
                  mode: 'fix',
                  task: TASK,
                  model: 'opus',
                  maxBudgetUsd: 5,
                  sessionId: 'abc-123',
                  allowDangerous: true,
                },
                undefined,
                undefined,
                u.ctx,
              ),
            /declined by the user/,
          );
          assert.equal(u.asked.length, 1, 'the dialog was shown (not refused)');
          assertOnScreen(
            u.asked[0],
            { columns: 80, rows: 24 },
            ['DANGER', 'claude/fix', 'session: resumes "abc-123"', 'model "opus"', 'budget $5', TASK],
            'tool',
          );
        });
      });
    });
  });
});

test('repro: /delegate claude fix --allow-dangerous --model=opus --budget=5 --verify="bun test" <task> is ACCEPTED at 80x24', async () => {
  await withSandbox({ templates: { 'claude/fix': tpl('fix', 'edit') } }, async ({ cwd }) => {
    await withFakeBinaries(['claude'], [CLAUDE_RESULT], async argsFile => {
      await withOnlyFakes(argsFile, async () => {
        await withViewport(80, 24, async () => {
          const { commands } = await loadExtension(async () => ({ stdout: '', stderr: '', code: 0 }));
          const u = uiCtx(cwd, false);
          await commands
            .get('delegate')
            ?.handler(
              'claude fix --allow-dangerous --model=opus --budget=5 --verify="bun test" fix the failing test',
              u.ctx,
            );
          assert.equal(u.asked.length, 1, `shown, not refused: ${u.notes.join(' | ')}`);
          assertOnScreen(
            u.asked[0],
            { columns: 80, rows: 24 },
            ['DANGER', 'claude/fix', 'model "opus"', 'budget $5', 'verify "bun test"', 'fix the failing test'],
            'command',
          );
        });
      });
    });
  });
});

test('repro: a 5-harness fan-out with a 4-word task is ACCEPTED at 80x24 (one shared will-apply row, differences per member)', async () => {
  await withSandbox({}, async ({ cwd }) => {
    await withViewport(80, 24, async () => {
      const t = capture();
      const effective = effectiveRunLines(fakeCtx(cwd), loadConfig(), HARNESS_NAMES, 'implement', {
        allowDangerous: true,
      });
      await confirmDangerousCommand(t.ctx, {
        harnesses: [...HARNESS_NAMES],
        mode: 'implement',
        task: 'fix the failing test',
        effective,
      });
      assert.equal(t.asked.length, 1);
      assertOnScreen(
        t.asked[0],
        { columns: 80, rows: 24 },
        ['DANGER', ...HARNESS_NAMES, 'will apply (all 5)', 'fix the failing test'],
        'fan-out',
      );
      assert.equal(effective[0], 'will apply (all 5): budget none, timeout 600s, transport stdout');
      assert.equal(effective.length, 6, effective.join('\n'));
      assert.match(effective[5], /^will apply \(devin\): model harness default, transport acp$/);
      assert.ok(
        effective.slice(1, 5).every(l => !/transport/.test(l)),
        'a member repeats only what differs',
      );
    });
  });
});
