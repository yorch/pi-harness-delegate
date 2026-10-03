import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseClaudeCommand, resolveDefaults } from '../extensions/command.ts';
import { parseTemplate } from '../extensions/templates.ts';

const MODES = new Set(['review', 'plan', 'implement', 'security-audit', 'docs', 'general']);

function mustParse(s: string) {
  const t = parseTemplate(s);
  if (!t) throw new Error('failed to parse template fixture');
  return t;
}
const TEMPLATES = new Map([
  ['review', mustParse('---\nname: review\ndefaultTask: Review the git diff\ndefaultScope: diff\n---\nbody')],
  ['security-audit', mustParse('---\nname: security-audit\ndefaultTask: Audit the repo\n---\nbody')],
  ['plan', mustParse('---\nname: plan\n---\nbody')],
]);

test('bare mode name as first word', () => {
  assert.deepEqual(parseClaudeCommand('review the auth flow', MODES), {
    task: 'the auth flow',
    mode: 'review',
  });
});

test('bare mode alone yields empty task', () => {
  const r = parseClaudeCommand('review', MODES);
  assert.equal(r.mode, 'review');
  assert.equal(r.task, '');
});

test('explicit --mode wins over first word', () => {
  assert.equal(parseClaudeCommand('--mode=plan write a plan', MODES).mode, 'plan');
  assert.equal(parseClaudeCommand('--mode=plan review', MODES).mode, 'plan');
});

test('non-mode first word stays in the task', () => {
  const r = parseClaudeCommand('help me fix a bug', MODES);
  assert.equal(r.mode, undefined);
  assert.equal(r.task, 'help me fix a bug');
});

test('flags parse with defaults', () => {
  assert.deepEqual(parseClaudeCommand('--mode=security-audit --scope=auth/ --model=opus --budget=3 audit it', MODES), {
    task: 'audit it',
    mode: 'security-audit',
    model: 'opus',
    scope: 'auth/',
    budget: 3,
  });
});

test('--pr and --resume flags parse', () => {
  const r = parseClaudeCommand('--mode=review --pr=42 --resume=abc-123 review it', MODES);
  assert.equal(r.mode, 'review');
  assert.equal(r.pr, '42');
  assert.equal(r.sessionId, 'abc-123');
});

test('empty input', () => {
  assert.deepEqual(parseClaudeCommand('', MODES), { task: '' });
});

test('resolveDefaults applies template defaults for bare modes', () => {
  assert.deepEqual(resolveDefaults({ task: '', mode: 'review' }, TEMPLATES), {
    task: 'Review the git diff',
    scope: 'diff',
  });
  assert.deepEqual(resolveDefaults({ task: '', mode: 'security-audit' }, TEMPLATES), {
    task: 'Audit the repo',
  });
});

test('resolveDefaults returns null when a mode needs a prompt', () => {
  assert.equal(resolveDefaults({ task: '', mode: 'plan' }, TEMPLATES), null);
  assert.equal(resolveDefaults({ task: '' }, TEMPLATES), null);
});

test('resolveDefaults passes through an explicit prompt', () => {
  assert.deepEqual(resolveDefaults({ task: 'review the auth flow', mode: 'review' }, TEMPLATES), {
    task: 'review the auth flow',
  });
});

test('explicit scope wins over the template default', () => {
  assert.deepEqual(resolveDefaults({ task: '', mode: 'review', scope: 'auth/' }, TEMPLATES), {
    task: 'Review the git diff',
    scope: 'auth/',
  });
});

test('--add-dir is repeatable and keeps quoted values intact', () => {
  const r = parseClaudeCommand('--mode=review --add-dir=../shared --add-dir="/opt/my lib" review it', MODES);
  assert.deepEqual(r.addDirs, ['../shared', '/opt/my lib']);
  assert.equal(r.task, 'review it');
  assert.equal(parseClaudeCommand('review it', MODES).addDirs, undefined);
});

test('--allow-dangerous: bare flag and =true set it, without leaking into the task', () => {
  for (const raw of [
    '--allow-dangerous claude implement wire it up',
    'claude implement --allow-dangerous wire it up',
    'claude implement wire it up --allow-dangerous',
    'claude implement --allow-dangerous=true wire it up',
    'claude implement --allow-dangerous=TRUE wire it up',
  ]) {
    const r = parseClaudeCommand(raw, MODES);
    assert.equal(r.allowDangerous, true, raw);
    assert.equal(r.harness, 'claude', raw);
    assert.equal(r.mode, 'implement', raw);
    assert.equal(r.task, 'wire it up', raw);
  }
});

test('--allow-dangerous: absent, =false, or any other value leaves it off (and out of the task)', () => {
  for (const raw of [
    'implement wire it up',
    'implement --allow-dangerous=false wire it up',
    'implement --allow-dangerous=yes wire it up',
    'implement --allow-dangerous=1 wire it up',
  ]) {
    const r = parseClaudeCommand(raw, MODES);
    assert.equal(r.allowDangerous, undefined, raw);
    assert.equal(r.task, 'wire it up', raw);
  }
});

test('--allow-dangerous: only a standalone token counts — not inside a quoted flag value or a longer word', () => {
  const quoted = parseClaudeCommand('implement --verify="echo --allow-dangerous" go', MODES);
  assert.equal(quoted.allowDangerous, undefined);
  assert.equal(quoted.verify, 'echo --allow-dangerous');
  const longer = parseClaudeCommand('implement --allow-dangerously go', MODES);
  assert.equal(longer.allowDangerous, undefined);
});
