/**
 * Side-effect-free shared state for the `bun test` preload (tests/helpers/preload.ts). Tests import
 * *this* module — never the preload itself. Importing the preload from a test would run the pin as a
 * side effect of the import, so a run where bun never applied the preload (e.g. `bun test` started
 * from a directory without a `bunfig.toml` wiring it: bun reads it only from its cwd) would be silently
 * patched instead of failing. `tests/preload.test.ts` asserts on `preloadState()` so that case fails
 * loudly — when that file is part of the run.
 */
import { rmSync } from 'node:fs';

/** Prefix of the pinned agent dir's basename (`mkdtemp` under `os.tmpdir()`). */
export const PRELOAD_AGENT_DIR_PREFIX = 'pi-delegate-test-agent-';

/** What the preload recorded. Present only when the preload actually ran in this process. */
export interface PreloadState {
  /** The temp dir `PI_CODING_AGENT_DIR` is pinned to for the whole test process. */
  pinnedAgentDir: string;
  /** `PI_CODING_AGENT_DIR` as it was *before* the pin (the developer's outer env) — used only by the
   *  opt-in live suite, which must hand real harness CLIs their real agent dir. */
  outerAgentDir: string | undefined;
}

// A registered symbol, not an env var: the marker must not be something a test (or a child process
// inheriting the env) could set or clear by accident.
const PRELOAD_KEY = Symbol.for('pi-harness-delegate.test-preload');

type WithPreload = typeof globalThis & { [PRELOAD_KEY]?: PreloadState };

/** The preload's recorded state, or `undefined` when the preload did not run in this process. */
export function preloadState(): PreloadState | undefined {
  return (globalThis as WithPreload)[PRELOAD_KEY];
}

/** Called by the preload only. */
export function markPreloaded(state: PreloadState): void {
  (globalThis as WithPreload)[PRELOAD_KEY] = Object.freeze({ ...state });
}

/** Remove the pinned dir. Best-effort, idempotent, and always the dir captured at pin time — the
 *  caller passes it in; it is never re-read from `process.env`, which a test may have changed. */
export function removePinnedDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort: a leftover dir under os.tmpdir() is harmless
  }
}

/** Env values that only ever come from coercing `undefined`/`null` into `process.env`. */
export const COERCED_ENV_VALUES: ReadonlySet<string> = new Set(['undefined', 'null']);

/**
 * Whether `value` is what assigning `undefined`/`null` to `process.env` leaves behind. That differs by
 * runtime: node and bun 1.4.x coerce to the strings `"undefined"`/`"null"`; bun 1.3.14 (the version
 * `package.json` pins and CI runs) stores the raw non-string `undefined`/`null` — the key stays in
 * `process.env` (`'X' in process.env` is true) but reads as `undefined`/`null` and is dropped from a
 * spawned child's env. Both shapes count: a real env value is always a string.
 */
export function isCoercedEnvValue(value: unknown): boolean {
  return typeof value !== 'string' || COERCED_ENV_VALUES.has(value);
}

/**
 * Names of env vars holding a coerced value (`isCoercedEnvValue`) — except those still holding the very
 * same value they had in `baseline` (the outer env), so a var that was already `"null"` outside is
 * ignored only while unchanged: a test coercing it to `"undefined"` (or, on bun 1.3.14, to a raw
 * `undefined`) is still caught. Compared by value, never by name alone; presence counts too, so a key
 * absent from `baseline` never "matches" a present-but-`undefined` one.
 */
export function coercedEnvVars(env: NodeJS.ProcessEnv, baseline: NodeJS.ProcessEnv = {}): string[] {
  return Object.keys(env)
    .filter(name => isCoercedEnvValue(env[name]) && !(Object.hasOwn(baseline, name) && env[name] === baseline[name]))
    .sort();
}

/** How the backstop shows a coerced value: quoted when it's a string, bare when it's a raw non-string. */
export function showEnvValue(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

/** The signals the preload cleans up on before re-raising (each would otherwise kill the process
 *  without running `'exit'` handlers). */
export const CLEANUP_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/** The subset of `process` the cleanup registration needs — injectable so it can be unit-tested. */
export interface CleanupProcess {
  pid: number;
  on(event: string, listener: (signal: NodeJS.Signals) => void): unknown;
  off(event: string, listener: (signal: NodeJS.Signals) => void): unknown;
  kill(pid: number, signal: NodeJS.Signals): unknown;
  listenerCount(event: string): number;
}

/** The real `process`, behind the `CleanupProcess` shape. Delegating methods instead of passing
 *  `process` itself: tests/env-hygiene.test.ts bans aliasing `process` into a variable. */
function realProcess(): CleanupProcess {
  return {
    pid: process.pid,
    on: (event, listener) => process.on(event, listener),
    off: (event, listener) => process.off(event, listener),
    kill: (pid, signal) => process.kill(pid, signal),
    listenerCount: event => process.listenerCount(event),
  };
}

/**
 * Remove `dir` when the process ends: on `'exit'` (normal end of `bun test`, pass or fail) and on
 * SIGINT/SIGTERM/SIGHUP. A signal handler cleans up, removes *all* of these handlers (so the re-raise
 * below hits the default disposition instead of looping back here), then re-raises the same signal so
 * the process still dies by it — Ctrl-C is never swallowed and the exit status stays the conventional
 * 128+n. Cleanup runs at most once however many of these fire.
 *
 * Only when ours is the *sole* listener for that signal, though. Any other listener (another module's
 * `process.on('SIGINT', …)`) means the signal no longer kills the process by default — the re-raise
 * would only reach that listener, the run would carry on, and the pinned dir would already be gone
 * while `PI_CODING_AGENT_DIR` still points at it. So then the signal handler does nothing, and the
 * `'exit'` handler cleans up whenever the process does end (or a leftover dir stays under
 * `os.tmpdir()` if that listener kills it by a signal — harmless).
 *
 * Returns the (idempotent) cleanup itself, for an end-of-run hook: bun 1.3.14 (the version `package.json`
 * pins, so the one CI runs) never emits `'exit'` (nor `'beforeExit'`) at the end of `bun test`, so the
 * preload also runs this from a `bun:test` `afterAll`. bun 1.4.x emits `'exit'` as node does.
 */
export function registerPinnedDirCleanup(dir: string, proc: CleanupProcess = realProcess()): () => void {
  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    removePinnedDir(dir);
  };
  const detach = () => {
    proc.off('exit', cleanup);
    for (const sig of CLEANUP_SIGNALS) proc.off(sig, onSignal);
  };
  function onSignal(sig: NodeJS.Signals): void {
    if (proc.listenerCount(sig) > 1) return; // someone else handles this signal — leave it to 'exit'
    cleanup();
    detach();
    proc.kill(proc.pid, sig);
  }
  // 'exit' handlers must be synchronous — rmSync is.
  proc.on('exit', cleanup);
  for (const sig of CLEANUP_SIGNALS) proc.on(sig, onSignal);
  return cleanup;
}
