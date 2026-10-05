import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  lutimesSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { pruneOutputs, SIDECAR_TMP_MAX_AGE_MS, writeTranscript } from '../extensions/activity.ts';
import { outputsDir } from '../extensions/config.ts';
import { FUTURE_SKEW_MS, newestFirst } from '../extensions/recency.ts';
import {
  buildRunRecord,
  displayText,
  isFanoutId,
  isRunId,
  loadRecordForTranscript,
  MAX_SIDECARS_SCANNED,
  newFanoutId,
  newRunId,
  parseRunRecord,
  RECORD_LIMITS,
  RECORD_MAX_BYTES,
  type RunRecordSource,
  readRecordsIn,
  readRunRecord,
  recordPathFor,
  writeRunRecord,
} from '../extensions/run-record.ts';
import { CLAUDE_RESULT, fakeCtx, fakePi, tpl, withFakeBinaries, withSandbox } from './helpers/sandbox.ts';
import { UNSAFE } from './helpers/unsafe.ts';

const baseSource = (): RunRecordSource => ({
  runId: newRunId(),
  harness: 'claude',
  mode: 'review',
  permission: 'readonly',
  nativeClass: 'none',
  model: null,
  sessionId: null,
  resumed: false,
  startedAtMs: 1_700_000_000_000,
  endedAtMs: 1_700_000_005_000,
  durationMs: 5000,
  isError: false,
  stopReason: null,
  timeoutMs: 1000,
  numTurns: null,
  totalCostUsd: null,
  usage: null,
  transcriptFile: '/x/y/2026-review.md',
  cwd: '/proj',
  task: 'look',
  hadVerify: false,
});
const GOOD = () => buildRunRecord(baseSource());

test('ids: random, URL-safe, never start with a dash, and the formats are disjoint', () => {
  const a = newRunId();
  const f = newFanoutId();
  assert.ok(isRunId(a) && !isFanoutId(a));
  assert.ok(isFanoutId(f) && !isRunId(f));
  assert.notEqual(newRunId(), a);
  assert.ok(!isFanoutId('fan_zz') && !isRunId('run_'));
});

test('parseRunRecord: round-trips a built record and tolerates garbage without throwing', () => {
  const rec = GOOD();
  const parsed = parseRunRecord(JSON.stringify(rec));
  assert.ok(parsed.ok);
  if (parsed.ok) assert.deepEqual(parsed.record, rec);
  assert.equal(rec.transcript, '2026-review.md', 'basename only');
  for (const text of ['', '{', 'null', '[]', '"x"', '{"version":2}', '{"version":1}']) {
    const r = parseRunRecord(text);
    assert.equal(r.ok, false, text);
  }
  const r = parseRunRecord('{"version":99}');
  assert.match(r.ok ? '' : r.reason, /unsupported record version/);
});

test('parseRunRecord: rejects wrong types, oversized values and path-like transcripts; drops unknown keys', () => {
  const rec = GOOD() as unknown as Record<string, unknown>;
  const mutate = (patch: (r: Record<string, unknown>) => void) => {
    const copy = JSON.parse(JSON.stringify(rec));
    patch(copy);
    return parseRunRecord(JSON.stringify(copy));
  };
  assert.equal(mutate(r => (r.harness = 7)).ok, false);
  assert.equal(mutate(r => (r.runId = '../../etc')).ok, false);
  assert.equal(mutate(r => (r.totalCostUsd = '0')).ok, false);
  assert.equal(mutate(r => (r.transcript = '../escape.md')).ok, false);
  assert.equal(mutate(r => (r.permission = 'yolo')).ok, false);
  assert.equal(mutate(r => ((r.input as Record<string, unknown>).task = 'x'.repeat(RECORD_LIMITS.task + 1))).ok, false);
  assert.equal(mutate(r => ((r.input as Record<string, unknown>).addDirs = 'nope')).ok, false);
  assert.equal(mutate(r => (r.startedAt = 'not a date')).ok, false);
  const extra = mutate(r => {
    r.allowDangerous = true;
    r.verify = 'rm -rf /';
    (r.input as Record<string, unknown>).verify = 'rm -rf /';
  });
  assert.ok(extra.ok);
  if (extra.ok) {
    assert.equal('allowDangerous' in extra.record, false);
    assert.equal('verify' in extra.record, false);
    assert.equal('verify' in extra.record.input, false);
  }
});

test('buildRunRecord: caps task/scope and flags truncation; displayText strips escapes', () => {
  const rec = buildRunRecord({
    ...baseSource(),
    task: 'a'.repeat(30_000),
    scope: 's'.repeat(9000),
  });
  assert.equal(rec.input.task.length, RECORD_LIMITS.task);
  assert.equal(rec.input.taskTruncated, true);
  assert.equal(rec.input.scope?.length, RECORD_LIMITS.scope);
  assert.equal(displayText('hi\u001b[31mred\u001b[0m\u202e\u0000 there'), 'hired there');
});

