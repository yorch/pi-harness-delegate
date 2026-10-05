import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { runAcpHarness } from '../extensions/acp-runner.ts';
import { claudeHarness } from '../extensions/harnesses/claude.ts';
import { devinHarness } from '../extensions/harnesses/devin.ts';
import type { Harness } from '../extensions/harnesses/types.ts';
import { runHarness } from '../extensions/runner.ts';
import { readPid, waitForNoProcessWithArg, waitForProcessExit } from './helpers/wait.ts';

/** A stdout harness that runs `node -e <script>` instead of a real CLI, parsed as Claude stream-json. */
function nodeHarness(base: Harness, script: string): Harness {
  return { ...base, binary: process.execPath, buildArgs: () => ['-e', script] };
}

/** A marker file inside its own fresh `mkdtemp` dir — unique by construction; remove with `rmMarker`. */
function markerPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'runner-test-')), 'pid.marker');
}

function rmMarker(path: string): void {
  rmSync(dirname(path), { recursive: true, force: true });
}

/**
 * Every test here spawns a real child process. bun's default per-test timeout (5s) is shorter than
 * the waitFor hang guards (15s) and than a cold spawn can take on a loaded machine, so give these room:
 * a passing test still finishes the moment its condition holds — this only moves the hang guard.
 */
const SPAWN = { timeout: 60_000 };

const RESULT_LINE = JSON.stringify({ type: 'result', result: 'done', total_cost_usd: 0.01, num_turns: 1 });

/** A minimal AbortSignal stand-in that counts listener bookkeeping. */
function countingSignal(aborted = false) {
  const counts = { added: 0, removed: 0 };
  const signal = {
    aborted,
    addEventListener: () => counts.added++,
    removeEventListener: () => counts.removed++,
  } as unknown as AbortSignal;
  return { signal, counts };
}

for (const [label, run, base] of [
  ['runHarness', runHarness, claudeHarness],
  ['runAcpHarness', runAcpHarness, devinHarness],
] as const) {
  test(`${label}: an already-aborted signal rejects without ever spawning the harness`, SPAWN, async () => {
    // spawn needs the argv `buildArgs` returns, so zero calls proves no process was ever started —
    // no need to sleep and then check the child didn't leave a trace.
    let built = 0;
    const harness: Harness = {
      ...nodeHarness(base, 'process.exit(0)'),
      buildArgs: () => {
        built++;
        return ['-e', 'process.exit(0)'];
      },
    };
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(
      run({ harness, prompt: 'hi', cwd: process.cwd(), permission: 'readonly', signal: ac.signal }),
      /cancelled/,
    );
    assert.equal(built, 0, 'the harness process must not have been started');
  });
}

test('runHarness: the abort listener is removed once the run finishes', SPAWN, async () => {
  const harness = nodeHarness(claudeHarness, `console.log(${JSON.stringify(RESULT_LINE)})`);
  const { signal, counts } = countingSignal();
  // an explicit runner timeout under the test's own: a hang surfaces as a clear runner error
  const res = await runHarness({
    harness,
    prompt: 'hi',
    cwd: process.cwd(),
    permission: 'readonly',
    signal,
    timeoutMs: 30_000,
  });
  assert.equal(res.result, 'done');
  assert.equal(counts.added, 1);
  assert.equal(counts.removed, 1);
});

test('runHarness: the abort listener is removed when the run fails too', SPAWN, async () => {
  const harness = nodeHarness(claudeHarness, 'process.exit(3)');
  const { signal, counts } = countingSignal();
  await assert.rejects(
    runHarness({ harness, prompt: 'hi', cwd: process.cwd(), permission: 'readonly', signal, timeoutMs: 30_000 }),
    /exited with code 3/,
  );
  assert.equal(counts.added, 1);
  assert.equal(counts.removed, 1);
});

test('runAcpHarness: the abort listener is removed when the run ends', SPAWN, async () => {
  // exits immediately without speaking ACP — a failure path, which must clean up just the same
  const harness = nodeHarness(devinHarness, 'process.exit(2)');
  const { signal, counts } = countingSignal();
  await assert.rejects(
    runAcpHarness({ harness, prompt: 'hi', cwd: process.cwd(), permission: 'readonly', signal, timeoutMs: 30_000 }),
  );
  assert.equal(counts.added, 1);
  assert.equal(counts.removed, 1);
});

// ── runHarness: kill paths, caps, spawn failure ───────────────────────────

