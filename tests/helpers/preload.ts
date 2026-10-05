/**
 * `bun test` preload (wired in `bunfig.toml` and `tests/bunfig.toml`): runs once, before any test file, for
 * the whole test process. bun reads `bunfig.toml` only from its cwd, so run `bun test` from the repo root or
 * `tests/` (`bun run test` works from anywhere: package scripts run from the package root). From anywhere
 * else this file does not run at all — nothing is pinned — and only `tests/preload.test.ts` notices (it
 * fails loudly), so a run that doesn't include it passes silently, unpinned. Never import this file from
 * a test: shared constants/helpers live in the side-effect-free `./preload-state.ts`.
 *
 * Safety net for `PI_CODING_AGENT_DIR`. Tests that need an isolated agent dir set their own via
 * `withEnv` / `withSandbox`, but a delegate run that outlives its sandbox (a straggling child, a late
 * timer) resolves `agentDir()` from whatever the var is *after* the restore. Without this, a correct
 * delete-when-unset restore leaves it unset, and that straggler writes transcripts, run-registry
 * entries and settings reads into the developer's real `~/.pi/agent`. Pinning it here to a fresh temp
 * dir makes "unset" impossible for the duration of `bun test`: every `withEnv` restore lands back on
 * this temp dir, never on the real one.
 *
 * Unconditional — an outer `PI_CODING_AGENT_DIR` (which may well point at a real agent dir) is
 * overridden too, and live mode (`PI_DELEGATE_LIVE=1`) is no exception. The live suite needs the outer
 * value for the real harness CLIs it spawns (`omp`, the `amp` harness, reads `PI_CODING_AGENT_DIR` as
 * its *own* agent dir for auth/models), so tests/live.test.ts hands their child processes
 * `preloadState().outerAgentDir` via a synchronous swap (`withEnvSync`) around just the spawning call —
 * the test process is re-pinned before the run is awaited. An unfiltered `PI_DELEGATE_LIVE=1 bun test`
 * therefore still runs every other file pinned. (The preload can't tell which files a run will load: inside it,
 * `process.argv` names only the first test file, not the command line.)
 *
 * The pinned dir is removed when the process ends: on 'exit' (end of `bun test`, pass or fail) and on
 * SIGINT/SIGTERM/SIGHUP, which otherwise kill bun without running 'exit' handlers. The signal is
 * re-raised after cleanup, so Ctrl-C still stops the run with the conventional 128+n status — unless
 * something else also listens for that signal (then the signal doesn't end the run, so the dir is left
 * for the 'exit' handler; see `registerPinnedDirCleanup`).
 *
 * Runtime backstop for the `process.env.X = prev` restore bug (`tests/env-hygiene.test.ts` is the
 * primary, static guard): after every test, any env var whose value is exactly `"undefined"` or `"null"`
 * — what assigning `undefined`/`null` to `process.env` stores — fails that test and is removed, so the
 * failure lands on the first offending test instead of cascading. A var that already held such a value
 * in the outer env is ignored only while it still holds that same value (compared by value, not name),
 * and is put back to it. It is a backstop, not a proof: a test that coerces and cleans up within
 * its own body, or a write that lands after its test's `afterEach`, slips past it.
 *
 * Every env write here goes through `restoreEnv` (tests/helpers/env.ts), so this file needs no
 * exemption from `tests/env-hygiene.test.ts`.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'node:test';
import { restoreEnv } from './env.ts';
import { coercedEnvVars, markPreloaded, PRELOAD_AGENT_DIR_PREFIX, registerPinnedDirCleanup } from './preload-state.ts';

const outerAgentDir = process.env.PI_CODING_AGENT_DIR;
const pinnedAgentDir = mkdtempSync(join(tmpdir(), PRELOAD_AGENT_DIR_PREFIX));
registerPinnedDirCleanup(pinnedAgentDir);
restoreEnv('PI_CODING_AGENT_DIR', pinnedAgentDir);
markPreloaded({ pinnedAgentDir, outerAgentDir });

// The outer env, by value — a var already "undefined"/"null" outside is ignored only while unchanged.
const outerEnv: NodeJS.ProcessEnv = { ...process.env };
afterEach(() => {
  const bad = coercedEnvVars({ ...process.env }, outerEnv);
  if (bad.length === 0) return;
  const shown = bad.map(name => `${name}=${JSON.stringify(process.env[name])}`).join(', ');
  for (const name of bad) restoreEnv(name, outerEnv[name]); // back to the outer value, or unset
  throw new Error(
    `env backstop (tests/helpers/preload.ts): this test left ${shown} in process.env — almost certainly ` +
      '`process.env.X = prev` with prev undefined/null. Use withEnv()/restoreEnv() from tests/helpers/env.ts.',
  );
});