test('delegate: every run writes a 0600 sidecar next to its transcript with unmeasured metrics as null', async () => {
  await withSandbox(
    { templates: { 'claude/tinker': tpl('tinker', 'edit', 'verify: echo SECRET_VERIFY_CMD') } },
    async ({ cwd }) => {
      const { delegate } = await import('../extensions/engine.ts');
      await withFakeBinaries(
        ['claude'],
        [JSON.stringify({ type: 'result', result: 'fine', session_id: 'sess-9' })],
        async () => {
          const run = await delegate(
            fakePi(async () => ({ code: 0, stdout: '', stderr: '' })),
            fakeCtx(cwd),
            {
              harness: 'claude',
              mode: 'tinker',
              task: 'do it',
              scope: 'src/a.ts',
              addDirs: ['../x'],
              fanoutId: 'fan_0123456789abcdef',
            },
          );
          const transcript = run.details.file as string;
          const sidecar = recordPathFor(transcript);
          assert.ok(existsSync(sidecar));
          assert.equal(statSync(sidecar).mode & 0o777, 0o600);
          const raw = readFileSync(sidecar, 'utf8');
          assert.ok(!raw.includes('SECRET_VERIFY_CMD'), 'verify command text must never be stored');
          assert.ok(!/allowDangerous/i.test(raw));
          const parsed = parseRunRecord(raw);
          assert.ok(parsed.ok);
          if (!parsed.ok) return;
          const r = parsed.record;
          assert.equal(r.runId, run.details.runId);
          assert.equal(r.fanoutId, 'fan_0123456789abcdef');
          assert.equal(r.harness, 'claude');
          assert.equal(r.mode, 'tinker');
          assert.equal(r.permission, 'edit');
          assert.equal(r.sessionId, 'sess-9');
          assert.equal(r.resumed, false);
          assert.equal(r.isError, false);
          assert.equal(r.totalCostUsd, null);
          assert.equal(r.numTurns, null);
          assert.equal(r.cwd, cwd);
          assert.equal(r.transcript, transcript.split('/').pop());
          assert.deepEqual(r.input, {
            task: 'do it',
            taskTruncated: false,
            scope: 'src/a.ts',
            scopeTruncated: false,
            pr: null,
            addDirs: ['../x'],
            model: null,
            budgetUsd: null,
            timeoutSec: null,
            hadVerify: true,
          });
        },
      );
    },
  );
});

test('delegate: a danger escalation is recorded as permission danger but allowDangerous is never stored', async () => {
  await withSandbox({ templates: { 'claude/tinker': tpl('tinker', 'edit') } }, async ({ cwd }) => {
    const { delegate } = await import('../extensions/engine.ts');
    await withFakeBinaries(['claude'], [CLAUDE_RESULT], async () => {
      const run = await delegate(
        fakePi(async () => ({})),
        fakeCtx(cwd),
        {
          harness: 'claude',
          mode: 'tinker',
          task: 'x',
          allowDangerous: true,
        },
      );
      const raw = readFileSync(recordPathFor(run.details.file as string), 'utf8');
      const parsed = parseRunRecord(raw);
      assert.ok(parsed.ok && parsed.record.permission === 'danger');
      assert.ok(!/allowDangerous/.test(raw));
      assert.equal(parsed.ok && parsed.record.totalCostUsd, 0.01);
    });
  });
});

test('delegate: a run that dies after streaming output leaves a partial transcript AND a partial record', async () => {
  await withSandbox({ templates: { 'claude/tinker': tpl('tinker', 'edit') } }, async ({ cwd }) => {
    const { delegate } = await import('../extensions/engine.ts');
    const line = JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'half done' } },
    });
    await withFakeBinaries(['claude'], [line], async () => {
      await assert.rejects(() =>
        delegate(
          fakePi(async () => ({})),
          fakeCtx(cwd),
          { harness: 'claude', mode: 'tinker', task: 'x' },
        ),
      );
      const dir = outputsDir('claude');
      const names = readdirSync(dir);
      const partialJson = names.find(n => n.endsWith('-partial.json'));
      assert.ok(partialJson, names.join(','));
      const parsed = parseRunRecord(readFileSync(join(dir, partialJson), 'utf8'));
      assert.ok(parsed.ok);
      if (parsed.ok) {
        assert.equal(parsed.record.partial, true);
        assert.equal(parsed.record.isError, true);
        assert.equal(parsed.record.totalCostUsd, null);
        assert.ok(names.includes(parsed.record.transcript));
      }
    });
  });
});

const STAMP = (i: number, name = 'x') => `2026-01-01T00-00-0${i}-000Z-${name}`;

test('pruneOutputs: sidecars are pruned with their transcripts and orphans are removed', async () => {
  await withSandbox({}, async () => {
    const dir = outputsDir('claude');
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 4; i++) {
      writeFileSync(join(dir, `${STAMP(i)}.md`), '#');
      writeFileSync(join(dir, `${STAMP(i)}.json`), '{}');
      utimesSync(join(dir, `${STAMP(i)}.md`), 1000 + i, 1000 + i);
    }
    writeFileSync(join(dir, `${STAMP(9, 'orphan')}.json`), '{}');
    pruneOutputs(dir, 2);
    assert.deepEqual(
      readdirSync(dir).sort(),
      [`${STAMP(2)}.json`, `${STAMP(2)}.md`, `${STAMP(3)}.json`, `${STAMP(3)}.md`].sort(),
    );
  });
});

