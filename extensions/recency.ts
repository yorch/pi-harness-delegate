/**
 * The one ordering "newest" means — shared by `/delegate history`, `/delegate rerun`, fan-out resume and
 * `pruneOutputs`. By transcript modification time, newest first, the file name breaking ties so the order
 * is total. An mtime in the FUTURE is not evidence of recency: anyone who can write the outputs directory
 * can also set a file's mtime (`utimes`), and a future-dated file would otherwise outrank every real run
 * (making `rerun` pick it) and outlast them in pruning (a flood of them used to make every new real
 * transcript the oldest, so it was deleted right after it was written). So a future-dated file (past a
 * small clock-skew allowance) sorts AFTER every file with a believable time — it is treated as no newer
 * than "now" and ranked behind the real ones.
 */

/** How far ahead of the clock an mtime may be (clock skew, coarse file-system timestamps) and still count. */
export const FUTURE_SKEW_MS = 5_000;

/** True when `mtimeMs` is further in the future than clock skew explains. */
export function isFutureDated(mtimeMs: number, now: number = Date.now()): boolean {
  return mtimeMs > now + FUTURE_SKEW_MS;
}

/** `mtimeMs` as an ordering key: never later than `now`. */
export function effectiveMtime(mtimeMs: number, now: number = Date.now()): number {
  return Math.min(mtimeMs, now);
}

/** Newest first; future-dated files last (by name among themselves); the file name breaks ties. */
export function newestFirst(
  a: { mtimeMs: number; name: string },
  b: { mtimeMs: number; name: string },
  now: number = Date.now(),
): number {
  const fa = isFutureDated(a.mtimeMs, now);
  const fb = isFutureDated(b.mtimeMs, now);
  if (fa !== fb) return fa ? 1 : -1;
  const ta = effectiveMtime(a.mtimeMs, now);
  const tb = effectiveMtime(b.mtimeMs, now);
  return tb - ta || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0);
}
