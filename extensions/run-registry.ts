/**
 * File-based active-run registry — makes the concurrency guard and `/delegate status`
 * active count accurate across pi processes, not just the current one.
 *
 * One small JSON file per active run in `<agentDir>/delegate/runs/`. Best-effort throughout:
 * registry I/O failures never break a delegation — callers should combine this with their own
 * in-process counters as a fallback.
 *
 * `acquireRun()` + `countActiveRuns()` alone are a plain check-then-act pair: read the count,
 * decide, write — with no lock between the read and the write, so two pi processes starting at
 * the same instant can both observe a count under the limit and both proceed, over-admitting for
 * the full lifetime of both runs. `acquireRunWithinLimits()` below closes that specific window by
 * re-verifying *after* writing: a write that turns out to push either count over its limit is
 * undone immediately, so the cap can never be permanently exceeded — see its own doc comment for
 * exactly what guarantee that is (and isn't). Callers that don't need the cap enforced — `/delegate
 * status`'s display, or a caller happy with the plain best-effort behavior — can still use
 * `acquireRun`/`countActiveRuns` directly.
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentDir } from './config.ts';

function runsDir(): string {
  return join(agentDir(), 'delegate', 'runs');
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH: no such process. EPERM: exists but we can't signal it — still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface RunHandle {
  file: string;
}

/** Register an active run. Returns null (never throws) if the registry can't be written. */
export function acquireRun(harness: string, mode: string): RunHandle | null {
  try {
    const dir = runsDir();
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${process.pid}-${harness}-${Math.random().toString(36).slice(2, 8)}.json`);
    writeFileSync(file, JSON.stringify({ pid: process.pid, harness, mode, startedAt: Date.now() }));
    return { file };
  } catch {
    return null;
  }
}

/** Release a previously-acquired run. Best-effort — never throws. */
export function releaseRun(handle: RunHandle | null): void {
  if (!handle) return;
  try {
    rmSync(handle.file, { force: true });
  } catch {
    // best-effort
  }
}

/** Count active runs across processes (optionally filtered to one harness), cleaning up
 *  entries left behind by dead processes. Returns 0 (never throws) if the registry is unreadable. */
export function countActiveRuns(harness?: string): number {
  let files: string[];
  try {
    files = readdirSync(runsDir());
  } catch {
    return 0;
  }
  let count = 0;
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const full = join(runsDir(), f);
    try {
      const data = JSON.parse(readFileSync(full, 'utf8')) as { pid: number; harness: string };
      if (typeof data.pid === 'number' && isAlive(data.pid)) {
        if (!harness || data.harness === harness) count++;
      } else {
        rmSync(full, { force: true }); // stale (dead pid) or corrupt (non-numeric pid)
      }
    } catch {
      try {
        rmSync(full, { force: true }); // corrupt entry
      } catch {
        // best-effort
      }
    }
  }
  return count;
}

export type AcquireWithinLimitsResult =
  | { status: 'acquired'; handle: RunHandle }
  /** Writing succeeded, but the run would push a limit over the top — undone, nothing held. */
  | { status: 'full' }
  /** Registry I/O failed — best-effort, same as `acquireRun` returning null: caller should fall
   *  back to in-process-only accounting and proceed rather than block the run. */
  | { status: 'unavailable' };

/**
 * Register an active run, then atomically-in-effect verify it's still within `maxGlobal` and
 * `maxPerHarness` (either `<= 0` means "no limit" for that dimension) — undoing the registration
 * if not. This turns the classic count-then-act race into a write-then-recheck one: because the
 * recheck happens strictly *after* the write is committed to disk, whichever of two racing
 * processes writes last is guaranteed to see both entries and correctly back off — over-admission
 * (more than the limit standing at once) is impossible by construction, unlike plain
 * `countActiveRuns()` + `acquireRun()`.
 *
 * This is not a perfect mutex, and doesn't try to be: in a tight enough multi-way race, more than
 * one contender can each write, then each see the other's (or others') entry when it rechecks, and
 * each concludes it's over the limit and backs off — even though exactly one of them could have
 * fit. That's a transient *under*-admission (self-heals on the caller's next attempt, e.g. via
 * `acquireSlot({wait: true})`'s poll loop) — the property this function actually guarantees is
 * that the limit is never exceeded, not that it's always saturated.
 */
export function acquireRunWithinLimits(
  harness: string,
  mode: string,
  maxGlobal: number,
  maxPerHarness: number,
): AcquireWithinLimitsResult {
  const handle = acquireRun(harness, mode);
  if (!handle) return { status: 'unavailable' };
  const overGlobal = maxGlobal > 0 && countActiveRuns() > maxGlobal;
  const overHarness = maxPerHarness > 0 && countActiveRuns(harness) > maxPerHarness;
  if (overGlobal || overHarness) {
    releaseRun(handle);
    return { status: 'full' };
  }
  return { status: 'acquired', handle };
}
