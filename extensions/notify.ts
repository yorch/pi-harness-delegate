/**
 * Batches successful fan-out completion notifications so `/delegate all …` emits one
 * notification instead of one per harness. Failures are never delayed or batched — they
 * flush any pending batch and are emitted immediately. Confined to the notification path;
 * not a general event system.
 */

export type NotifyLevel = 'info' | 'warning' | 'error';
export type NotifyFn = (text: string, level: NotifyLevel) => void;

/** Pure joiner for a batch of success lines — testable without timers. */
export function joinBatch(lines: string[]): string {
  if (lines.length === 1) return lines[0];
  return `${lines.length} runs completed:\n${lines.map(l => `  · ${l}`).join('\n')}`;
}

/** The timer primitives the batcher schedules its debounce with — injectable so tests can drive a
 *  fake clock instead of sleeping for real. */
export interface BatcherTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const REAL_TIMERS: BatcherTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class NotifyBatcher {
  private pending: string[] = [];
  private timer: unknown = null;

  constructor(
    private readonly emit: NotifyFn,
    private readonly debounceMs = 400,
    private readonly timers: BatcherTimers = REAL_TIMERS,
  ) {}

  /** Queue a successful-completion line; flushes as one combined notification after a quiet period. */
  success(line: string): void {
    this.pending.push(line);
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = this.timers.set(() => this.flush(), this.debounceMs);
  }

  /** Flush any pending batch immediately, then emit this failure on its own — never delayed. */
  failure(line: string): void {
    this.flush();
    this.emit(line, 'error');
  }

  /** Emit whatever is pending as one notification, then clear it. No-op when nothing is pending. */
  flush(): void {
    if (this.timer !== null) {
      this.timers.clear(this.timer);
      this.timer = null;
    }
    if (this.pending.length === 0) return;
    const lines = this.pending;
    this.pending = [];
    this.emit(joinBatch(lines), 'info');
  }
}
