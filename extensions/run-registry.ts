/**
 * File-based active-run registry — makes the concurrency guard and `/delegate status`
 * active count accurate across pi processes, not just the current one.
 *
 * One small JSON file per active run in `<agentDir>/delegate/runs/`. Best-effort throughout:
 * registry I/O failures never break a delegation — callers should combine this with their own
 * in-process counters as a fallback.
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
      if (typeof data.pid !== 'number' || isAlive(data.pid)) {
        if (!harness || data.harness === harness) count++;
      } else {
        rmSync(full, { force: true }); // stale — owning process is gone
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