/** A child that records its pid and then never exits (and never prints a result). */
const hangScript = (pidFile: string) =>
  `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;

test('runHarness: the timeout kills a hung child and rejects with the timeout message', SPAWN, async () => {
  const pidFile = markerPath();
  try {
    await assert.rejects(
      runHarness({
        harness: nodeHarness(claudeHarness, hangScript(pidFile)),
        prompt: 'hi',
        cwd: process.cwd(),
        permission: 'readonly',
        timeoutMs: 400,
      }),
      /timed out after 400ms/,
    );
    // Not readPid: on a loaded machine the 400ms timeout can kill the child before it writes its pid.
    // The pid file's (unique) path is in the child's argv, so "no such process left" is the check.
    assert.ok(await waitForNoProcessWithArg(pidFile), 'child must be killed on timeout');
  } finally {
    rmMarker(pidFile);
  }
});

test('runHarness: aborting the signal mid-run kills the child and rejects as cancelled', SPAWN, async () => {
  const pidFile = markerPath();
  try {
    const ac = new AbortController();
    const run = runHarness({
      harness: nodeHarness(claudeHarness, hangScript(pidFile)),
      prompt: 'hi',
      cwd: process.cwd(),
      permission: 'readonly',
      timeoutMs: 20_000,
      signal: ac.signal,
    });
    const pid = await readPid(pidFile);
    ac.abort();
    await assert.rejects(run, /cancelled/);
    assert.ok(await waitForProcessExit(pid), 'child must be killed on abort');
  } finally {
    rmMarker(pidFile);
  }
});

test(
  'runHarness: streamed text is capped at 5MB with a truncation marker, and only kept text is forwarded',
  SPAWN,
  async () => {
    const { MAX_STREAMED_CHARS } = await import('../extensions/stream-caps.ts');
    // 7 x ~1MB text_delta lines, then a result with an empty `result` (so the runner falls back to the stream)
    const script = `
const delta = (t) => JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: t } } });
const chunk = 'x'.repeat(1024 * 1024 + 7); // not a divisor of 5MB, so one chunk straddles the cap
for (let i = 0; i < 7; i++) process.stdout.write(delta(chunk) + '\\n');
process.stdout.write(JSON.stringify({ type: 'result', result: '', num_turns: 1, total_cost_usd: 0 }) + '\\n');`;
    let forwarded = 0;
    const res = await runHarness({
      harness: nodeHarness(claudeHarness, script),
      prompt: 'hi',
      cwd: process.cwd(),
      permission: 'readonly',
      timeoutMs: 30_000,
      onStream: t => {
        forwarded += t.length;
      },
    });
    assert.ok(res.streamedText.startsWith('x'.repeat(1000)));
    assert.match(res.streamedText, /\[truncated \d+ chars\]$/);
    assert.ok(res.streamedText.length < MAX_STREAMED_CHARS + 100, `length ${res.streamedText.length}`);
    assert.equal(res.streamedText.replace(/ \[truncated \d+ chars\]$/, '').length, MAX_STREAMED_CHARS);
    assert.equal(forwarded, res.streamedText.length, 'onStream sees exactly what was kept');
  },
);

test('runHarness: activities are capped at 5000 (stored and forwarded)', SPAWN, async () => {
  const { MAX_ACTIVITIES } = await import('../extensions/stream-caps.ts');
  const script = `
const start = (i) => JSON.stringify({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 't' + i, name: 'Bash', input: {} } } });
let out = '';
for (let i = 0; i < ${MAX_ACTIVITIES + 250}; i++) out += start(i) + '\\n';
process.stdout.write(out);
process.stdout.write(JSON.stringify({ type: 'result', result: 'done', num_turns: 1, total_cost_usd: 0 }) + '\\n');`;
  let forwarded = 0;
  const res = await runHarness({
    harness: nodeHarness(claudeHarness, script),
    prompt: 'hi',
    cwd: process.cwd(),
    permission: 'readonly',
    timeoutMs: 30_000,
    onActivity: () => {
      forwarded++;
    },
  });
  assert.equal(res.result, 'done');
  assert.equal(forwarded, MAX_ACTIVITIES);
});

test('runHarness: a binary that does not exist rejects with a clear spawn error', SPAWN, async () => {
  const harness: Harness = { ...claudeHarness, binary: '/nonexistent/definitely-not-a-harness-binary' };
  await assert.rejects(
    runHarness({ harness, prompt: 'hi', cwd: process.cwd(), permission: 'readonly', timeoutMs: 5000 }),
    /failed to start \/nonexistent\/definitely-not-a-harness-binary: .*ENOENT/,
  );
});

test('runAcpHarness: a binary that does not exist rejects with a clear spawn error', SPAWN, async () => {
  const harness: Harness = { ...devinHarness, binary: '/nonexistent/definitely-not-an-acp-binary' };
  await assert.rejects(
    runAcpHarness({ harness, prompt: 'hi', cwd: process.cwd(), permission: 'readonly', timeoutMs: 5000 }),
    /failed to start \/nonexistent\/definitely-not-an-acp-binary: .*ENOENT/,
  );
});
