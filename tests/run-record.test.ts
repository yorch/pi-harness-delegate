import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pruneOutputs } from '../extensions/activity.ts';
import { outputsDir } from '../extensions/config.ts';
import {
  buildRunRecord,
  displayText,
  isFanoutId,
  isRunId,
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
