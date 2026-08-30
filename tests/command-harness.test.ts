import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isFanoutSpec, parseDelegateCommand, resolveHarnessFilter, resolveHarnessList } from '../extensions/command.ts';

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

test('parseDelegateCommand recognizes "all" as a harness spec first word', () => {
  const r = parseDelegateCommand('all review the auth flow', MODES, HARNESSES);
  assert.equal(r.harness, 'all');
  assert.equal(r.mode, 'review');
  assert.equal(r.task, 'the auth flow');
});

test('parseDelegateCommand recognizes a comma-separated harness list as first word', () => {
  const r = parseDelegateCommand('claude,codex plan the migration', MODES, HARNESSES);
  assert.equal(r.harness, 'claude,codex');
  assert.equal(r.mode, 'plan');
});

test('parseDelegateCommand --verify flag with a quoted multi-word command', () => {
  const r = parseDelegateCommand('--mode=implement --verify="bun test" do the thing', MODES, HARNESSES);
  assert.equal(r.verify, 'bun test');
  assert.equal(r.task, 'do the thing');
});

test('parseDelegateCommand --verify flag without quotes (single word)', () => {
  const r = parseDelegateCommand('--verify=lint implement it', MODES, HARNESSES);
  assert.equal(r.verify, 'lint');
});

test('isFanoutSpec recognizes "all" and comma lists, rejects a single harness', () => {
  assert.equal(isFanoutSpec('all'), true);
  assert.equal(isFanoutSpec('claude,codex'), true);
  assert.equal(isFanoutSpec('claude'), false);
  assert.equal(isFanoutSpec(undefined), false);
});

test('resolveHarnessList "all" resolves to detected harnesses only, in known order', () => {
  const r = resolveHarnessList('all', {
    knownHarnesses: ['claude', 'codex', 'opencode', 'amp'],
    aliasOf: name => (name === 'omp' ? 'amp' : name),
    isKnown: name => ['claude', 'codex', 'opencode', 'amp'].includes(name),
    detection: { claude: { ok: true }, codex: { ok: false }, opencode: { ok: true }, amp: { ok: false } },
  });
  assert.deepEqual(r.resolved, ['claude', 'opencode']);
  assert.deepEqual(r.skipped, ['codex', 'amp']);
  assert.deepEqual(r.unknown, []);
});

test('resolveHarnessList comma list resolves aliases and dedupes', () => {
  const r = resolveHarnessList('omp,claude,amp', {
    knownHarnesses: ['claude', 'codex', 'opencode', 'amp'],
    aliasOf: name => (name === 'omp' ? 'amp' : name),
    isKnown: name => ['claude', 'codex', 'opencode', 'amp', 'omp'].includes(name),
    detection: { claude: { ok: true }, amp: { ok: true } },
  });
  assert.deepEqual(r.resolved, ['amp', 'claude']);
  assert.deepEqual(r.unknown, []);
  assert.deepEqual(r.skipped, []);
});

test('resolveHarnessList reports unknown harness names without failing the rest', () => {
  const r = resolveHarnessList('claude,bogus', {
    knownHarnesses: ['claude', 'codex', 'opencode', 'amp'],
    aliasOf: name => name,
    isKnown: name => ['claude', 'codex', 'opencode', 'amp'].includes(name),
    detection: { claude: { ok: true } },
  });
  assert.deepEqual(r.resolved, ['claude']);
  assert.deepEqual(r.unknown, ['bogus']);
  assert.deepEqual(r.skipped, []);
});

test('resolveHarnessList reports uninstalled harnesses as skipped, not failed', () => {
  const r = resolveHarnessList('claude,codex', {
    knownHarnesses: ['claude', 'codex', 'opencode', 'amp'],
    aliasOf: name => name,
    isKnown: name => ['claude', 'codex', 'opencode', 'amp'].includes(name),
    detection: { claude: { ok: true }, codex: { ok: false } },
  });
  assert.deepEqual(r.resolved, ['claude']);
  assert.deepEqual(r.skipped, ['codex']);
  assert.deepEqual(r.unknown, []);
});

const filterOpts = {
  isKnown: (name: string) => ['claude', 'codex', 'opencode', 'amp', 'omp'].includes(name),
  aliasOf: (name: string) => (name === 'omp' ? 'amp' : name),
};

test('resolveHarnessFilter: no word given -> no filter', () => {
  assert.deepEqual(resolveHarnessFilter(undefined, filterOpts), { kind: 'none' });
});

test('resolveHarnessFilter: a known harness resolves to itself', () => {
  assert.deepEqual(resolveHarnessFilter('claude', filterOpts), { kind: 'known', harness: 'claude' });
});

test('resolveHarnessFilter: an alias resolves to its canonical name', () => {
  assert.deepEqual(resolveHarnessFilter('omp', filterOpts), { kind: 'known', harness: 'amp' });
});

test('resolveHarnessFilter: is case-insensitive for both known names and aliases', () => {
  assert.deepEqual(resolveHarnessFilter('CLAUDE', filterOpts), { kind: 'known', harness: 'claude' });
  assert.deepEqual(resolveHarnessFilter('OMP', filterOpts), { kind: 'known', harness: 'amp' });
});

test('resolveHarnessFilter: an unrecognized word is reported, not silently dropped', () => {
  assert.deepEqual(resolveHarnessFilter('bogus', filterOpts), { kind: 'unknown', requested: 'bogus' });
});

test('resolveHarnessFilter: against the real registry, list and history-style lookups agree on omp -> amp', async () => {
  const { isKnownHarness, resolveHarnessName } = await import('../extensions/harnesses/registry.ts');
  const real = { isKnown: isKnownHarness, aliasOf: resolveHarnessName };
  assert.deepEqual(resolveHarnessFilter('omp', real), { kind: 'known', harness: 'amp' });
  assert.deepEqual(resolveHarnessFilter('OMP', real), { kind: 'known', harness: 'amp' });
  assert.deepEqual(resolveHarnessFilter('amp', real), { kind: 'known', harness: 'amp' });
  assert.deepEqual(resolveHarnessFilter('not-a-harness', real), { kind: 'unknown', requested: 'not-a-harness' });
});