test('pruneOutputs: a hand-placed .json (any name that is not a generated sidecar) is never deleted', async () => {
  await withSandbox({}, async () => {
    const dir = outputsDir('claude');
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 4; i++) writeFileSync(join(dir, `${STAMP(i)}.md`), '#');
    writeFileSync(join(dir, 'my-notes.json'), '{"keep":"me"}');
    writeFileSync(join(dir, 'zzz-orphan.json'), '{}');
    writeFileSync(join(dir, '2026-01-01-notes.json'), '{}');
    writeFileSync(join(dir, 'README.txt'), 'x');
    pruneOutputs(dir, 1);
    const left = readdirSync(dir);
    for (const keep of ['my-notes.json', 'zzz-orphan.json', '2026-01-01-notes.json', 'README.txt'])
      assert.ok(left.includes(keep), `${keep} must survive: ${left.join(',')}`);
  });
});

test('pruneOutputs: never follows or removes a symlink named like a sidecar', async () => {
  await withSandbox({}, async () => {
    const dir = outputsDir('claude');
    mkdirSync(dir, { recursive: true });
    const victim = join(dir, '..', 'victim.txt');
    writeFileSync(victim, 'precious');
    for (let i = 0; i < 3; i++) writeFileSync(join(dir, `${STAMP(i)}.md`), '#');
    symlinkSync(victim, join(dir, `${STAMP(7, 'link')}.json`));
    pruneOutputs(dir, 1);
    assert.equal(readFileSync(victim, 'utf8'), 'precious');
    assert.ok(lstatSync(join(dir, `${STAMP(7, 'link')}.json`)).isSymbolicLink(), 'the link itself is left alone');
  });
});

test('writeRunRecord + readRecordsIn: unparseable sidecars are skipped with a reason', async () => {
  await withSandbox({}, async () => {
    const dir = outputsDir('codex');
    mkdirSync(dir, { recursive: true });
    const rec = { ...GOOD(), harness: 'codex', transcript: 'a.md' };
    writeFileSync(join(dir, 'a.md'), '#');
    writeRunRecord(join(dir, 'a.md'), rec);
    writeFileSync(join(dir, 'b.md'), '#');
    writeFileSync(join(dir, 'b.json'), 'garbage');
    const { records, skipped } = readRecordsIn(dir, 'codex');
    assert.equal(records.length, 1);
    assert.deepEqual(skipped, [{ file: 'b.md', reason: 'not valid JSON', harness: 'codex' }]);
  });
});

const put = (dir: string, name: string, over: Record<string, unknown> = {}, mtimeSec = 1000) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), '#');
  utimesSync(join(dir, `${name}.md`), mtimeSec, mtimeSec);
  const rec = { ...GOOD(), harness: 'claude', transcript: `${name}.md`, ...over };
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(rec));
  return rec;
};

test('readRecordsIn: a sidecar with no transcript is not a record; order is the transcript mtime, not startedAt', async () => {
  await withSandbox({}, async () => {
    const dir = outputsDir('claude');
    // planted orphan: no .md at all, startedAt far in the future, hostile addDirs
    mkdirSync(dir, { recursive: true });
    const orphan = { ...GOOD(), harness: 'claude', transcript: 'orphan.md' };
    orphan.startedAt = '2999-01-01T00:00:00.000Z';
    orphan.input = { ...orphan.input, addDirs: ['/', '/etc'] };
    writeFileSync(join(dir, 'orphan.json'), JSON.stringify(orphan));
    const older = put(dir, 'older', { startedAt: '2999-06-01T00:00:00.000Z' }, 1000);
    const newer = put(dir, 'newer', { startedAt: '2001-01-01T00:00:00.000Z' }, 2000);
    const { records, skipped } = readRecordsIn(dir, 'claude');
    assert.deepEqual(
      records.map(r => r.record.runId),
      [newer.runId, older.runId],
      'newest transcript first, whatever the record claims',
    );
    assert.ok(!records.some(r => r.record.runId === orphan.runId));
    assert.deepEqual(skipped, [], 'a stray orphan .json is not even reported as a record');
  });
});

test('loadRecordForTranscript via readRecordsIn: a record whose harness differs from its directory is rejected, with a reason', async () => {
  await withSandbox({}, async () => {
    const dir = outputsDir('claude');
    put(dir, 'edited', { harness: 'codex', mode: 'implement' });
    put(dir, 'otherfile', { transcript: 'somewhere-else.md' });
    const { records, skipped } = readRecordsIn(dir, 'claude');
    assert.equal(records.length, 0);
    assert.equal(skipped.length, 2);
    assert.match(skipped.find(x => x.file === 'edited.md')?.reason ?? '', /harness "codex".*claude outputs directory/);
    assert.match(skipped.find(x => x.file === 'otherfile.md')?.reason ?? '', /different transcript/);
  });
});

