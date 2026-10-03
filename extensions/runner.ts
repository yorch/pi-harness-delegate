import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Harness, ParseState, StreamedResult } from './harnesses/types.ts';

export interface RunHarnessOptions {
  harness: Harness;
  prompt: string;
  cwd: string;
  permission: import('./harnesses/types.ts').NormalizedPermission;
  nativePermission?: string;
  model?: string;
  maxBudgetUsd?: number;
  addDirs?: string[];
  signal?: AbortSignal;
  timeoutMs?: number;
  resumeSessionId?: string;
  onStream?: (text: string) => void;
  onActivity?: (ev: import('./harnesses/types.ts').ActivityEvent) => void;
}

export interface HarnessResult extends StreamedResult {
  streamedText: string;
  harness: string;
  /** Set when the runner itself killed the run for exceeding `maxBudgetUsd` (host enforcement). */
  budgetExceeded?: boolean;
}

/**
 * Host-side `maxBudgetUsd` enforcement for a harness with no native budget flag: true once the
 * harness's own streamed running total (`totalCostUsd`) goes over the cap. A harness that reports
 * no cost (`null`) can never trip this — `delegate()` flags that budget as unenforced instead.
 */
export function isOverBudget(
  harness: Harness,
  maxBudgetUsd: number | undefined,
  r: StreamedResult | null,
  baselineUsd = 0,
): boolean {
  return r !== null && isCostOverBudget(harness, maxBudgetUsd, r.totalCostUsd, baselineUsd);
}

/**
 * The cost-only core of `isOverBudget`. `baselineUsd` is subtracted first: a harness whose reported
 * total is *session*-cumulative (opencode over ACP) already includes every prior turn's spend on a
 * resume, so only the delta since this run started counts against this run's cap.
 */
export function isCostOverBudget(
  harness: Harness,
  maxBudgetUsd: number | undefined,
  costUsd: number | null | undefined,
  baselineUsd = 0,
): boolean {
  return (
    maxBudgetUsd !== undefined &&
    harness.nativeBudget !== true &&
    typeof costUsd === 'number' &&
    costUsd - baselineUsd > maxBudgetUsd
  );
}

/** The result recorded for a run the host stopped over budget. */
export function budgetStoppedResult(r: StreamedResult, streamedText: string): StreamedResult {
  return {
    ...r,
    isError: true,
    stopReason: 'budget_exceeded',
    result: r.result || streamedText || '(stopped: budget exceeded)',
  };
}

import { DEFAULT_TIMEOUT_MS } from './harnesses/types.ts';

export function runHarness(opts: RunHarnessOptions): Promise<HarnessResult> {
  return new Promise((resolve, reject) => {
    // Already cancelled (e.g. the user hit cancel while this run was still being set up) —
    // never spawn a process just to kill it.
    if (opts.signal?.aborted) {
      reject(new Error('cancelled'));
      return;
    }
    const args = opts.harness.buildArgs({
      prompt: opts.prompt,
      cwd: opts.cwd,
      permission: opts.permission,
      nativePermission: opts.nativePermission,
      model: opts.model,
      maxBudgetUsd: opts.maxBudgetUsd,
      addDirs: opts.addDirs,
      resumeSessionId: opts.resumeSessionId,
    });

    const proc = spawn(opts.harness.binary, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });

    const state: ParseState = { streamedText: '', activities: [], result: null, _harness: {} };
    let stderr = '';
    let settled = false;
    let firstTokenAt: number | null = null;
    const startAt = Date.now();
    const MAX_STREAMED = 5 * 1024 * 1024; // 5MB cap to prevent OOM on compromised harness
    const MAX_ACTIVITIES = 5000;

    const finish = (r: StreamedResult, budgetExceeded = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      const ttft = firstTokenAt !== null ? firstTokenAt - startAt : r.ttftMs;
      resolve({
        ...r,
        ttftMs: ttft,
        streamedText: state.streamedText,
        harness: opts.harness.name,
        ...(budgetExceeded ? { budgetExceeded: true } : {}),
      });
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      reject(err);
    };

    const rl = createInterface({ input: proc.stdout });
    rl.on('line', line => {
      const outcome = opts.harness.parseLine(line, state);
      if (outcome.streamedText) {
        if (firstTokenAt === null) firstTokenAt = Date.now();
        // Cap streamedText to prevent OOM on compromised harness
        if (state.streamedText.length < MAX_STREAMED) {
          const remaining = MAX_STREAMED - state.streamedText.length;
          const chunk =
            outcome.streamedText.length > remaining
              ? `${outcome.streamedText.slice(0, remaining)} [truncated ${outcome.streamedText.length - remaining} chars]`
              : outcome.streamedText;
          state.streamedText += chunk;
          opts.onStream?.(chunk);
        }
      }
      if (outcome.activities) {
        for (const a of outcome.activities) {
          if (state.activities.length < MAX_ACTIVITIES) {
            state.activities.push(a);
            opts.onActivity?.(a);
          }
        }
      }
      if (outcome.result) {
        // merge streamedText into result if empty
        if (!outcome.result.result) outcome.result.result = state.streamedText;
        state.result = outcome.result;
        if (!settled && isOverBudget(opts.harness, opts.maxBudgetUsd, state.result)) {
          proc.kill('SIGKILL');
          finish(budgetStoppedResult(state.result, state.streamedText), true);
        }
      }
    });

    proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    proc.on('close', code => {
      // Don't synthesize fallback on non-zero exit without explicit result — surface the error
      if (code !== 0 && !state.result) {
        fail(new Error(stderr.trim() || `${opts.harness.binary} exited with code ${code}`));
        return;
      }
      const final = opts.harness.extractResult(state);
      if (final) {
        if (!final.result) final.result = state.streamedText;
        finish(final);
      } else if (code !== 0) {
        fail(new Error(stderr.trim() || `${opts.harness.binary} exited with code ${code}`));
      } else {
        fail(new Error(`${opts.harness.binary} finished without emitting a result`));
      }
    });
    proc.on('error', err => {
      fail(new Error(`failed to start ${opts.harness.binary}: ${err.message}`));
    });

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      fail(new Error(`${opts.harness.binary} timed out after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`));
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    timer.unref?.();

    // Removed again in finish()/fail() — a long-lived signal (e.g. one shared by a fan-out, or the
    // tool call's own) must not accumulate a dead listener per run.
    function onAbort(): void {
      proc.kill('SIGKILL');
      fail(new Error('cancelled'));
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true });
  });
}
