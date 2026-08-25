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
}

import { DEFAULT_TIMEOUT_MS } from './harnesses/types.ts';

export function runHarness(opts: RunHarnessOptions): Promise<HarnessResult> {
  return new Promise((resolve, reject) => {
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

    const finish = (r: StreamedResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const ttft = firstTokenAt !== null ? firstTokenAt - startAt : r.ttftMs;
      resolve({ ...r, ttftMs: ttft, streamedText: state.streamedText, harness: opts.harness.name });
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    };

    const rl = createInterface({ input: proc.stdout });
    rl.on('line', (line) => {
      const outcome = opts.harness.parseLine(line, state);
      if (outcome.streamedText) {
        if (firstTokenAt === null) firstTokenAt = Date.now();
        state.streamedText += outcome.streamedText;
        opts.onStream?.(outcome.streamedText);
      }
      if (outcome.activities) {
        for (const a of outcome.activities) {
          state.activities.push(a);
          opts.onActivity?.(a);
        }
      }
      if (outcome.result) {
        // merge streamedText into result if empty
        if (!outcome.result.result) outcome.result.result = state.streamedText;
        state.result = outcome.result;
      }
    });

    proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    proc.on('close', (code) => {
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
    proc.on('error', (err) => {
      fail(new Error(`failed to start ${opts.harness.binary}: ${err.message}`));
    });

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      fail(new Error(`${opts.harness.binary} timed out after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`));
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    timer.unref?.();

    opts.signal?.addEventListener(
      'abort',
      () => {
        proc.kill('SIGKILL');
        fail(new Error('cancelled'));
      },
      { once: true },
    );
  });
}
