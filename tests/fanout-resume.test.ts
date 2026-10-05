import assert from 'node:assert/strict';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { outputsDir } from '../extensions/config.ts';
import { planFanoutResume } from '../extensions/fanout-resume.ts';
import { buildRunRecord, newFanoutId, newRunId, type RunRecord } from '../extensions/run-record.ts';
import {
  type CapturedTool,
  CLAUDE_RESULT,
  CODEX_RESULT_LINES,
  fakeCtx,
  loadExtension,
  readArgs,
  withFakeBinaries,
  withOnlyFakes,
  withSandbox,
} from './helpers/sandbox.ts';
import { UNSAFE } from './helpers/unsafe.ts';

const rec = (over: Partial<RunRecord>): RunRecord => ({
  ...buildRunRecord({
    runId: newRunId(),
    harness: 'claude',
    mode: 'general',
    permission: 'edit',
    nativeClass: 'none',
    model: null,
    sessionId: 'sess-1',
    resumed: false,
    startedAtMs: 1_700_000_000_000,
    endedAtMs: 1_700_000_001_000,
    durationMs: 1000,
    isError: false,
    stopReason: null,
    timeoutMs: null,
    numTurns: null,
    totalCostUsd: null,
    usage: null,
    transcriptFile: '/o/a.md',
    cwd: '/proj',
    task: 'x',
    hadVerify: false,
  }),
  ...over,
});

test('planFanoutResume: each member keeps its own harness + session; sessionless members are reported', () => {
  const fid = newFanoutId();
  const records = [
    rec({ fanoutId: fid, harness: 'claude', sessionId: 'c-1' }),
    rec({ fanoutId: fid, harness: 'codex', sessionId: 't-1' }),
    rec({ fanoutId: fid, harness: 'amp', sessionId: null }),
    rec({ fanoutId: newFanoutId(), harness: 'devin', sessionId: 'other' }),
    rec({ fanoutId: null, harness: 'opencode', sessionId: 'single' }),
  ];
  const plan = planFanoutResume(fid, records, '/proj');
  assert.ok(plan.ok);
  if (plan.ok) {
    assert.deepEqual(plan.harnesses, ['claude', 'codex']);
    assert.deepEqual(plan.sessions, { claude: 'c-1', codex: 't-1' });
    assert.deepEqual(plan.noSession, ['amp']);
    assert.equal(plan.mode, 'general');
  }
});

test('planFanoutResume: the most recent record of a harness wins; errors for unknown id, other cwd, no sessions, hostile ids', () => {
  const fid = newFanoutId();
  const older = rec({ fanoutId: fid, sessionId: 'old', startedAt: '2026-01-01T00:00:00.000Z' });
  const newer = rec({ fanoutId: fid, sessionId: 'new', startedAt: '2026-02-01T00:00:00.000Z' });
  const p = planFanoutResume(fid, [newer, older], '/proj');
  assert.ok(p.ok && p.sessions.claude === 'new');
  const unknown = planFanoutResume(newFanoutId(), [newer], '/proj');
  assert.ok(!unknown.ok && /unknown fan-out id/.test(unknown.error));
  const elsewhere = planFanoutResume(fid, [newer], '/somewhere/else');
  assert.ok(!elsewhere.ok && /not the current directory/.test(elsewhere.error));
  const none = planFanoutResume(fid, [rec({ fanoutId: fid, sessionId: null })], '/proj');
  assert.ok(!none.ok && /nothing to resume/.test(none.error));
  for (const bad of ['--dangerously-bypass', 'a b', 'x'.repeat(200), 'a\u001b[31m']) {
    const h = planFanoutResume(fid, [rec({ fanoutId: fid, sessionId: bad })], '/proj');
    assert.ok(!h.ok && /unusable/.test(h.error), bad);
    assert.ok(!h.ok && !h.error.includes('\u001b'));
  }
});

const ran = (argsFile: string, name: string): boolean => {
  const argv = readArgs(`${argsFile}.${name}`);
  return argv !== null && !(argv.length === 1 && argv[0] === '--version');
};
const clear = (argsFile: string) => {
  for (const n of ['claude', 'codex']) rmSync(`${argsFile}.${n}`, { force: true });
};

