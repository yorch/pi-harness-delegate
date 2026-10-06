/**
 * The one way tests create temp directories (`tests/tmp-hygiene.test.ts` fails the suite on a direct
 * `mkdtemp`/`os.tmpdir()` elsewhere under tests/). A raw `mkdtempSync(join(tmpdir(), …))` is leaked the
 * moment a test forgets — or can't reach — its own cleanup (an assertion throws first, a helper returns
 * only a path inside the dir, a test is killed); thousands accumulated that way. `makeTempDir` creates
 * the dir *and records its exact path*, so:
 *
 *  - a test that owns the dir's lifetime may remove it itself (`removeTempDir` is preferred; a plain `rmSync`
 *    is tolerated too, because the registry records the dir's identity — see below);
 *  - the preload (tests/helpers/preload.ts) sweeps whatever is still registered at the end of the run
 *    (a `bun:test` `afterAll` — bun 1.3.14 never emits 'exit' after `bun test` — plus 'exit' and
 *    SIGINT/SIGTERM/SIGHUP via `registerPinnedDirCleanup`), so a forgotten call site is still cleaned.
 *
 * Deletion safety. The registry maps each canonical absolute path to the `(dev, ino)` the directory had when
 * it was created. Removal and the sweep act ONLY on registered entries (exact match after `path.resolve`
 * normalisation — an unregistered path, a trailing-slash spelling of a symlink, … is refused, never
 * followed), and delete only if the path is still a real directory (not a symlink) with that same identity.
 * So a call site that removed its dir with a raw `rmSync` (leaving a dead entry) can never make the sweep
 * delete whatever later reuses the path: a vanished path is just unregistered, a path now holding something
 * else is left alone with one warning. Never a glob by prefix, never through a symlink, and never the outer
 * `PI_CODING_AGENT_DIR` (it isn't registered here).
 *
 * Side-effect free on import, like preload-state.ts: the registry hangs off a registered global symbol so
 * the preload and the tests share it however the module is loaded.
 */
import { lstatSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

interface Identity {
  dev: number;
  ino: number;
}
interface Registry {
  live: Map<string, Identity>;
  /** Canonical paths that were registered once and have been released (so a repeated `removeTempDir` is a no-op). */
  released: Set<string>;
}

const REGISTRY_KEY = Symbol.for('pi-harness-delegate.test-temp-dirs.v2');
type WithRegistry = typeof globalThis & { [REGISTRY_KEY]?: Registry };

function registry(): Registry {
  const existing = (globalThis as WithRegistry)[REGISTRY_KEY];
  if (existing) return existing;
  const created: Registry = { live: new Map(), released: new Set() };
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

/**
 * Create a fresh directory `<tmpdir>/<prefix>XXXXXX` and register it (canonical absolute path + identity) for
 * the end-of-run sweep. Throws if `tmpdir()` is not absolute: a relative `TMPDIR` would make the registered
 * path mean something different after a `chdir`.
 */
export function makeTempDir(prefix: string): string {
  if ((globalThis as WithRegistry & { [CLOSED_KEY]?: boolean })[CLOSED_KEY]) {
    throw new Error(`makeTempDir(${prefix}): the run is shutting down (signal or end of run); not creating temp dirs`);
  }
  const root = tmpdir();
  if (!isAbsolute(root))
    throw new Error(`makeTempDir(${prefix}): the temp root ${JSON.stringify(root)} is not absolute`);
  const dir = resolve(mkdtempSync(join(root, prefix)));
  const st = lstatSync(dir);
  registry().live.set(dir, { dev: st.dev, ino: st.ino });
  registry().released.delete(dir);
  return dir;
}

type Standing = 'gone' | 'same' | 'foreign';

/** What is at `path` now, relative to the directory we registered: nothing, that very directory, or something else. */
function standing(path: string, id: Identity): Standing {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(path); // lstat: a symlink (even to our own dir) is never "the same directory"
  } catch {
    return 'gone';
  }
  return st.isDirectory() && st.dev === id.dev && st.ino === id.ino ? 'same' : 'foreign';
}

function release(path: string): void {
  registry().live.delete(path);
  registry().released.add(path);
}

/** Remove one canonical, registered path if (and only if) it is still our directory. True when still registered after. */
function removeRegistered(path: string): boolean {
  const id = registry().live.get(path);
  if (!id) return false;
  const now = standing(path, id);
  if (now === 'gone') {
    release(path);
    return false;
  }
  if (now === 'foreign') {
    release(path);
    process.emitWarning(
      `tests/helpers/tmp.ts: ${path} is no longer the temp dir that was registered there (replaced or recreated); leaving it alone`,
    );
    return false;
  }
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // reported by the sweep if it is still there at the end of the run
  }
  if (standing(path, id) !== 'gone') return true;
  release(path);
  return false;
}

/**
 * Remove `dir` (recursively) and unregister it. Best-effort and idempotent for a dir that was registered.
 * Only acts on a registered path (exact match after normalising trailing slashes / `..`, never through a
 * symlink) whose directory is still the one created there; anything else is left alone. Throws for a path
 * `makeTempDir` never handed out — that is a programmer error, not something to delete.
 */
export function removeTempDir(dir: string): void {
  const path = resolve(dir);
  const { live, released } = registry();
  if (!live.has(path)) {
    if (released.has(path)) return;
    throw new Error(`removeTempDir(${dir}): not a directory created by makeTempDir (refusing to delete it)`);
  }
  removeRegistered(path);
}

/** Dirs handed out by `makeTempDir` and not yet removed (canonical absolute paths). */
export function trackedTempDirs(): string[] {
  return [...registry().live.keys()];
}

/**
 * Remove every registered dir. Returns the ones that are *still there* afterwards (permission problem,
 * a stuck mount) — the caller decides how loudly to complain. Idempotent. `dirs` narrows the sweep (tests
 * only); a path that was never registered is ignored with a warning, never removed.
 */
export function sweepTempDirs(dirs: readonly string[] = trackedTempDirs()): string[] {
  const stuck: string[] = [];
  for (const dir of dirs) {
    const path = resolve(dir);
    if (!registry().live.has(path)) {
      if (!registry().released.has(path))
        process.emitWarning(`tests/helpers/tmp.ts: ignoring unregistered path ${dir}`);
      continue;
    }
    if (removeRegistered(path)) stuck.push(path);
  }
  return stuck;
}
