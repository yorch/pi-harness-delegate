/**
 * The `delegate()` concurrency guard, factored out of index.ts so it's usable — and testable —
 * independent of the TUI.
 *
 * Combines the file-based cross-process registry (`run-registry.ts`) with an in-process counter
 * fallback (registry I/O failures never block a delegation). `acquireSlot()` is the single choke
 * point: `wait: false` preserves the original fail-fast behavior for ad-hoc single-harness runs
 * (throws immediately at capacity); `wait: true` polls until a slot frees, which is what turns a
 * fan-out into a bounded pool without a separate worker-pool abstraction — callers just kick off
 * all the harnesses at once and let `acquireSlot` serialize the ones that don't fit yet.
 */

import { type DelegateConfig, getMaxConcurrent } from './config.ts';
import { acquireRunWithinLimits, countActiveRuns, releaseRun } from './run-registry.ts';

const activeRuns = new Map<string, number>();
let globalActiveRuns = 0;

/** In-process active-run count (optionally filtered to one harness). Exposed for `/delegate status`. */
export function inProcessActiveCount(harness?: string): number {
  return harness ? (activeRuns.get(harness) ?? 0) : globalActiveRuns;
}

/** Active-run count combining the in-process counter with the cross-process registry (the max of
 *  the two — registry I/O failures fall back to the in-process view). */
export function activeCount(harness?: string): number {
  return Math.max(inProcessActiveCount(harness), countActiveRuns(harness));
}

/** Thrown by `acquireSlot({wait: false})` when at capacity. */
export class ConcurrencyLimitError extends Error {}

export interface AcquireSlotOptions {
  harness: string;
  mode: string;
  config: DelegateConfig;
  /** false (default): throw immediately at capacity. true: poll until a slot frees. */
  wait: boolean;
  /** Aborts a `wait: true` poll early. */
  signal?: AbortSignal;
  pollIntervalMs?: number;
  /** Source of the poll jitter (see `pollDelayMs`) — injectable so tests stay deterministic. */
  random?: () => number;
}

/** Max extra delay added to each poll, as a fraction of `pollIntervalMs`. */
export const POLL_JITTER_FRACTION = 0.25;

/**
 * One poll's wait: `pollIntervalMs` plus up to `POLL_JITTER_FRACTION` of it, at random. Without the
 * jitter, every waiter of a fan-out (all launched in the same tick) re-checks in lockstep, so they
 * keep hitting `acquireRunWithinLimits`'s write-then-recheck together — exactly the tight multi-way
 * race that makes contenders all back off at once (a transient under-admission). Spreading the
 * re-checks out breaks the lockstep. Pure given `random`.
 */
export function pollDelayMs(pollIntervalMs: number, random: () => number = Math.random): number {
  const r = Math.min(1, Math.max(0, random()));
  return pollIntervalMs + Math.floor(pollIntervalMs * POLL_JITTER_FRACTION * r);
}

function abortError(): Error {
  const err = new Error('aborted');
  err.name = 'AbortError';
  return err;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Acquire a concurrency slot for one delegate() run. Resolves with a release function (idempotent,
 * never throws) once a slot is held; the caller must call it exactly once when the run finishes.
 *
 * Checks the global limit before the per-harness limit — same precedence and error text as the
 * original inline guard, so single-run (`wait: false`) callers see unchanged behavior. Those two
 * checks are still a plain (racy) read, kept as a cheap fail-fast/error-message step; the actual
 * grant is `acquireRunWithinLimits()` (run-registry.ts), which re-verifies after registering so a
 * race lost between the check here and the write there is caught — see its doc comment. Losing
 * that race is handled exactly like losing the check above: throw (wait:false) or poll (wait:true).
 */
export async function acquireSlot(opts: AcquireSlotOptions): Promise<() => void> {
  const { harness, mode, config, wait, signal, pollIntervalMs = 200, random = Math.random } = opts;
  const pause = () => sleep(pollDelayMs(pollIntervalMs, random), signal);
  for (;;) {
    if (signal?.aborted) throw abortError();
    const maxGlobal = getMaxConcurrent(config);
    const globalCount = activeCount();
    if (maxGlobal > 0 && globalCount >= maxGlobal) {
      if (!wait) throw new ConcurrencyLimitError('another delegate run is already in progress (global limit)');
      await pause();
      continue;
    }
    const perHarnessLimit = getMaxConcurrent(config, harness);
    const perHarnessCount = activeCount(harness);
    if (perHarnessLimit > 0 && perHarnessCount >= perHarnessLimit) {
      if (!wait) throw new ConcurrencyLimitError(`another ${harness} run is already in progress`);
      await pause();
      continue;
    }

    const claim = acquireRunWithinLimits(harness, mode, maxGlobal, perHarnessLimit);
    if (claim.status === 'full') {
      // the check above passed, but another racer's write landed first and used up the slot —
      // handled exactly like hitting the cap on the check itself.
      if (!wait) throw new ConcurrencyLimitError(`another delegate run claimed the last available slot for ${harness}`);
      await pause();
      continue;
    }

    // In-process counters count only this process's own runs — never seed them from
    // `activeCount()` (which already folds in other processes' registry entries), or a foreign
    // run gets baked into our local count and outlives that run's own release.
    activeRuns.set(harness, (activeRuns.get(harness) ?? 0) + 1);
    globalActiveRuns++;
    const runHandle = claim.status === 'acquired' ? claim.handle : null;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      activeRuns.set(harness, Math.max(0, (activeRuns.get(harness) ?? 1) - 1));
      globalActiveRuns = Math.max(0, globalActiveRuns - 1);
      releaseRun(runHandle);
    };
  }
}