async function capture<T>(fn: () => Promise<T>): Promise<{ value: T; err: string; out: string }> {
  const errs: string[] = [];
  const outs: string[] = [];
  const oe = process.stderr.write.bind(process.stderr);
  const oo = process.stdout.write.bind(process.stdout);
  process.stderr.write = ((c: string | Uint8Array) => {
    errs.push(String(c));
    return true;
  }) as typeof process.stderr.write;
  process.stdout.write = ((c: string | Uint8Array) => {
    outs.push(String(c));
    return true;
  }) as typeof process.stdout.write;
  try {
    return { value: await fn(), err: errs.join(''), out: outs.join('') };
  } finally {
    process.stderr.write = oe;
    process.stdout.write = oo;
  }
}

function fanoutIdOf(): { id: string; file: (h: string) => string } {
  const find = (h: string) => {
    const dir = outputsDir(h);
    const name = readdirSync(dir).find(f => f.endsWith('.json')) as string;
    return join(dir, name);
  };
  const r = JSON.parse(readFileSync(find('claude'), 'utf8')) as RunRecord;
  assert.ok(r.fanoutId);
  return { id: r.fanoutId, file: find };
}

test('/delegate --resume=<fan-out id>: every member resumes ITS OWN session on ITS OWN harness', async () => {
  await withSandbox({}, async ({ cwd }) => {
    await withFakeBinaries(['claude', 'codex'], [CLAUDE_RESULT, ...CODEX_RESULT_LINES], async argsFile => {
      await withOnlyFakes(argsFile, async () => {
        const { commands } = await loadExtension(async () => ({ stdout: '', stderr: '', code: 0 }));
        const h = commands.get('delegate')?.handler as (a: string, c: unknown) => Promise<void>;
        await capture(() => h('claude,codex general first pass', fakeCtx(cwd)));
        const { id } = fanoutIdOf();
        clear(argsFile);
        const { err } = await capture(() => h(`--resume=${id} second pass`, fakeCtx(cwd)));
        assert.ok(ran(argsFile, 'claude') && ran(argsFile, 'codex'), err);
        const claudeArgs = (readArgs(`${argsFile}.claude`) ?? []).join('\n');
        const codexArgs = (readArgs(`${argsFile}.codex`) ?? []).join('\n');
        assert.match(claudeArgs, /--resume\nsess-1/, 'claude resumes the claude session');
        assert.ok(!claudeArgs.includes('thr-1'));
        assert.match(codexArgs, /exec\nresume\n--json[\s\S]*--\nthr-1\n/, 'codex resumes the codex thread');
        assert.ok(!codexArgs.includes('sess-1'));
        assert.match(codexArgs, /second pass/);
        // every resumed member's record says so, and shares a NEW fan-out id
        const all = ['claude', 'codex'].flatMap(hn =>
          readdirSync(outputsDir(hn))
            .filter(f => f.endsWith('.json'))
            .map(f => JSON.parse(readFileSync(join(outputsDir(hn), f), 'utf8')) as RunRecord),
        );
        const resumedRecs = all.filter(r => r.resumed);
        assert.deepEqual(resumedRecs.map(r => r.harness).sort(), ['claude', 'codex']);
        assert.equal(new Set(resumedRecs.map(r => r.fanoutId)).size, 1);
        assert.notEqual(resumedRecs[0].fanoutId, id);
      });
    });
  });
});

test('fan-out resume: a sessionless member and an uninstalled harness are skipped and reported, never silently dropped', async () => {
  await withSandbox({}, async ({ cwd }) => {
    const { takePendingReport } = await import('../extensions/engine.ts');
    await withFakeBinaries(['claude', 'codex'], [CLAUDE_RESULT, ...CODEX_RESULT_LINES], async argsFile => {
      const { commands } = await loadExtension(async () => ({ stdout: '', stderr: '', code: 0 }));
      const h = commands.get('delegate')?.handler as (a: string, c: unknown) => Promise<void>;
      await withOnlyFakes(argsFile, async () => {
        await capture(() => h('claude,codex general first pass', fakeCtx(cwd)));
      });
      const { id, file } = fanoutIdOf();
      takePendingReport();
      // codex recorded no session
      const codexFile = file('codex').replace(/\.json$/, '.json');
      const cr = JSON.parse(readFileSync(codexFile, 'utf8'));
      cr.sessionId = null;
      writeFileSync(codexFile, JSON.stringify(cr));
      clear(argsFile);
      await withOnlyFakes(argsFile, async () => {
        const { err } = await capture(() => h(`--resume=${id} again`, fakeCtx(cwd)));
        assert.match(err, /no recorded session id, skipped: codex/);
        assert.ok(ran(argsFile, 'claude'));
        assert.ok(!ran(argsFile, 'codex'));
        const report = takePendingReport();
        assert.match(report?.content ?? '', /no recorded session id, skipped: codex/);
      });
      // uninstalled harness (claude removed from PATH): reported as not installed, codex-less so nothing resumable
      cr.sessionId = 'thr-1';
      writeFileSync(codexFile, JSON.stringify(cr));
      clear(argsFile);
      rmSync(join(argsFile, '..', 'claude'));
      await withOnlyFakes(argsFile, async () => {
        await capture(() => h(`--resume=${id} again`, fakeCtx(cwd)));
        const report = takePendingReport();
        assert.match(report?.content ?? '', /not installed, skipped: claude/);
        assert.ok(ran(argsFile, 'codex'));
      });
    });
  });
});

