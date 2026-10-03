import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runAcpHarness } from '../extensions/acp-runner.ts';
import { claudeHarness } from '../extensions/harnesses/claude.ts';
import { devinHarness } from '../extensions/harnesses/devin.ts';
import type { Harness } from '../extensions/harnesses/types.ts';
import { runHarness } from '../extensions/runner.ts';

/** A stdout harness that runs `node -e <script>` instead of a real CLI, parsed as Claude stream-json. */
function nodeHarness(base: Harness, script: string): Harness {
  return { ...base, binary: process.execPath, buildArgs: () => ['-e', script] };
}

function markerPath(): string {
  return join(tmpdir(), `runner-test-${Date.now()}-${Math.random().toString(36).slice(2)}.marker`);
}

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
  test(`${label}: an already-aborted signal rejects without ever spawning the harness`, async () => {
    const marker = markerPath();
    const harness = nodeHarness(base, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x')`);
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(
      run({ harness, prompt: 'hi', cwd: process.cwd(), permission: 'readonly', signal: ac.signal }),
      /cancelled/,
    );
    await new Promise(r => setTimeout(r, 150));
    assert.equal(existsSync(marker), false, 'the harness process must not have been started');
    rmSync(marker, { force: true });
  });
}

test('runHarness: the abort listener is removed once the run finishes', async () => {
  const harness = nodeHarness(claudeHarness, `console.log(${JSON.stringify(RESULT_LINE)})`);
  const { signal, counts } = countingSignal();
  const res = await runHarness({ harness, prompt: 'hi', cwd: process.cwd(), permission: 'readonly', signal });
  assert.equal(res.result, 'done');
  assert.equal(counts.added, 1);
  assert.equal(counts.removed, 1);
});

test('runHarness: the abort listener is removed when the run fails too', async () => {
  const harness = nodeHarness(claudeHarness, 'process.exit(3)');
  const { signal, counts } = countingSignal();
  await assert.rejects(runHarness({ harness, prompt: 'hi', cwd: process.cwd(), permission: 'readonly', signal }));
  assert.equal(counts.added, 1);
  assert.equal(counts.removed, 1);
});

test('runAcpHarness: the abort listener is removed when the run ends', async () => {
  // exits immediately without speaking ACP — a failure path, which must clean up just the same
  const harness = nodeHarness(devinHarness, 'process.exit(2)');
  const { signal, counts } = countingSignal();
  await assert.rejects(runAcpHarness({ harness, prompt: 'hi', cwd: process.cwd(), permission: 'readonly', signal }));
  assert.equal(counts.added, 1);
  assert.equal(counts.removed, 1);
});
