import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pruneOutputs } from '../extensions/activity.ts';
import { outputsDir } from '../extensions/config.ts';
import {
  buildRunRecord,
  displayText,
  isFanoutId,
  isRunId,
  newFanoutId,
  newRunId,
  parseRunRecord,
  RECORD_LIMITS,
  type RunRecordSource,
  readRecordsIn,
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
  assert.equal(displayText('hi\u001b[31mred\u001b[0m‮\u0000 there'), 'hired there');
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

test('pruneOutputs: sidecars are pruned with their transcripts and orphans are removed', async () => {
  await withSandbox({}, async () => {
    const dir = outputsDir('claude');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 4; i++) {
      writeFileSync(join(dir, `t${i}.md`), '#');
      writeFileSync(join(dir, `t${i}.json`), '{}');
      utimesSync(join(dir, `t${i}.md`), 1000 + i, 1000 + i);
    }
    writeFileSync(join(dir, 'orphan.json'), '{}');
    pruneOutputs(dir, 2);
    assert.deepEqual(readdirSync(dir).sort(), ['t2.json', 't2.md', 't3.json', 't3.md']);
  });
});

test('writeRunRecord + readRecordsIn: unparseable sidecars are skipped with a reason', async () => {
  await withSandbox({}, async () => {
    const dir = outputsDir('codex');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dir, { recursive: true });
    const rec = GOOD();
    writeRunRecord(join(dir, 'a.md'), rec);
    writeFileSync(join(dir, 'bad.json'), 'garbage');
    const { records, skipped } = readRecordsIn(dir);
    assert.equal(records.length, 1);
    assert.deepEqual(skipped, [{ file: 'bad.json', reason: 'not valid JSON' }]);
  });
});
