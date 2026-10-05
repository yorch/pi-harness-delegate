/**
 * The one ordering "newest" means for CHOOSING a run — shared by `/delegate history`, `/delegate rerun` and
 * fan-out resume. By transcript modification time, newest first, the file name breaking ties so the order
 * is total. An mtime in the FUTURE is not evidence of recency: anyone who can write the outputs directory
 * can also set a file's mtime (`utimes`), and a future-dated file would otherwise outrank every real run
 * (making `rerun` pick it). So a future-dated file (past a clock-skew allowance) sorts AFTER every file with
 * a believable time — it is treated as no newer than "now" and ranked behind the real ones.
 *
 * That demotion is for SELECTION only. `pruneOutputs` DELETES files, and deleting by that ranking would turn
 * a clock stepped back a minute (the newest real runs are then "in the future") into the loss of exactly
 * those transcripts, so pruning uses `pruneOrder` instead: a future mtime is clamped to `now`, never ranked
 * last.
 */

/**
 * How far ahead of the clock an mtime may be (clock skew between machines sharing a directory, an NTP step,
 * coarse file-system timestamps) and still count as a real time: five minutes.
 */
export const FUTURE_SKEW_MS = 5 * 60_000;

/** `pruneOutputs` never deletes a file modified within this long of now (either side): a run still being written, or a concurrent one's. */
export const PRUNE_PROTECT_MS = 2 * 60_000;

/** True when `mtimeMs` is further in the future than clock skew explains. */
export function isFutureDated(mtimeMs: number, now: number = Date.now()): boolean {
  return mtimeMs > now + FUTURE_SKEW_MS;
}

/** `mtimeMs` as an ordering key: never later than `now`. */
export function effectiveMtime(mtimeMs: number, now: number = Date.now()): number {
  return Math.min(mtimeMs, now);
}

/** Newest first; future-dated files last (by name among themselves); the file name breaks ties. For choosing a run — never for deleting one. */
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

/** Newest first for PRUNING: a future mtime counts as `now` (no demotion), the file name breaking ties. */
export function pruneOrder(
  a: { mtimeMs: number; name: string },
  b: { mtimeMs: number; name: string },
  now: number = Date.now(),
): number {
  const ta = effectiveMtime(a.mtimeMs, now);
  const tb = effectiveMtime(b.mtimeMs, now);
  return tb - ta || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0);
}

/** True when `mtimeMs` is within `PRUNE_PROTECT_MS` of `now` on either side. */
export function isRecentForPrune(mtimeMs: number, now: number = Date.now()): boolean {
  return Math.abs(now - mtimeMs) < PRUNE_PROTECT_MS;
}
