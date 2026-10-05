/**
 * `bun test` preload (wired in `bunfig.toml`): runs once, before any test file, for the whole test process.
 *
 * Safety net for `PI_CODING_AGENT_DIR`. Tests that need an isolated agent dir set their own via `withEnv`
 * / `withSandbox`, but a delegate run that outlives its sandbox (a straggling child, a late timer)
 * resolves `agentDir()` from whatever the var is *after* the restore. Without this, a correct
 * delete-when-unset restore leaves it unset, and that straggler writes transcripts, run-registry
 * entries and settings reads into the developer's real `~/.pi/agent`. Pinning it here to a fresh temp
 * dir makes "unset" impossible for the duration of `bun test`: every `withEnv` restore lands back on
 * this temp dir, never on the real one.
 *
 * Unconditional — an outer `PI_CODING_AGENT_DIR` (which may well point at a real agent dir) is
 * overridden too. The one exception is the opt-in live suite (`PI_DELEGATE_LIVE=1`): spawned harness
 * children inherit the env, and `omp` (the `amp` harness) reads `PI_CODING_AGENT_DIR` as its *own*
 * agent dir (auth, models), so pinning it would make the live `amp` run fail for a reason unrelated to
 * this repo. Live runs therefore keep the outer environment as-is.
 *
 * The write goes through `restoreEnv` (tests/helpers/env.ts), so this file needs no exemption from
 * `tests/env-hygiene.test.ts`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { restoreEnv } from './env.ts';

/** Prefix of the pinned dir's basename — `tests/preload.test.ts` asserts on it. */
export const PRELOAD_AGENT_DIR_PREFIX = 'pi-delegate-test-agent-';

if (process.env.PI_DELEGATE_LIVE !== '1') {
  const dir = mkdtempSync(join(tmpdir(), PRELOAD_AGENT_DIR_PREFIX));
  restoreEnv('PI_CODING_AGENT_DIR', dir);
  // 'exit' handlers must be synchronous — rmSync is. Bun fires 'exit' at the end of `bun test`,
  // pass or fail.
  process.on('exit', () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort: a leftover dir under os.tmpdir() is harmless
    }
  });
}
