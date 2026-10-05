import assert from 'node:assert/strict';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { outputsDir } from '../extensions/config.ts';
import { readAllHistory } from '../extensions/history.ts';
import {
  applyHistoryFilter,
  describeHistoryFilter,
  type HistoryEntry,
  parseHistoryArgs,
  parseSince,
} from '../extensions/history-filter.ts';
import { buildRunRecord, newRunId, writeRunRecord } from '../extensions/run-record.ts';
import { fakeCtx, loadExtension, withSandbox } from './helpers/sandbox.ts';

const NOW = Date.parse('2026-10-05T12:00:00Z');
const known = (w: string) =>
  ['claude', 'codex', 'amp'].includes(w.toLowerCase()) ? w.toLowerCase() : w === 'omp' ? 'amp' : null;

test('parseSince: durations, dates and ISO datetimes; everything else is an error', () => {
  assert.deepEqual(parseSince('2h', NOW), { ms: NOW - 2 * 3_600_000 });
  assert.deepEqual(parseSince('3d', NOW), { ms: NOW - 3 * 86_400_000 });
  assert.deepEqual(parseSince('90m', NOW), { ms: NOW - 90 * 60_000 });
  assert.deepEqual(parseSince('2026-10-01T09:30:00Z', NOW), { ms: Date.parse('2026-10-01T09:30:00Z') });
  const day = parseSince('2026-10-01', NOW);
  assert.ok('ms' in day && new Date(day.ms).getDate() === 1);
  for (const bad of [
    '',
    '0h',
    '2',
    'h',
    '2x',
    '-3d',
    '2026-02-31',
    '2026-13-01',
    '2026-10-01T99:99:00Z',
    'yesterday',
    '1e3h',
    '9999999d',
  ]) {
    assert.ok('error' in parseSince(bad, NOW), bad);
  }
});

test('parseHistoryArgs: every flag, bare harness word, aliases', () => {
  const { filter, errors } = parseHistoryArgs('omp --failed --since=2h --limit=5 --mode=review', NOW, known);
  assert.deepEqual(errors, []);
  assert.deepEqual(filter, {
    harness: 'amp',
    failed: true,
    sinceMs: NOW - 7_200_000,
    sinceText: '2h',
    limit: 5,
    mode: 'review',
  });
  assert.equal(parseHistoryArgs('--harness=Codex --ok', NOW, known).filter.harness, 'codex');
  assert.deepEqual(parseHistoryArgs('', NOW, known), { filter: {}, errors: [] });
});

test('parseHistoryArgs: invalid values are errors, never silently dropped', () => {
  const bad = (raw: string) => parseHistoryArgs(raw, NOW, known).errors.join(' | ');
  assert.match(bad('--limit=0'), /--limit must be/);
  assert.match(bad('--limit=abc'), /--limit must be/);
  assert.match(bad('--limit=100000'), /--limit must be/);
  assert.match(bad('--limit'), /--limit must be/);
  assert.match(bad('--since=yesterday'), /--since must be/);
  assert.match(bad('--since'), /--since must be/);
  assert.match(bad('--mode='), /--mode must be/);
  assert.match(bad('--mode=a b'), /unknown harness/);
  assert.match(bad('--mode=../x'), /--mode must be/);
  assert.match(bad('--failed --ok'), /mutually exclusive/);
  assert.match(bad('--failed=yes'), /takes no value/);
  assert.match(bad('--bogus'), /unknown option --bogus/);
  assert.match(bad('nonesuch'), /unknown harness/);
  assert.match(bad('claude codex'), /unexpected argument/);
  assert.match(bad('--harness=zzz'), /unknown harness/);
});

const entry = (over: Partial<HistoryEntry>): HistoryEntry => ({
  file: '/f',
  mode: 'review',
  harness: 'claude',
  cost: null,
  sessionId: null,
  mtime: NOW,
  isError: false,
  startedMs: NOW,
  runId: null,
  fanoutId: null,
  hasRecord: false,
  ...over,
});

test('applyHistoryFilter: failed/ok/since/mode/harness/limit, newest first; unknown status matches neither', () => {
  const entries = [
    entry({ file: 'a', mtime: 5, startedMs: NOW - 1000, isError: true }),
    entry({ file: 'b', mtime: 4, startedMs: NOW - 10 * 3_600_000, harness: 'codex', mode: 'plan' }),
    entry({ file: 'c', mtime: 6, startedMs: NOW - 2000, isError: null }),
    entry({ file: 'd', mtime: 3, startedMs: NOW - 3000, isError: false, mode: 'Review' }),
  ];
  const files = (f: Parameters<typeof applyHistoryFilter>[1]) => applyHistoryFilter(entries, f).map(e => e.file);
  assert.deepEqual(files({}), ['c', 'a', 'b', 'd']);
  assert.deepEqual(files({ failed: true }), ['a']);
  assert.deepEqual(files({ ok: true }), ['b', 'd']);
  assert.deepEqual(files({ sinceMs: NOW - 3_600_000 }), ['c', 'a', 'd']);
  assert.deepEqual(files({ mode: 'review' }), ['c', 'a', 'd']);
  assert.deepEqual(files({ harness: 'codex' }), ['b']);
  assert.deepEqual(files({ limit: 2 }), ['c', 'a']);
  assert.deepEqual(files({ ok: true, limit: 1, mode: 'review' }), ['d']);
  assert.equal(describeHistoryFilter({ harness: 'claude', failed: true, limit: 3 }), 'claude, failed, limit 3');
  assert.equal(describeHistoryFilter({}), '');
});