test('readRecordsIn: only the newest MAX_SIDECARS_SCANNED transcripts are looked at', async () => {
  await withSandbox({}, async () => {
    const dir = outputsDir('claude');
    put(dir, 'ancient', {}, 10);
    for (let i = 0; i < MAX_SIDECARS_SCANNED; i++) {
      writeFileSync(join(dir, `filler-${i}.md`), '');
      utimesSync(join(dir, `filler-${i}.md`), 5000 + i, 5000 + i);
    }
    const r = readRecordsIn(dir, 'claude');
    assert.equal(r.truncated, true);
    assert.equal(r.records.length, 0, 'the 2001st-newest transcript is never opened');
  });
});

test('parseRunRecord: harness must be one canonical name; mode must be a plain mode name; scopeTruncated is optional', () => {
  const mutate = (patch: (r: Record<string, unknown>) => void) => {
    const copy = JSON.parse(JSON.stringify(GOOD()));
    patch(copy);
    return parseRunRecord(JSON.stringify(copy));
  };
  for (const h of ['claude,codex', 'all', 'Claude', 'omp', ' claude', 'claude ', '--yolo', '']) {
    assert.equal(mutate(r => (r.harness = h)).ok, false, `harness ${JSON.stringify(h)}`);
  }
  assert.equal(mutate(r => (r.harness = 'amp')).ok, true);
  for (const m of ['evil\u001b]0;x\u0007', 'bidi\u202emode', 'zero\u200bwidth', 'a b', '../x', 'm'.repeat(100), '']) {
    assert.equal(mutate(r => (r.mode = m)).ok, false, `mode ${JSON.stringify(m)}`);
  }
  assert.equal(mutate(r => (r.mode = 'm'.repeat(64))).ok, true);
  // scopeTruncated: absent -> false; wrong type -> rejected; true survives
  const absent = mutate(r => delete (r.input as Record<string, unknown>).scopeTruncated);
  assert.ok(absent.ok && absent.record.input.scopeTruncated === false);
  assert.equal(mutate(r => ((r.input as Record<string, unknown>).scopeTruncated = 'yes')).ok, false);
  const yes = mutate(r => ((r.input as Record<string, unknown>).scopeTruncated = true));
  assert.ok(yes.ok && yes.record.input.scopeTruncated === true);
  // a failed parse still peeks the fan-out id (and nothing else) so a resume can list the member
  const bad = mutate(r => {
    r.fanoutId = 'fan_0123456789abcdef';
    r.sessionId = 's'.repeat(500);
  });
  assert.ok(!bad.ok && bad.fanoutId === 'fan_0123456789abcdef');
});

test('buildRunRecord: scope truncation is recorded (a cut scope would widen the restriction)', () => {
  const cut = buildRunRecord({ ...baseSource(), scope: 'p'.repeat(RECORD_LIMITS.scope + 1) });
  assert.equal(cut.input.scopeTruncated, true);
  assert.equal(buildRunRecord({ ...baseSource(), scope: 'src/a.ts' }).input.scopeTruncated, false);
  assert.equal(buildRunRecord({ ...baseSource(), scope: null }).input.scopeTruncated, false);
});

test('readRunRecord: a FIFO named like a sidecar neither hangs nor is read; symlinks and oversized files are refused', async () => {
  await withSandbox({}, async () => {
    const dir = outputsDir('claude');
    mkdirSync(dir, { recursive: true });
    const fifo = join(dir, 'x.json');
    execFileSync('mkfifo', [fifo]);
    const t0 = Date.now();
    const r = readRunRecord(fifo);
    assert.ok(Date.now() - t0 < 2000, 'must return immediately, not block on the FIFO');
    assert.ok(!r.ok && /not a regular file/.test(r.reason));
    // symlink to a perfectly valid record: refused, not followed
    const real = join(dir, 'real.json');
    writeFileSync(real, JSON.stringify(GOOD()));
    symlinkSync(real, join(dir, 'link.json'));
    const l = readRunRecord(join(dir, 'link.json'));
    assert.ok(!l.ok && /not a regular file/.test(l.reason));
    assert.ok(readRunRecord(real).ok);
    // oversized
    writeFileSync(join(dir, 'big.json'), ' '.repeat(RECORD_MAX_BYTES + 1));
    const b = readRunRecord(join(dir, 'big.json'));
    assert.ok(!b.ok && b.reason === 'too large');
  });
});

test('readRecordsIn: a FIFO named <transcript>.json is skipped with a reason (no hang)', async () => {
  await withSandbox({}, async () => {
    const dir = outputsDir('claude');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'f.md'), '#');
    execFileSync('mkfifo', [join(dir, 'f.json')]);
    const t0 = Date.now();
    const { records, skipped } = readRecordsIn(dir, 'claude');
    assert.ok(Date.now() - t0 < 2000);
    assert.equal(records.length, 0);
    assert.match(skipped[0]?.reason ?? '', /not a regular file/);
  });
});