test('fan-out resume: unknown/wrong ids, a named harness, plain session ids and danger all behave', async () => {
  await withSandbox({}, async ({ cwd }) => {
    await withFakeBinaries(['claude', 'codex'], [CLAUDE_RESULT, ...CODEX_RESULT_LINES], async argsFile => {
      await withOnlyFakes(argsFile, async () => {
        const { commands } = await loadExtension(async () => ({ stdout: '', stderr: '', code: 0 }));
        const h = commands.get('delegate')?.handler as (a: string, c: unknown) => Promise<void>;
        await capture(() => h('claude,codex general first pass', fakeCtx(cwd)));
        const { id } = fanoutIdOf();
        clear(argsFile);
        // a well-formed id matching no record is an error, not a session id
        const unknown = await capture(() => h('--resume=fan_0000000000000000 x', fakeCtx(cwd)));
        assert.match(unknown.err, /unknown fan-out id/);
        // naming a harness (or using an alias command) is refused
        assert.match((await capture(() => h(`claude --resume=${id} x`, fakeCtx(cwd)))).err, /do not name a harness/);
        assert.match(
          (await capture(() => commands.get('claude')?.handler(`--resume=${id} x`, fakeCtx(cwd)) as Promise<void>)).err,
          /do not name a harness/,
        );
        // a plain session id across a fan-out is still rejected
        assert.match((await capture(() => h('all --resume=abc123 x', fakeCtx(cwd)))).err, /across a fan-out/);
        // a plain id on a single harness is untouched
        const single = await capture(() => h('claude --resume=abc123 x', fakeCtx(cwd)));
        assert.ok(ran(argsFile, 'claude'), single.err);
        assert.match((readArgs(`${argsFile}.claude`) ?? []).join('\n'), /--resume\nabc123/);
        clear(argsFile);
        // danger on a resume still needs the human: headless is refused, nothing runs
        const danger = await capture(() => h(`--resume=${id} --allow-dangerous x`, fakeCtx(cwd)));
        assert.match(danger.err, /needs interactive confirmation/);
        assert.ok(!ran(argsFile, 'claude') && !ran(argsFile, 'codex'));
        // another directory can't resume it
        const other = await capture(() => h(`--resume=${id} x`, fakeCtx(join(cwd, '..'))));
        assert.match(other.err, /not the current directory/);
        assert.ok(!ran(argsFile, 'claude'));
      });
    });
  });
});

