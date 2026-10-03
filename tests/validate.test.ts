import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addDirError,
  addDirsOutsideCwd,
  confirmDangerousToolCall,
  confirmToolAddDirs,
  modelError,
  prError,
  sessionIdError,
  validateDelegateInputs,
} from '../extensions/validate.ts';

test('sessionIdError: accepts real-world session ids from every harness', () => {
  for (const id of [
    '01a052bb-0000-0000-0000-000000000001', // codex/claude UUID
    'ses_3f2a9c1b7ffeAbC', // opencode
    'sess.abc:01', // generic
    'a'.repeat(128),
  ])
    assert.equal(sessionIdError(id), null, id);
});

test('sessionIdError: rejects flag-shaped, empty, oversized, and odd-character ids', () => {
  for (const id of ['', '-x', '--dangerously-bypass', 'a b', 'a/b', 'a;b', 'a'.repeat(129), 'x\ny'])
    assert.ok(sessionIdError(id), JSON.stringify(id));
});

test('modelError: rejects leading dash and control characters, accepts normal names', () => {
  for (const m of ['sonnet', 'claude-opus-4', 'gpt-5.1-codex', 'openai/gpt-5', 'anthropic/claude-sonnet-4@latest'])
    assert.equal(modelError(m), null, m);
  for (const m of ['', '-m', '--yolo', 'a\nb']) assert.ok(modelError(m), JSON.stringify(m));
});

test('prError: number, http(s) URL, or owner/repo#n only', () => {
  for (const pr of [
    '42',
    'https://github.com/o/r/pull/42',
    'http://ghe.local/o/r/pull/7',
    'yorch/pi-harness-delegate#12',
  ])
    assert.equal(prError(pr), null, pr);
  for (const pr of ['-1', '--repo=evil/x', 'file:///etc/passwd', 'some-branch', 'o/r', '42; rm', ''])
    assert.ok(prError(pr), JSON.stringify(pr));
});

test('addDirError: rejects flag-shaped and empty entries', () => {
  assert.equal(addDirError('/abs/dir'), null);
  assert.equal(addDirError('../rel'), null);
  assert.ok(addDirError('-x'));
  assert.ok(addDirError(''));
});

test('validateDelegateInputs: throws the first problem, passes clean input through', () => {
  assert.doesNotThrow(() => validateDelegateInputs({}));
  assert.doesNotThrow(() => validateDelegateInputs({ sessionId: 'abc-1', model: 'opus', pr: '9' }));
  assert.throws(() => validateDelegateInputs({ sessionId: '--x' }), /invalid sessionId/);
  assert.throws(() => validateDelegateInputs({ model: '-o' }), /invalid model/);
  assert.throws(() => validateDelegateInputs({ pr: '--repo=x' }), /invalid pr/);
  assert.throws(() => validateDelegateInputs({ addDirs: ['/ok', '-bad'] }), /invalid addDirs/);
});

test('confirmDangerousToolCall: fails closed with no UI', async () => {
  await assert.rejects(
    () => confirmDangerousToolCall({ hasUI: false }, { harness: 'claude', mode: 'implement', task: 't' }),
    /no interactive UI/,
  );
});

test('confirmDangerousToolCall: asks the human and honors a decline', async () => {
  let asked = '';
  const ctx = {
    hasUI: true,
    ui: {
      confirm: async (_title: string, message: string) => {
        asked = message;
        return false;
      },
    },
  };
  await assert.rejects(() => confirmDangerousToolCall(ctx as never, { harness: 'codex', task: 'wipe it' }), /declined/);
  assert.match(asked, /codex/);
  assert.match(asked, /wipe it/);
});

test('confirmDangerousToolCall: resolves on approval; a throwing dialog counts as a decline', async () => {
  await confirmDangerousToolCall({ hasUI: true, ui: { confirm: async () => true } } as never, { task: 't' });
  await assert.rejects(
    () =>
      confirmDangerousToolCall(
        {
          hasUI: true,
          ui: {
            confirm: async () => {
              throw new Error('ui gone');
            },
          },
        } as never,
        { task: 't' },
      ),
    /declined/,
  );
});

test('addDirsOutsideCwd: inside paths pass; .., absolute, and symlink escapes are caught', async () => {
  const { mkdirSync, mkdtempSync, rmSync, symlinkSync, realpathSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'adddirs-')));
  const cwd = join(root, 'repo');
  const outside = join(root, 'outside');
  mkdirSync(join(cwd, 'sub'), { recursive: true });
  mkdirSync(outside);
  symlinkSync(outside, join(cwd, 'link'));
  try {
    assert.deepEqual(addDirsOutsideCwd(cwd, undefined), []);
    assert.deepEqual(addDirsOutsideCwd(cwd, ['sub', '.', join(cwd, 'sub'), 'not-yet/created', '..foo']), []);
    assert.deepEqual(addDirsOutsideCwd(cwd, ['../outside']), [outside]);
    assert.deepEqual(addDirsOutsideCwd(cwd, ['sub/../../outside']), [outside]);
    assert.deepEqual(addDirsOutsideCwd(cwd, ['/etc']), [realpathSync('/etc')]);
    // a symlink inside the repo pointing out of it — and a not-yet-existing path beneath it
    assert.deepEqual(addDirsOutsideCwd(cwd, ['link', 'link/new']), [outside, join(outside, 'new')]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('confirmToolAddDirs: inside cwd needs no UI; outside fails closed without one, asks with one', async () => {
  const cwd = process.cwd();
  await confirmToolAddDirs({ cwd, hasUI: false }, ['tests', './extensions']);
  await assert.rejects(() => confirmToolAddDirs({ cwd, hasUI: false }, ['/']), /no interactive UI/);
  let asked = 0;
  const ui = (answer: boolean | 'throw') => ({
    cwd,
    hasUI: true,
    ui: {
      confirm: async () => {
        asked++;
        if (answer === 'throw') throw new Error('x');
        return answer;
      },
    },
  });
  await assert.rejects(() => confirmToolAddDirs(ui(false) as never, ['/']), /declined/);
  await assert.rejects(() => confirmToolAddDirs(ui('throw') as never, ['/']), /declined/);
  await confirmToolAddDirs(ui(true) as never, ['/']);
  assert.equal(asked, 3);
});
