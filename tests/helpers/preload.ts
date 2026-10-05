/**
 * `bun test` preload (wired in `bunfig.toml`): runs once, before any test file, for the whole test process.
 * bun reads `bunfig.toml` only from its cwd, so run `bun test` from the repo root (`bun run test` works from
 * anywhere: package scripts run from the package root) —
 * `tests/preload.test.ts` fails loudly when this file did not run. Never import this file from a test:
 * shared constants/helpers live in the side-effect-free `./preload-state.ts`.
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
 * its *own* agent dir for auth/models), so tests/live.test.ts hands them `preloadState().outerAgentDir`
 * around each of its own runs only. An unfiltered `PI_DELEGATE_LIVE=1 bun test` therefore still runs
 * every other file pinned. (The preload can't tell which files a run will load: inside it,
 * `process.argv` names only the first test file, not the command line.)
 *
 * The write goes through `restoreEnv` (tests/helpers/env.ts), so this file needs no exemption from
 * `tests/env-hygiene.test.ts`.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { restoreEnv } from './env.ts';
import { markPreloaded, PRELOAD_AGENT_DIR_PREFIX, removePinnedDir } from './preload-state.ts';

const outerAgentDir = process.env.PI_CODING_AGENT_DIR;
const pinnedAgentDir = mkdtempSync(join(tmpdir(), PRELOAD_AGENT_DIR_PREFIX));
// 'exit' handlers must be synchronous — rmSync is. Bun fires 'exit' at the end of `bun test`, pass or fail.
process.on('exit', () => removePinnedDir(pinnedAgentDir));
restoreEnv('PI_CODING_AGENT_DIR', pinnedAgentDir);
markPreloaded({ pinnedAgentDir, outerAgentDir });
