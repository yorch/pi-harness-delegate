/**
 * The one way tests create temp directories (`tests/tmp-hygiene.test.ts` fails the suite on a direct
 * `mkdtemp`/`os.tmpdir()` elsewhere under tests/). A raw `mkdtempSync(join(tmpdir(), …))` is leaked the
 * moment a test forgets — or can't reach — its own cleanup (an assertion throws first, a helper returns
 * only a path inside the dir, a test is killed); thousands accumulated that way. `makeTempDir` creates
 * the dir *and records its exact path*, so:
 *
 *  - a test that owns the dir's lifetime may remove it itself (`removeTempDir` is preferred; a plain `rmSync`
 *    is tolerated too, because the registry records the dir's ownership token — see below);
 *  - the preload (tests/helpers/preload.ts) sweeps whatever is still registered at the end of the run
 *    (a `bun:test` `afterAll` — bun 1.3.14 never emits 'exit' after `bun test` — plus 'exit' and
 *    SIGINT/SIGTERM/SIGHUP via `registerPinnedDirCleanup`), so a forgotten call site is still cleaned.
 *
 * Deletion safety. Ownership is a MARKER, not a filesystem identity. `makeTempDir` writes a file named
 * `OWNER_MARKER` (mode 0600, flag 'wx') at the root of the new dir holding a random 128-bit token, and the
 * registry maps each canonical absolute path to that token. Removal and the sweep act ONLY on registered
 * entries (exact match after `path.resolve` normalisation — an unregistered path, a trailing-slash spelling
 * of a symlink, … is refused, never followed), and delete only if the path is still a real directory (lstat,
 * not a symlink) whose marker is a small regular file (lstat, not a symlink) holding exactly that token.
 * So a call site that removed its dir with a raw `rmSync` (leaving a dead entry) can never make the sweep
 * delete whatever later reuses the path: a vanished path is just unregistered, a path now holding something
 * else is left alone with one warning. Never a glob by prefix, never through a symlink, and never the outer
 * `PI_CODING_AGENT_DIR` (it isn't registered here).
 *
 * Why not `(dev, ino)`: on Linux (ext4/tmpfs) a directory created right after another was removed usually
 * gets the SAME inode number, so a foreign recreated dir looked "same" and was deleted (CI caught this; macOS/
 * APFS never reuses inode numbers, so it passed locally). Inode numbers, birthtimes and the like are not an
 * ownership proof; a token only the creating process knows is, on every filesystem. The marker is a visible
 * file in the dir root: a test that lists a `makeTempDir` root or uses it as a git work tree sees it
 * (`OWNER_MARKER` is exported for that).
 *
 * Side-effect free on import, like preload-state.ts: the registry hangs off a registered global symbol so
 * the preload and the tests share it however the module is loaded.
 */
import { randomBytes } from 'node:crypto';
import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

/** Name of the ownership marker file at the root of every `makeTempDir` directory. */
export const OWNER_MARKER = '.pi-delegate-tmp-owner';
const TOKEN_HEX_LENGTH = 32; // 16 random bytes

interface Registry {
  /** canonical absolute path -> the token written into that dir's marker */
  live: Map<string, string>;
  /** Canonical paths that were registered once and have been released (so a repeated `removeTempDir` is a no-op). */
  released: Set<string>;
}

const REGISTRY_KEY = Symbol.for('pi-harness-delegate.test-temp-dirs.v3');
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
 * Create a fresh directory `<tmpdir>/<prefix>XXXXXX` and register it (canonical absolute path + ownership token) for
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
  const token = randomBytes(16).toString('hex');
  try {
    writeFileSync(join(dir, OWNER_MARKER), token, { flag: 'wx', mode: 0o600 });
  } catch (err) {
    rmSync(dir, { recursive: true, force: true }); // never hand out a dir the sweep could not recognise as ours
    throw err;
  }
  registry().live.set(dir, token);
  registry().released.delete(dir);
  return dir;
}

type Standing = 'gone' | 'same' | 'foreign';

/** What is at `path` now, relative to the directory we registered: nothing, our marked directory, or something else. */
function standing(path: string, token: string): Standing {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(path); // lstat: a symlink (even to our own dir) is never "the same directory"
  } catch {
    return 'gone';
  }
  if (!st.isDirectory()) return 'foreign';
  try {
    const marker = lstatSync(join(path, OWNER_MARKER));
    if (!marker.isFile() || marker.size !== TOKEN_HEX_LENGTH) return 'foreign';
    return readFileSync(join(path, OWNER_MARKER), 'utf8') === token ? 'same' : 'foreign';
  } catch {
    return 'foreign'; // a directory with no readable marker is not the one we made
  }
}

function release(path: string): void {
  registry().live.delete(path);
  registry().released.add(path);
}

/** Remove one canonical, registered path if (and only if) it is still our directory. True when still registered after. */
function removeRegistered(path: string): boolean {
  const token = registry().live.get(path);
  if (token === undefined) return false;
  const now = standing(path, token);
  if (now === 'gone') {
    release(path);
    return false;
  }
  if (now === 'foreign') {
    release(path);
    process.emitWarning(
      `tests/helpers/tmp.ts: ${path} is no longer the temp dir that was registered there (replaced, recreated or its owner marker is gone); leaving it alone`,
    );
    return false;
  }
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // reported by the sweep if it is still there at the end of the run
  }
  if (standing(path, token) !== 'gone') return true;
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
