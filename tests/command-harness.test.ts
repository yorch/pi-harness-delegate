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

test('fanoutResumeError: a session id cannot be resumed across a fan-out', async () => {
  const { fanoutResumeError } = await import('../extensions/command.ts');
  assert.equal(fanoutResumeError('claude', 'abc'), null);
  assert.equal(fanoutResumeError('all', undefined), null);
  assert.match(fanoutResumeError('all', 'abc') ?? '', /cannot resume session "abc" across a fan-out/);
  assert.match(fanoutResumeError('claude,codex', 'abc') ?? '', /single harness|one harness/);
});

test('parseDelegateCommand --harness= is lowercased and alias-normalized like the first-word form', () => {
  assert.equal(parseDelegateCommand('--harness=omp review it', MODES, HARNESSES).harness, 'amp');
  assert.equal(parseDelegateCommand('--harness=OMP review it', MODES, HARNESSES).harness, 'amp');
  assert.equal(parseDelegateCommand('--harness=Codex review it', MODES, HARNESSES).harness, 'codex');
  assert.equal(parseDelegateCommand('OMP review it', MODES, HARNESSES).harness, 'amp');
});

test('parseDelegateCommand trailing/stray commas in a harness list are dropped', () => {
  // `claude,` is just claude — a single harness, not a one-element fan-out
  for (const raw of ['claude, review it', '--harness=claude, review it', '--harness=,claude review it']) {
    const r = parseDelegateCommand(raw, MODES, HARNESSES);
    assert.equal(r.harness, 'claude', raw);
    assert.equal(isFanoutSpec(r.harness), false, raw);
    assert.equal(r.mode, 'review', raw);
    assert.equal(r.task, 'it', raw);
  }
  assert.equal(parseDelegateCommand('claude,,codex, plan x', MODES, HARNESSES).harness, 'claude,codex');
  assert.equal(parseDelegateCommand('omp, plan x', MODES, HARNESSES).harness, 'amp');
  // a bare `,` is no harness at all, and stays prose
  const comma = parseDelegateCommand(', plan x', MODES, HARNESSES);
  assert.equal(comma.harness, undefined);
  assert.equal(parseDelegateCommand('--harness=, plan x', MODES, HARNESSES).harness, undefined);
});

test('parseDelegateCommand --budget that is 0, negative, NaN or empty is reported, not silently ignored', () => {
  for (const v of ['0', '-1', 'abc', 'NaN', 'Infinity', '""']) {
    const r = parseDelegateCommand(`--budget=${v} review it`, MODES, HARNESSES);
    assert.equal(r.budget, undefined, v);
    assert.equal(r.errors?.length, 1, v);
    assert.match(r.errors?.[0] ?? '', /--budget must be a positive number/, v);
  }
  const ok = parseDelegateCommand('--budget=0.5 review it', MODES, HARNESSES);
  assert.equal(ok.budget, 0.5);
  assert.equal(ok.errors, undefined);
});

test('parseDelegateCommand leaves --k=v inside quoted or backticked prose alone', () => {
  const bt = parseDelegateCommand('review explain what `--mode=plan` and `--allow-dangerous` do', MODES, HARNESSES);
  assert.equal(bt.mode, 'review');
  assert.equal(bt.allowDangerous, undefined);
  assert.equal(bt.task, 'explain what `--mode=plan` and `--allow-dangerous` do');
  const dq = parseDelegateCommand('review why does "--budget=0" crash --model=opus', MODES, HARNESSES);
  assert.equal(dq.task, 'why does "--budget=0" crash');
  assert.equal(dq.budget, undefined);
  assert.equal(dq.errors, undefined);
  assert.equal(dq.model, 'opus');
  // a flag glued to a preceding word isn't a flag either
  assert.equal(parseDelegateCommand('review fix foo--model=x', MODES, HARNESSES).model, undefined);
  // an unknown bare --word is prose, kept as-is
  assert.equal(parseDelegateCommand('review add a --dry-run option', MODES, HARNESSES).task, 'add a --dry-run option');
});
