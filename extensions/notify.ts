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

export class NotifyBatcher {
  private pending: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly emit: NotifyFn,
    private readonly debounceMs = 400,
  ) {}

  /** Queue a successful-completion line; flushes as one combined notification after a quiet period. */
  success(line: string): void {
    this.pending.push(line);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.debounceMs);
  }

  /** Flush any pending batch immediately, then emit this failure on its own — never delayed. */
  failure(line: string): void {
    this.flush();
    this.emit(line, 'error');
  }

  /** Emit whatever is pending as one notification, then clear it. No-op when nothing is pending. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending.length === 0) return;
    const lines = this.pending;
    this.pending = [];
    this.emit(joinBatch(lines), 'info');
  }
}
