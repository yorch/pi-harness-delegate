import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFanoutReport } from '../extensions/activity.ts';
import { delegate } from '../extensions/engine.ts';
import { describeIgnoredRecords, historyLine } from '../extensions/history.ts';
import type { HistoryEntry } from '../extensions/history-filter.ts';
import {
  addDirError,
  confirmDangerousCommand,
  confirmDangerousToolCall,
  confirmToolAddDirs,
  modelError,
  prError,
  sessionIdError,
} from '../extensions/validate.ts';
import { fakeCtx, fakePi, withSandbox } from './helpers/sandbox.ts';
import { EVIL, UNSAFE } from './helpers/unsafe.ts';

const clean = (label: string, s: string) => assert.ok(!UNSAFE.test(s), `${label}: ${JSON.stringify(s)}`);
/** An `assert.rejects` validator: the rejection's message must be clean. */
const cleanErr = (label: string) => (e: Error) => {
  clean(label, e.message);
  return true;
};

test('confirm dialogs and refusals never carry a raw escape/bidi/zero-width character (tool + command + addDirs)', async () => {
  const asked: string[] = [];
  const ui = {
    hasUI: true,
    ui: {
      confirm: async (t: string, m: string) => {
        asked.push(t, m);
        return false;
      },
    },
  };
  const headless = { hasUI: false } as never;
  await assert.rejects(
    () => confirmDangerousToolCall(ui as never, { harness: EVIL, mode: EVIL, task: EVIL }),
    cleanErr('tool declined'),
  );
  await assert.rejects(
    () => confirmDangerousToolCall(headless, { harness: EVIL, mode: EVIL, task: EVIL }),
    cleanErr('tool headless'),
  );
  await assert.rejects(
    () => confirmDangerousCommand(ui as never, { harnesses: [EVIL, 'codex'], mode: EVIL, task: EVIL }),
    cleanErr('command declined'),
  );
  await assert.rejects(
    () => confirmDangerousCommand(headless, { harnesses: [EVIL], mode: EVIL, task: EVIL }),
    cleanErr('command headless'),
  );
  // addDirs outside cwd, with a hostile directory name
  const uiDirs = { ...ui, cwd: '/tmp/proj' };
  await assert.rejects(
    () => confirmToolAddDirs(uiDirs as never, [`/outside/${EVIL}`], 'record'),
    cleanErr('addDirs declined'),
  );
  await assert.rejects(
    () => confirmToolAddDirs({ hasUI: false, cwd: '/tmp/proj' } as never, [`/outside/${EVIL}`]),
    cleanErr('addDirs headless'),
  );
  assert.ok(asked.length >= 6);
  for (const a of asked) clean('dialog text', a);
  // the escaped form is still informative
  assert.ok(asked.some(a => a.includes('\\u001b')));
});

test('argv validators echo a rejected value escaped, never raw', () => {
  const bad = `-${EVIL}`;
  for (const msg of [sessionIdError(bad), modelError(bad), prError(bad), addDirError('')])
    clean('validator', msg ?? '');
  for (const msg of [sessionIdError(EVIL), modelError(`${EVIL}\n`), prError(EVIL)]) clean('validator', msg ?? '');
});

test('delegate(): an unknown mode / harness / missing task never echoes raw escape or bidi text', async () => {
  await withSandbox({}, async ({ cwd }) => {
    const pi = fakePi(async () => ({ code: 0, stdout: '', stderr: '' }));
    for (const opts of [
      { harness: 'claude', mode: EVIL, task: 'x' },
      { harness: EVIL, mode: 'review', task: 'x' },
    ]) {
      await assert.rejects(
        () => delegate(pi, fakeCtx(cwd), opts),
        (e: Error) => {
          clean('engine error', e.message);
          return /unknown (delegate mode|harness)/.test(e.message);
        },
      );
    }
  });
});

test('history rows and the ignored-records note sanitize everything that came from a record or transcript header', () => {
  const entry: HistoryEntry = {
    file: '/x/a.md',
    mode: EVIL,
    harness: EVIL,
    cost: null,
    sessionId: EVIL,
    mtime: 1,
    isError: false,
    startedMs: 1,
    runId: null,
    fanoutId: null,
    hasRecord: false,
    recordProblem: `record says harness ${EVIL}`,
  };
  clean('historyLine', historyLine(entry));
  const note = describeIgnoredRecords([entry]);
  assert.match(note, /1 run record\(s\) ignored/);
  clean('ignored note', note);
});

test('the fan-out report lists skipped/unknown/unreadable names sanitized', () => {
  const body = buildFanoutReport({
    runs: [],
    skipped: [EVIL],
    unknown: [EVIL],
    noSession: [EVIL],
    unreadable: [EVIL],
  });
  clean('fan-out report', body);
  assert.match(body, /unreadable run record, not resumed/);
});