test('delegate tool: resumeFanout resumes the recorded members; it cannot be combined with harness/sessionId and keeps the confirms', async () => {
  await withSandbox({}, async ({ cwd }) => {
    await withFakeBinaries(['claude', 'codex'], [CLAUDE_RESULT, ...CODEX_RESULT_LINES], async argsFile => {
      await withOnlyFakes(argsFile, async () => {
        const { commands, tools } = await loadExtension(async () => ({ stdout: '', stderr: '', code: 0 }));
        const h = commands.get('delegate')?.handler as (a: string, c: unknown) => Promise<void>;
        await capture(() => h('claude,codex general first pass', fakeCtx(cwd)));
        const { id } = fanoutIdOf();
        clear(argsFile);
        const tool = tools.get('delegate') as CapturedTool;
        const call = (params: Record<string, unknown>) =>
          tool.execute('t', { task: 'again', ...params }, undefined, undefined, fakeCtx(cwd));
        await assert.rejects(() => call({ resumeFanout: id, harness: 'claude' }), /omit harness/);
        await assert.rejects(() => call({ resumeFanout: id, sessionId: 'abc' }), /mutually exclusive/);
        await assert.rejects(() => call({ resumeFanout: 'nope' }), /must be a fan-out id/);
        await assert.rejects(() => call({ resumeFanout: 'fan_0000000000000000' }), /unknown fan-out id/);
        await assert.rejects(() => call({ resumeFanout: id, allowDangerous: true }), /no interactive UI/);
        await assert.rejects(() => call({ resumeFanout: id, addDirs: ['/etc'] }), /no interactive UI/);
        assert.ok(!ran(argsFile, 'claude') && !ran(argsFile, 'codex'), 'refusals run nothing');
        const res = (await call({ resumeFanout: id })) as {
          details: { fanout: boolean; runs: { harness: string; ok: boolean }[] };
        };
        assert.equal(res.details.fanout, true);
        assert.deepEqual(
          res.details.runs.map(r => [r.harness, r.ok]),
          [
            ['claude', true],
            ['codex', true],
          ],
        );
        assert.match((readArgs(`${argsFile}.claude`) ?? []).join('\n'), /--resume\nsess-1/);
        assert.match((readArgs(`${argsFile}.codex`) ?? []).join('\n'), /--\nthr-1\n/);
      });
    });
  });
});

test('planFanoutResume: harness names are canonicalized so the session lookup always matches; unknown names are refused', () => {
  const fid = newFanoutId();
  const plan = planFanoutResume(
    fid,
    [
      rec({ fanoutId: fid, harness: 'Claude', sessionId: 'c-1' }),
      rec({ fanoutId: fid, harness: 'omp', sessionId: 'a-1' }),
    ],
    '/proj',
  );
  assert.ok(plan.ok);
  if (plan.ok) {
    assert.deepEqual(plan.harnesses, ['claude', 'amp']);
    assert.deepEqual(plan.sessions, { claude: 'c-1', amp: 'a-1' });
    // every harness the fan-out launches has a session under exactly that name
    for (const h of plan.harnesses) assert.ok(Object.hasOwn(plan.sessions, h));
  }
  const bad = planFanoutResume(fid, [rec({ fanoutId: fid, harness: 'claude,codex', sessionId: 's' })], '/proj');
  assert.ok(!bad.ok && /not a known harness/.test(bad.error));
  const evil = planFanoutResume(fid, [rec({ fanoutId: fid, harness: 'x\u001b[31m\u202e', sessionId: 's' })], '/proj');
  assert.ok(!evil.ok && !UNSAFE.test(evil.error), evil.ok ? '' : JSON.stringify(evil.error));
});

test("planFanoutResume: the newest record (input order, newest first) wins — a record's own startedAt is not trusted", () => {
  const fid = newFanoutId();
  const claimsFuture = rec({ fanoutId: fid, sessionId: 'planted', startedAt: '2999-01-01T00:00:00.000Z' });
  const realNewest = rec({ fanoutId: fid, sessionId: 'real', startedAt: '2001-01-01T00:00:00.000Z' });
  const p = planFanoutResume(fid, [realNewest, claimsFuture], '/proj');
  assert.ok(p.ok && p.sessions.claude === 'real');
});