test('writeRunRecord: atomic and symlink-safe — a pre-existing symlink at the sidecar path is replaced, never written through', async () => {
  await withSandbox({}, async () => {
    const dir = outputsDir('claude');
    mkdirSync(dir, { recursive: true });
    const victim = join(dir, '..', 'victim.txt');
    writeFileSync(victim, 'precious');
    symlinkSync(victim, join(dir, 'run.json'));
    writeFileSync(join(dir, 'run.md'), '#');
    writeRunRecord(join(dir, 'run.md'), GOOD());
    assert.equal(readFileSync(victim, 'utf8'), 'precious', 'the link target must not be overwritten');
    const st = lstatSync(join(dir, 'run.json'));
    assert.ok(st.isFile() && !st.isSymbolicLink());
    assert.equal(st.mode & 0o777, 0o600);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.deepEqual(
      readdirSync(dir).filter(n => n.endsWith('.tmp')),
      [],
      'no temp file left behind',
    );
  });
});

test('writeRunRecord: a record that would exceed the size cap is shrunk (flagged truncated), never written unreadable', async () => {
  await withSandbox({}, async () => {
    const dir = outputsDir('claude');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'big.md'), '#');
    const rec = buildRunRecord({
      ...baseSource(),
      transcriptFile: join(dir, 'big.md'),
      task: '\u4e2d'.repeat(RECORD_LIMITS.task),
      scope: '\u4e2d'.repeat(RECORD_LIMITS.scope),
    });
    writeRunRecord(join(dir, 'big.md'), rec);
    const back = readRunRecord(join(dir, 'big.json'));
    assert.ok(back.ok, back.ok ? '' : back.reason);
    if (back.ok) {
      assert.equal(back.record.input.taskTruncated, true, 'a shrunk task must refuse a faithful rerun');
      assert.equal(back.record.input.scopeTruncated, true);
    }
  });
});

test('delegate: the verify command text (template or --verify) is stored nowhere in the record, nested or not', async () => {
  await withSandbox(
    { templates: { 'claude/tinker': tpl('tinker', 'edit', 'verify: echo TEMPLATE_VERIFY_TEXT') } },
    async ({ cwd }) => {
      const { delegate } = await import('../extensions/engine.ts');
      await withFakeBinaries(['claude'], [CLAUDE_RESULT], async () => {
        const run = await delegate(
          fakePi(async () => ({ code: 0, stdout: '', stderr: '' })),
          fakeCtx(cwd),
          { harness: 'claude', mode: 'tinker', task: 'do it', verify: 'echo CLI_VERIFY_TEXT' },
        );
        const raw = readFileSync(recordPathFor(run.details.file as string), 'utf8');
        assert.ok(!raw.includes('TEMPLATE_VERIFY_TEXT') && !raw.includes('CLI_VERIFY_TEXT') && !raw.includes('echo '));
        const parsed = parseRunRecord(raw);
        assert.ok(parsed.ok && parsed.record.input.hadVerify === true);
        const walk = (v: unknown): string[] =>
          typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(walk) : [];
        assert.ok(!walk(parsed.ok ? parsed.record : null).some(x => /VERIFY_TEXT/.test(x)));
      });
    },
  );
});

// ── future mtimes, crash-orphaned temp files, symlinked directories, non-regular transcripts ───────────────────

test('newestFirst: a future-dated file sorts after every believable one, whatever its name; five minutes of skew is tolerated', () => {
  const now = 1_000_000_000_000;
  const real = { mtimeMs: now - 5000, name: 'a-real.md' };
  const planted = { mtimeMs: now + 3600_000, name: 'zzz-planted.md' };
  const skewed = { mtimeMs: now + FUTURE_SKEW_MS - 1, name: 'b-skewed.md' };
  assert.deepEqual(
    [planted, real, skewed].sort((a, b) => newestFirst(a, b, now)),
    [skewed, real, planted],
  );
  assert.equal(FUTURE_SKEW_MS, 5 * 60_000);
  assert.equal(newestFirst({ mtimeMs: now, name: 'a' }, { mtimeMs: now, name: 'b' }, now), 1, 'ties: the name decides');
  const older = { mtimeMs: now - 10, name: 'x' };
  assert.ok(newestFirst(older, real, now) < 0, 'ordinary files: newest first');
});

const ST = (i: number) => `2026-01-01T00-00-${String(i).padStart(2, '0')}-000Z-x`;

test('pruneOutputs: a clock stepped back does not delete the newest REAL transcripts (future mtimes are clamped to now, not ranked last)', async () => {
  await withSandbox({}, async () => {
    const dir = outputsDir('claude');
    mkdirSync(dir, { recursive: true });
    const now = Date.now();
    const touch = (i: number, offsetS: number) => {
      writeFileSync(join(dir, `${ST(i)}.md`), '#');
      writeFileSync(join(dir, `${ST(i)}.json`), '{}');
      utimesSync(join(dir, `${ST(i)}.md`), now / 1000 + offsetS, now / 1000 + offsetS);
    };
    for (let i = 0; i < 5; i++) touch(i, -7 * 86400 + i); // five week-old transcripts
    for (let i = 10; i < 13; i++) touch(i, 60 + i); // three real runs whose mtimes are a minute "in the future"
    touch(20, 0); // the one just written
    pruneOutputs(dir, 4, [`${ST(20)}.md`], now);
    const left = readdirSync(dir).filter(f => f.endsWith('.md'));
    assert.deepEqual(
      left.sort(),
      [10, 11, 12, 20].map(i => `${ST(i)}.md`),
      'the newest real runs survive, the old ones go',
    );
    assert.ok(readdirSync(dir).includes(`${ST(10)}.json`), 'and so do their sidecars');
    assert.ok(!readdirSync(dir).includes(`${ST(0)}.json`));
  });
});

