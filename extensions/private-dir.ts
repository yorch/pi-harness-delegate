import { chmodSync, lstatSync, mkdirSync } from 'node:fs';

const warned = new Set<string>();

/**
 * Create `dir` (and parents) and make it owner-only (`0700`) — unless `dir` is a SYMBOLIC LINK. `chmod`
 * follows links, so asserting `0700` on a symlinked outputs directory would change the permissions of
 * whatever it points at (a shared or system directory). A symlinked directory is used as it is: its
 * target is left alone and a warning (once per directory) says it should be private. Throws only when the directory
 * cannot be created at all (`mkdirSync`'s own error — nothing could be written there anyway); every later step is best-effort.
 */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let link = false;
  try {
    link = lstatSync(dir).isSymbolicLink();
  } catch {
    // vanished — nothing to chmod
    return;
  }
  if (link) {
    if (!warned.has(dir)) {
      warned.add(dir);
      process.emitWarning(
        `pi-harness-delegate: ${JSON.stringify(dir)} is a symbolic link — its target's permissions are left alone; make sure the real directory is private (transcripts hold prompts, diffs and harness output)`,
      );
    }
    return;
  }
  try {
    chmodSync(dir, 0o700);
  } catch {
    // best-effort — e.g. a dir owned by someone else; the file modes still apply
  }
}