test('planFanoutResume: members whose record was unreadable are LISTED, and a fan-out of only unreadable records says so', () => {
  const fid = newFanoutId();
  const skipped = [
    { file: 'a.md', reason: 'invalid field "sessionId"', fanoutId: fid, harness: 'codex' },
    { file: 'b.md', reason: 'x', fanoutId: newFanoutId(), harness: 'devin' },
  ];
  const plan = planFanoutResume(fid, [rec({ fanoutId: fid, harness: 'claude', sessionId: 'c-1' })], '/proj', skipped);
  assert.ok(plan.ok && plan.unreadable.length === 1 && plan.unreadable[0] === 'codex');
  const onlyBad = planFanoutResume(fid, [], '/proj', skipped);
  assert.ok(!onlyBad.ok && /no usable run record.*unreadable record\(s\) for: "?codex/.test(onlyBad.error));
});

test('fan-out resume (e2e): an unparseable or case-edited member is reported as unreadable — never a fresh session passed off as resumed', async () => {
  await withSandbox({}, async ({ cwd }) => {
    const { takePendingReport } = await import('../extensions/engine.ts');
    await withFakeBinaries(['claude', 'codex'], [CLAUDE_RESULT, ...CODEX_RESULT_LINES], async argsFile => {
      const { commands } = await loadExtension(async () => ({ stdout: '', stderr: '', code: 0 }));
      const h = commands.get('delegate')?.handler as (a: string, c: unknown) => Promise<void>;
      await withOnlyFakes(argsFile, async () => {
        await capture(() => h('claude,codex general first pass', fakeCtx(cwd)));
      });
      const { id, file } = fanoutIdOf();
      takePendingReport();
      // codex: oversized session id (the parser refuses the whole record); claude: harness case-edited
      const codexFile = file('codex');
      const cr = JSON.parse(readFileSync(codexFile, 'utf8'));
      cr.sessionId = 's'.repeat(600);
      writeFileSync(codexFile, JSON.stringify(cr));
      const claudeFile = file('claude');
      const kr = JSON.parse(readFileSync(claudeFile, 'utf8'));
      kr.harness = 'Claude';
      writeFileSync(claudeFile, JSON.stringify(kr));
      clear(argsFile);
      await withOnlyFakes(argsFile, async () => {
        const { err } = await capture(() => h(`--resume=${id} again`, fakeCtx(cwd)));
        assert.match(err, /no usable run record.*unreadable record\(s\) for/, err);
        assert.ok(!ran(argsFile, 'claude') && !ran(argsFile, 'codex'), 'nothing runs — no silent fresh session');
      });
      // one member readable again: it resumes, the other is listed as unreadable in the report
      kr.harness = 'claude';
      writeFileSync(claudeFile, JSON.stringify(kr));
      clear(argsFile);
      await withOnlyFakes(argsFile, async () => {
        const { err } = await capture(() => h(`--resume=${id} again`, fakeCtx(cwd)));
        assert.match(err, /unreadable run record, not resumed: "?codex/);
        assert.ok(ran(argsFile, 'claude') && !ran(argsFile, 'codex'));
        assert.match((readArgs(`${argsFile}.claude`) ?? []).join('\n'), /--resume\nsess-1/);
        assert.match(takePendingReport()?.content ?? '', /unreadable run record, not resumed: codex/);
      });
    });
  });
});

test('fan-out resume: a harness with no session mapping FAILS (tool path) instead of starting a fresh session', async () => {
  await withSandbox({}, async ({ cwd }) => {
    await withFakeBinaries(['claude'], [CLAUDE_RESULT], async argsFile => {
      const { runFanoutTool } = await import('../extensions/fanout.ts');
      const { loadConfig } = await import('../extensions/config.ts');
      const { fakePi } = await import('./helpers/sandbox.ts');
      await withOnlyFakes(argsFile, async () => {
        const res = await runFanoutTool(
          fakePi(async () => ({ code: 0, stdout: '', stderr: '' })),
          fakeCtx(cwd),
          loadConfig(),
          { task: 'again', harness: 'claude' },
          undefined,
          undefined,
          { sessions: {}, noSession: [] },
        );
        const runs = (res.details as { runs: { harness: string; ok: boolean; error?: string }[] }).runs;
        assert.deepEqual(
          runs.map(r => [r.harness, r.ok]),
          [['claude', false]],
        );
        assert.match(runs[0].error ?? '', /no recorded session for claude.*not starting a fresh one/);
        assert.ok(!ran(argsFile, 'claude'), 'no fresh claude session may start');
      });
    });
  });
});

test('fan-out resume: a harness with no session mapping FAILS (command path) instead of starting a fresh session', async () => {
  await withSandbox({}, async ({ cwd }) => {
    await withFakeBinaries(['claude'], [CLAUDE_RESULT], async argsFile => {
      const { runFanoutCommand } = await import('../extensions/fanout.ts');
      const { fakePi } = await import('./helpers/sandbox.ts');
      await withOnlyFakes(argsFile, async () => {
        const { takePendingReport } = await import('../extensions/engine.ts');
        takePendingReport();
        await capture(() =>
          runFanoutCommand(
            fakePi(async () => ({ code: 0, stdout: '', stderr: '' })),
            { activeRunId: 0, activeOverlay: null },
            fakeCtx(cwd),
            { task: 'again', harness: 'claude', mode: 'general' },
            { sessions: {}, noSession: [] },
          ),
        );
        assert.ok(!ran(argsFile, 'claude'), 'no fresh claude session may start');
        assert.match(takePendingReport()?.content ?? '', /no recorded session for claude.*not starting a fresh one/);
      });
    });
  });
});