test("pruneOutputs: files modified within 2 minutes are never pruned — two concurrent runs with maxTranscripts 1 keep each other's transcript", async () => {
  await withSandbox({}, async () => {
    const dir = outputsDir('claude');
    mkdirSync(dir, { recursive: true });
    const now = Date.now();
    // run A and run B each wrote their transcript, then each pruned with only ITS OWN file in `keep`
    for (const [i, off] of [
      [1, -30],
      [2, -10],
    ] as const) {
      writeFileSync(join(dir, `${STAMP(i)}.md`), '#');
      writeFileSync(join(dir, `${STAMP(i)}.json`), '{}');
      utimesSync(join(dir, `${STAMP(i)}.md`), now / 1000 + off, now / 1000 + off);
    }
    writeFileSync(join(dir, `${STAMP(0)}.md`), '#'); // an older, finished run
    utimesSync(join(dir, `${STAMP(0)}.md`), now / 1000 - 3600, now / 1000 - 3600);
    pruneOutputs(dir, 1, [`${STAMP(2)}.md`], now); // run B prunes
    pruneOutputs(dir, 1, [`${STAMP(1)}.md`], now); // run A prunes
    assert.deepEqual(
      readdirSync(dir)
        .filter(f => f.endsWith('.md'))
        .sort(),
      [`${STAMP(1)}.md`, `${STAMP(2)}.md`],
      "both runs' transcripts survive; only the old one is pruned",
    );
    assert.ok(readdirSync(dir).includes(`${STAMP(1)}.json`) && readdirSync(dir).includes(`${STAMP(2)}.json`));
    // …and once they are older than the window, the quota applies again
    pruneOutputs(dir, 1, [`${STAMP(2)}.md`], now + 10 * 60_000);
    assert.deepEqual(
      readdirSync(dir).filter(f => f.endsWith('.md')),
      [`${STAMP(2)}.md`],
    );
  });
});

test('pruneOutputs: a flood of far-future files counts as "now": it never outranks the file just written or deletes it', async () => {
  await withSandbox({}, async () => {
    const dir = outputsDir('claude');
    mkdirSync(dir, { recursive: true });
    const now = Date.now();
    writeFileSync(join(dir, `${STAMP(2)}.md`), '#');
    for (let i = 0; i < 10; i++) {
      const f = join(dir, `${STAMP(50 + i, 'zzz')}.md`);
      writeFileSync(f, 'junk');
      utimesSync(f, now / 1000 + 3600, now / 1000 + 3600);
    }
    pruneOutputs(dir, 1, [`${STAMP(2)}.md`], now);
    assert.ok(readdirSync(dir).includes(`${STAMP(2)}.md`), 'the just-written transcript survives');
  });
});

test('pruneOutputs: crash-orphaned sidecar temp files are removed after an hour — only the exact generated shape, only regular files', async () => {
  await withSandbox({}, async () => {
    const dir = outputsDir('claude');
    mkdirSync(dir, { recursive: true });
    const now = Date.now();
    const old = (name: string, ageMs = SIDECAR_TMP_MAX_AGE_MS + 60_000) => {
      writeFileSync(join(dir, name), 'x');
      utimesSync(join(dir, name), (now - ageMs) / 1000, (now - ageMs) / 1000);
    };
    const orphan = `${STAMP(1)}.json.4242.0123456789ab.tmp`;
    old(orphan);
    old(`${STAMP(2)}.json.4242.0123456789ab.tmp`, 5 * 60_000); // too recent: a live writer may own it
    old(`${STAMP(3)}.json.4242.0123456789ab.tmp`, -3600_000); // future-dated: never "old"
    old('notes.json.4242.0123456789ab.tmp'); // not generated-shaped
    old(`${STAMP(4)}.json.4242.XYZ.tmp`); // wrong random part
    old(`${STAMP(5)}.json.tmp`);
    old('my-notes.tmp');
    const target = join(tmpdir(), `tmp-target-${process.pid}`);
    writeFileSync(target, 'precious');
    const ancient = (now - SIDECAR_TMP_MAX_AGE_MS - 60_000) / 1000;
    symlinkSync(target, join(dir, `${STAMP(6)}.json.4242.0123456789ab.tmp`));
    lutimesSync(join(dir, `${STAMP(6)}.json.4242.0123456789ab.tmp`), ancient, ancient); // an OLD link: still not ours to remove
    mkdirSync(join(dir, `${STAMP(7)}.json.4242.0123456789ab.tmp`));
    try {
      pruneOutputs(dir, 0); // "keep every transcript" does not keep the litter
      const left = readdirSync(dir).sort();
      assert.ok(!left.includes(orphan), `stale temp removed: ${left}`);
      assert.equal(left.length, 8, left.join(', '));
      assert.equal(readFileSync(target, 'utf8'), 'precious', 'a symlink is never followed');
      assert.ok(lstatSync(join(dir, `${STAMP(6)}.json.4242.0123456789ab.tmp`)).isSymbolicLink());
    } finally {
      rmSync(target, { force: true });
    }
  });
});

