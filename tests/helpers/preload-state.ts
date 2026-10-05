/**
 * Side-effect-free shared state for the `bun test` preload (tests/helpers/preload.ts). Tests import
 * *this* module — never the preload itself. Importing the preload from a test would run the pin as a
 * side effect of the import, so a run where bun never applied the preload (e.g. `bun test` started
 * from a subdirectory: bun reads `bunfig.toml` only from its cwd) would be silently patched instead of
 * failing. `tests/preload.test.ts` asserts on `preloadState()` so that case fails loudly.
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
