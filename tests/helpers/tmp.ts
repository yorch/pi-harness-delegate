/**
 * The one way tests create temp directories (`tests/tmp-hygiene.test.ts` fails the suite on a direct
 * `mkdtemp`/`os.tmpdir()` elsewhere under tests/). A raw `mkdtempSync(join(tmpdir(), …))` is leaked the
 * moment a test forgets — or can't reach — its own cleanup (an assertion throws first, a helper returns
 * only a path inside the dir, a test is killed); thousands accumulated that way. `makeTempDir` creates
 * the dir *and records its exact path*, so:
 *
 *  - a test that owns the dir's lifetime still removes it itself (`removeTempDir`, usually in `finally`);
 *  - the preload (tests/helpers/preload.ts) sweeps whatever is still registered at the end of the run
 *    (a `bun:test` `afterAll` — bun 1.3.14 never emits 'exit' after `bun test` — plus 'exit' and
 *    SIGINT/SIGTERM/SIGHUP via `registerPinnedDirCleanup`), so a forgotten call site is still cleaned.
 *
 * The sweep removes only paths this process handed out (never a glob by prefix, so it can't touch another
 * tool's or another run's dirs), never follows a symlink (`rmSync` unlinks a link instead of descending
 * into it), and never touches the outer `PI_CODING_AGENT_DIR` (it isn't registered here).
 *
 * Side-effect free on import, like preload-state.ts: the registry hangs off a registered global symbol so
 * the preload and the tests share it however the module is loaded.
 */
import { existsSync, lstatSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REGISTRY_KEY = Symbol.for('pi-harness-delegate.test-temp-dirs');
type WithRegistry = typeof globalThis & { [REGISTRY_KEY]?: Set<string> };

function registry(): Set<string> {
  const existing = (globalThis as WithRegistry)[REGISTRY_KEY];
  if (existing) return existing;
  const created = new Set<string>();
  (globalThis as WithRegistry)[REGISTRY_KEY] = created;
  return created;
}

/** The directory temp dirs are created under (what `os.tmpdir()` returns). */
export function tempRoot(): string {
  return tmpdir();
}

const CLOSED_KEY = Symbol.for('pi-harness-delegate.test-temp-dirs-closed');

/**
 * Refuse further `makeTempDir` calls. The preload calls this right before its final sweep: after a SIGINT/
 * SIGTERM the process only dies on the next event-loop turn, so a test still in flight could otherwise
 * create a dir *after* the sweep ran and nothing would ever remove it (seen: a signal mid-run leaked the
 * dirs the next few tests created).
 */
export function closeTempDirs(): void {
  (globalThis as WithRegistry & { [CLOSED_KEY]?: boolean })[CLOSED_KEY] = true;
}

/** Create a fresh directory `<tmpdir>/<prefix>XXXXXX` and register it for the end-of-run sweep. */
export function makeTempDir(prefix: string): string {
  if ((globalThis as WithRegistry & { [CLOSED_KEY]?: boolean })[CLOSED_KEY]) {
    throw new Error(`makeTempDir(${prefix}): the run is shutting down (signal or end of run); not creating temp dirs`);
  }
  const dir = mkdtempSync(join(tmpdir(), prefix));
  registry().add(dir);
  return dir;
}

/** Remove `dir` (recursively, never following a symlink) and unregister it. Best-effort, idempotent. */
export function removeTempDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // reported by the sweep if it is still there at the end of the run
  }
  if (!pathExists(dir)) registry().delete(dir);
}

/** Dirs handed out by `makeTempDir` and not yet removed. */
export function trackedTempDirs(): string[] {
  return [...registry()];
}

/**
 * Remove every registered dir. Returns the ones that are *still there* afterwards (permission problem,
 * a stuck mount) — the caller decides how loudly to complain. Idempotent. `dirs` narrows the sweep (tests
 * only); a path that was never registered is still removed if listed, so never pass one you don't own.
 */
export function sweepTempDirs(dirs: readonly string[] = trackedTempDirs()): string[] {
  const stuck: string[] = [];
  for (const dir of dirs) {
    removeTempDir(dir);
    if (pathExists(dir)) stuck.push(dir);
  }
  return stuck;
}

function pathExists(p: string): boolean {
  try {
    lstatSync(p); // lstat: a dangling or replaced symlink still counts as "something is there"
    return true;
  } catch {
    return existsSync(p);
  }
}