test('a symlinked outputs directory: its target keeps its permissions (record and transcript writes), and a warning is emitted once', async () => {
  await withSandbox({}, async () => {
    const dir = outputsDir('claude');
    mkdirSync(join(dir, '..'), { recursive: true });
    const target = mkdtempSync(join(tmpdir(), 'outputs-target-'));
    chmodSync(target, 0o755);
    symlinkSync(target, dir);
    const warnings: string[] = [];
    const onWarning = (w: Error) => warnings.push(w.message);
    process.on('warning', onWarning);
    try {
      const t1 = writeTranscript(dir, 'review', '# t');
      writeRunRecord(t1, GOOD());
      writeTranscript(dir, 'review', '# t2');
      await new Promise(r => setTimeout(r, 20));
      assert.equal(statSync(target).mode & 0o777, 0o755, 'the symlink target was not chmod-ed');
      assert.ok(lstatSync(dir).isSymbolicLink());
      assert.equal(readdirSync(target).filter(f => f.endsWith('.md')).length >= 1, true, 'writes still land there');
      assert.equal(statSync(t1).mode & 0o777, 0o600, 'files are still private');
      assert.equal(warnings.filter(w => /symbolic link/.test(w)).length, 1, warnings.join('|'));
    } finally {
      process.off('warning', onWarning);
      rmSync(target, { recursive: true, force: true });
    }
    // an ordinary directory is still made owner-only
    const plain = join(dir, '..', 'plain-outputs');
    mkdirSync(plain, { mode: 0o755 });
    chmodSync(plain, 0o755);
    writeTranscript(plain, 'review', '# t');
    assert.equal(statSync(plain).mode & 0o777, 0o700);
  });
});

test('loadRecordForTranscript: a symlinked or FIFO TRANSCRIPT is never a record (even with a valid sidecar next to it)', async () => {
  await withSandbox({}, async () => {
    const dir = outputsDir('claude');
    mkdirSync(dir, { recursive: true });
    const real = join(dir, `${STAMP(1)}.md`);
    writeFileSync(real, '# real');
    const rec = (name: string) => ({ ...GOOD(), transcript: `${name}.md` });
    // a symlink named like a transcript, pointing at a regular file
    const link = join(dir, `${STAMP(2)}.md`);
    symlinkSync(real, link);
    writeFileSync(join(dir, `${STAMP(2)}.json`), JSON.stringify(rec(STAMP(2))));
    const viaLink = loadRecordForTranscript(link, 'claude');
    assert.ok(!viaLink.ok && viaLink.reason === 'transcript is not a regular file');
    // a FIFO named like a transcript: refused, and the check never opens it (no hang)
    const fifo = join(dir, `${STAMP(3)}.md`);
    execFileSync('mkfifo', [fifo]);
    writeFileSync(join(dir, `${STAMP(3)}.json`), JSON.stringify(rec(STAMP(3))));
    const t0 = Date.now();
    const f = loadRecordForTranscript(fifo, 'claude');
    assert.ok(Date.now() - t0 < 2000);
    assert.ok(!f.ok && f.reason === 'transcript is not a regular file');
    // the real pair is fine
    writeFileSync(join(dir, `${STAMP(1)}.json`), JSON.stringify(rec(STAMP(1))));
    assert.ok(loadRecordForTranscript(real, 'claude').ok);
    // and an enumeration neither lists nor hangs on them
    const { records } = readRecordsIn(dir, 'claude');
    assert.deepEqual(
      records.map(r => r.transcript),
      [real],
    );
  });
});

test('writeRunRecord: bidi controls, U+2028 and zero-width characters are written \\uXXXX-escaped (cat-safe) and read back identically', async () => {
  await withSandbox({}, async () => {
    const dir = outputsDir('claude');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'esc.md'), '#');
    const task = `fix\u202e\u2066 it\u2028next\u200b${'\u{1F468}\u200d\u{1F469}'}\u{e0041}\u0085 end`;
    const rec = buildRunRecord({ ...baseSource(), task });
    writeRunRecord(join(dir, 'esc.md'), rec);
    const raw = readFileSync(join(dir, 'esc.json'), 'utf8');
    assert.ok(!UNSAFE.test(raw.replace(/\n/g, '')), 'no raw invisible / bidi / separator character in the file');
    assert.match(raw, /\\u202e/);
    assert.match(raw, /\\u2028/);
    assert.match(raw, /\\udb40\\udc41/, 'an astral tag character is escaped as its surrogate pair');
    const back = parseRunRecord(raw);
    assert.ok(back.ok);
    assert.equal(back.ok ? back.record.input.task : null, task, 'the parser reads the exact task back');
  });
});