test('readAllHistory: sidecar-backed and legacy transcripts (and a corrupt sidecar) all list without crashing', async () => {
  await withSandbox({}, async () => {
    const dir = outputsDir('claude');
    mkdirSync(dir, { recursive: true });
    const mk = (name: string, text: string, t: number) => {
      writeFileSync(join(dir, name), text);
      utimesSync(join(dir, name), t, t);
    };
    // 1: with a record (failed)
    mk('1-review.md', '# Delegated Claude run — review\n', 20_000);
    writeRunRecord(
      join(dir, '1-review.md'),
      buildRunRecord({
        runId: newRunId(),
        harness: 'claude',
        mode: 'review',
        permission: 'readonly',
        nativeClass: 'none',
        model: null,
        sessionId: 'abc',
        resumed: false,
        startedAtMs: 5_000_000,
        endedAtMs: 5_001_000,
        durationMs: 1000,
        isError: true,
        stopReason: null,
        timeoutMs: null,
        numTurns: null,
        totalCostUsd: null,
        usage: null,
        transcriptFile: '1-review.md',
        cwd: '/p',
        task: 't',
        hadVerify: false,
      }),
    );
    // 2: legacy transcript, errored, no sidecar
    mk(
      '2-plan.md',
      '# Delegated Claude run — plan\n\n- harness: claude\n- turns: 1 · cost: $0.5000 · isError: true\n',
      12_000,
    );
    // 3: legacy ok
    mk('3-docs.md', '# Delegated Claude run — docs\n\n- turns: 1 · cost: n/a · isError: false\n', 13_000);
    // 4: corrupt sidecar falls back to the header
    mk('4-general.md', '# Delegated Claude run — general\n\n- turns: 1 · cost: n/a · isError: false\n', 14_000);
    writeFileSync(join(dir, '4-general.json'), '{garbage');
    const all = readAllHistory();
    assert.deepEqual(
      all.map(e => e.mode),
      ['review', 'general', 'docs', 'plan'],
    );
    assert.deepEqual(
      applyHistoryFilter(all, { failed: true }).map(e => e.mode),
      ['review', 'plan'],
    );
    assert.deepEqual(
      applyHistoryFilter(all, { ok: true }).map(e => e.mode),
      ['general', 'docs'],
    );
    const rec = all.find(e => e.mode === 'review');
    assert.ok(rec?.hasRecord && rec.runId);
    assert.equal(all.find(e => e.mode === 'plan')?.cost, 0.5);
    assert.equal(all.find(e => e.mode === 'plan')?.hasRecord, false);
    // --since uses the record's startedAt (1970), not the file mtime (20000s)
    assert.deepEqual(
      applyHistoryFilter(all, { sinceMs: 6_000_000 }).map(e => e.mode),
      ['general', 'docs', 'plan'],
    );
  });
});

test('/delegate history: an invalid filter prints the error and lists nothing; a valid one lists filtered rows', async () => {
  await withSandbox({}, async ({ cwd }) => {
    const dir = outputsDir('claude');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '1-plan.md'), '# Delegated Claude run — plan\n\n- turns: 1 · cost: n/a · isError: true\n');
    writeFileSync(join(dir, '2-docs.md'), '# Delegated Claude run — docs\n\n- turns: 1 · cost: n/a · isError: false\n');
    const { commands } = await loadExtension();
    const out: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string) => {
      out.push(String(s));
      return true;
    }) as typeof process.stdout.write;
    try {
      await commands.get('delegate')?.handler('history --limit=zero', fakeCtx(cwd));
      const err = out.join('');
      assert.match(err, /--limit must be/);
      assert.match(err, /Usage: \/delegate history/);
      assert.ok(!/plan|docs · /.test(err.replace(/Usage[^\n]*/g, '')), 'nothing listed');
      out.length = 0;
      await commands.get('delegate')?.handler('history --failed', fakeCtx(cwd));
      const ok = out.join('');
      assert.match(ok, /history \(failed\)/);
      assert.match(ok, /claude plan · failed/);
      assert.ok(!ok.includes('docs'));
    } finally {
      process.stdout.write = orig;
    }
  });
});
