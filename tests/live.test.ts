/**
 * Opt-in live suite — spawns real, installed harness binaries end-to-end (a real process, a real
 * model turn, a real result) instead of replaying a fixture. This is the guard against the class
 * of bug that motivated it: two harnesses (`docs/acp-harness-assessment.md` #13, AGENTS.md
 * gotchas) once shipped `buildArgs` that were pure fiction — flags the real CLI rejected outright
 * — and nothing caught it because every existing test only exercises `parseLine`/`extractResult`
 * against a fixture that was itself hand-verified once. A fixture can never catch "this harness
 * can no longer even be spawned."
 *
 * Gated behind `PI_DELEGATE_LIVE=1` — it needs real binaries, real auth, and (for most harnesses)
 * real API spend, so it must never run in CI or `bun run verify`. See AGENTS.md's "Live
 * integration suite" section for how and when to run it.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { acpView, runAcpHarness } from '../extensions/acp-runner.ts';
import { getAllHarnesses } from '../extensions/harnesses/registry.ts';
import { runHarness } from '../extensions/runner.ts';

const LIVE = process.env.PI_DELEGATE_LIVE === '1';

if (!LIVE) {
  test('live harness suite (skipped — set PI_DELEGATE_LIVE=1 to run real spawns against installed harness binaries; see AGENTS.md)', () => {
    console.log(
      'Skipped: set PI_DELEGATE_LIVE=1 and run `bun test tests/live.test.ts` to exercise real installed harness ' +
        'binaries end-to-end. Costs real time and, for most harnesses, real API spend — never runs in CI or `bun run verify`.',
    );
  });
} else {
  const execFileAsync = promisify(execFile);
  const scratchDir = mkdtempSync(join(tmpdir(), 'pi-harness-delegate-live-'));
  const MARKER = 'quokka-nebula-live-check';
  writeFileSync(join(scratchDir, 'README.md'), `marker: ${MARKER}\n`);
  await execFileAsync('git', ['init', '-q'], { cwd: scratchDir });
  await execFileAsync('git', ['-c', 'user.email=live@test.local', '-c', 'user.name=live', 'add', '-A'], {
    cwd: scratchDir,
  });
  await execFileAsync(
    'git',
    ['-c', 'user.email=live@test.local', '-c', 'user.name=live', 'commit', '-q', '-m', 'init'],
    { cwd: scratchDir },
  );

  const PROMPT = 'Read README.md in this directory and reply with exactly the marker value it contains, nothing else.';

  // Which metrics each harness is *known* to genuinely report, per its default transport — from
  // docs/acp-harness-assessment.md's comparison table (§3) and the per-harness AGENTS.md notes.
  // Asserting a metric a harness never reports would make this suite fail on correct behavior;
  // not asserting one it does report would miss a real regression, so this table is the same
  // source of truth the fixture tests use, just applied to a live run instead of a replay.
  const REPORTS_COST = new Set(['claude']); // codex/devin: genuinely null. opencode/amp: partial — not asserted either way.
  const REPORTS_CONTEXT_WINDOW = new Set(['claude', 'devin']); // devin via its default 'acp' transport.
  const REPORTS_NUM_TURNS = new Set(['claude', 'codex', 'opencode', 'amp']); // devin: never observed populated.

  for (const harness of getAllHarnesses()) {
    test(`live: ${harness.name} runs a tiny read-only delegation`, async () => {
      const detected = await harness.detect();
      if (!detected.ok) {
        console.log(`skip ${harness.name}: not detected (${detected.hint ?? 'binary not found'})`);
        return;
      }

      const transport = harness.transport === 'acp' ? 'acp' : 'stdout';
      const run = transport === 'acp' ? runAcpHarness : runHarness;
      const runHarnessArg = transport === 'acp' ? acpView(harness) : harness;

      const result = await run({
        harness: runHarnessArg,
        prompt: PROMPT,
        cwd: scratchDir,
        permission: 'readonly',
        timeoutMs: 60_000,
      });

      assert.equal(result.isError, false, `expected a successful run, got: ${result.result}`);
      assert.ok(result.result.trim().length > 0, 'expected non-empty result text');
      assert.ok(
        typeof result.sessionId === 'string' && result.sessionId.length > 0,
        `expected a real sessionId, got: ${result.sessionId}`,
      );
      if (REPORTS_NUM_TURNS.has(harness.name)) {
        assert.ok(
          typeof result.numTurns === 'number' && result.numTurns >= 1,
          `expected a genuine numTurns for ${harness.name}, got: ${result.numTurns}`,
        );
      }
      if (REPORTS_COST.has(harness.name)) {
        assert.equal(
          typeof result.totalCostUsd,
          'number',
          `expected a real totalCostUsd for ${harness.name}, got: ${result.totalCostUsd}`,
        );
      }
      if (REPORTS_CONTEXT_WINDOW.has(harness.name)) {
        assert.equal(
          typeof result.contextWindow,
          'number',
          `expected a real contextWindow for ${harness.name}, got: ${result.contextWindow}`,
        );
      }
    });
  }
}