test('pruneOutputs: far-future mtimes carry no ordering information (clamped to now: the name decides, not how far ahead they claim to be)', async () => {
  await withSandbox({}, async () => {
    const dir = outputsDir('claude');
    mkdirSync(dir, { recursive: true });
    const now = Date.now();
    for (const [name, hoursAhead] of [
      ['2026-01-01T00-00-01-000Z-a.md', 2],
      ['2026-01-01T00-00-02-000Z-b.md', 1],
    ] as const) {
      writeFileSync(join(dir, name), '#');
      utimesSync(join(dir, name), now / 1000 + hoursAhead * 3600, now / 1000 + hoursAhead * 3600);
    }
    pruneOutputs(dir, 1, [], now);
    assert.deepEqual(
      readdirSync(dir),
      ['2026-01-01T00-00-02-000Z-b.md'],
      'both are "now": the later name is the newer',
    );
  });
});

test('pruneOutputs: a transcript named in `keep` survives even outside the recent-file window and the quota', async () => {
  await withSandbox({}, async () => {
    const dir = outputsDir('claude');
    mkdirSync(dir, { recursive: true });
    const now = Date.now();
    writeFileSync(join(dir, `${'2026-01-01T00-00-01-000Z-x'}.md`), '#'); // old, in keep
    utimesSync(join(dir, '2026-01-01T00-00-01-000Z-x.md'), now / 1000 - 7200, now / 1000 - 7200);
    writeFileSync(join(dir, '2026-01-01T00-00-02-000Z-x.md'), '#'); // newer, not in keep
    utimesSync(join(dir, '2026-01-01T00-00-02-000Z-x.md'), now / 1000 - 3600, now / 1000 - 3600);
    pruneOutputs(dir, 1, ['2026-01-01T00-00-01-000Z-x.md'], now);
    assert.deepEqual(readdirSync(dir), ['2026-01-01T00-00-01-000Z-x.md']);
  });
});

test('delegate: the transcript it just wrote survives its own prune even when a newer one exists and the clock says it is old', async () => {
  await withSandbox({ settings: { maxTranscripts: 1 } }, async ({ cwd }) => {
    const { delegate } = await import('../extensions/engine.ts');
    await withFakeBinaries(['claude'], [CLAUDE_RESULT], async () => {
      const dir = outputsDir('claude');
      mkdirSync(dir, { recursive: true });
      const real = Date.now;
      const newer = join(dir, 'zzz-newer.md');
      writeFileSync(newer, '#');
      utimesSync(newer, real() / 1000 + 1800, real() / 1000 + 1800);
      // an hour on, the just-written file is outside every recent-file protection and ranks below zzz-newer
      Date.now = () => real() + 3600_000;
      let file: string;
      try {
        const run = await delegate(
          fakePi(async () => ({ code: 0, stdout: '', stderr: '' })),
          fakeCtx(cwd),
          { harness: 'claude', mode: 'general', task: 'do it' },
        );
        file = run.details.file as string;
      } finally {
        Date.now = real;
      }
      assert.ok(readdirSync(dir).includes(basename(file)), `the run's own transcript is kept: ${readdirSync(dir)}`);
      assert.ok(readdirSync(dir).includes(basename(recordPathFor(file))), 'and its sidecar');
    });
  });
});

test('pruneOutputs: a file a minute in the future (clock skew) is protected like a recent one, even when far-future files outrank it by name', async () => {
  await withSandbox({}, async () => {
    const dir = outputsDir('claude');
    mkdirSync(dir, { recursive: true });
    const now = Date.now();
    const skewed = '2026-01-01T00-00-01-000Z-real.md';
    writeFileSync(join(dir, skewed), '#');
    utimesSync(join(dir, skewed), now / 1000 + 60, now / 1000 + 60);
    for (let i = 0; i < 3; i++) {
      const f = `2026-01-01T00-00-5${i}-000Z-zzz.md`;
      writeFileSync(join(dir, f), 'junk');
      utimesSync(join(dir, f), now / 1000 + 3600, now / 1000 + 3600);
    }
    pruneOutputs(dir, 1, [], now);
    assert.ok(readdirSync(dir).includes(skewed), readdirSync(dir).join(', '));
  });
});

test('pruneOutputs: a clock stepped back TEN minutes (past the selection skew allowance) still keeps the newest real transcripts', async () => {
  await withSandbox({}, async () => {
    const dir = outputsDir('claude');
    mkdirSync(dir, { recursive: true });
    const now = Date.now();
    const stamp = (i: number) => `2026-01-01T00-00-${String(i).padStart(2, '0')}-000Z-x`;
    const touch = (i: number, offsetS: number) => {
      writeFileSync(join(dir, `${stamp(i)}.md`), '#');
      utimesSync(join(dir, `${stamp(i)}.md`), now / 1000 + offsetS, now / 1000 + offsetS);
    };
    for (let i = 0; i < 5; i++) touch(i, -7 * 86400 + i);
    for (let i = 10; i < 13; i++) touch(i, 600 + i); // ten minutes "ahead": the demotion for CHOOSING a run applies, not for deleting
    touch(20, 0);
    pruneOutputs(dir, 4, [`${stamp(20)}.md`], now);
    assert.deepEqual(
      readdirSync(dir).sort(),
      [10, 11, 12, 20].map(i => `${stamp(i)}.md`),
    );
  });
});
