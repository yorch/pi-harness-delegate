import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDelegateCommand } from '../extensions/command.ts';

const MODES = new Set(['review', 'plan', 'implement', 'general']);
const HARNESSES = new Set(['claude', 'codex', 'opencode', 'amp', 'omp']);

test('parseDelegateCommand harness as first word', () => {
  const r = parseDelegateCommand('codex review the auth flow', MODES, HARNESSES);
  assert.equal(r.harness, 'codex');
  assert.equal(r.mode, 'review');
  assert.equal(r.task, 'the auth flow');
});

test('parseDelegateCommand harness via --harness flag', () => {
  const r = parseDelegateCommand('--harness=codex --mode=plan do stuff', MODES, HARNESSES);
  assert.equal(r.harness, 'codex');
  assert.equal(r.mode, 'plan');
});

test('parseDelegateCommand omp alias maps to amp', () => {
  const r = parseDelegateCommand('omp review it', MODES, HARNESSES);
  assert.equal(r.harness, 'amp');
});

test('parseDelegateCommand without harness keeps mode', () => {
  const r = parseDelegateCommand('review the diff', MODES, HARNESSES);
  assert.equal(r.harness, undefined);
  assert.equal(r.mode, 'review');
});

test('parseDelegateCommand harness and mode explicit flags', () => {
  const r = parseDelegateCommand('--harness=opencode --mode=review audit it', MODES, HARNESSES);
  assert.equal(r.harness, 'opencode');
  assert.equal(r.mode, 'review');
});
