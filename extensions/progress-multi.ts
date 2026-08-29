/**
 * Live progress window for a concurrent multi-harness `/delegate all` fan-out — one overlay
 * showing every run as a compact row (harness, elapsed, current activity, done/failed marker)
 * instead of N stacked overlays or one feed with interleaved lines from different harnesses.
 *
 * Single-harness runs keep using `progressWindow` in progress.ts unchanged — this is only
 * mounted for a fan-out. Shares `fmtElapsed` with it; deliberately not merged into one generic
 * layout framework since the two views render fundamentally different things (one live feed vs
 * N row summaries).
 *
 * Controls: same as progressWindow — ESC twice to cancel (aborts every in-flight run), `m` to
 * minimize. Once every row is terminal, a single Esc or `m` instead dismisses immediately (see
 * `isFanoutComplete`) rather than arming/minimizing, since there's nothing left to cancel.
 */

import type { Theme } from '@earendil-works/pi-coding-agent';
import { type Component, Key, matchesKey, type TUI, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { fmtElapsed } from './progress.ts';

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPIN_INTERVAL_MS = 100;

export type RunStatus = 'queued' | 'running' | 'done' | 'failed';

export interface RunRow {
  harness: string;
  /** Set once the run has acquired its concurrency slot and started executing; null while queued. */
  startedAt: number | null;
  status: RunStatus;
  /**
   * Short current-activity text (tool call, "thinking…", or a text tail). Empty when queued or
   * done; on a failed run it holds the failure reason (or the last activity seen), so the row
   * still says *why* rather than going blank at the moment that matters most.
   */
  activity: string;
  /** Cost reported once the run completes successfully; null while queued/running/failed, or when
   *  the harness didn't report one. Feeds the chip's aggregate spend figure. */
  costUsd: number | null;
}

export interface MultiProgressWindowOptions {
  /** Mode name shown in the title bar (e.g. "review"). */
  mode: string;
  /** Epoch ms when the fan-out started — drives the overall elapsed timer. */
  startedAt: number;
  /** Live per-harness row state. */
  getRows: () => RunRow[];
  /** Show an "unrestricted permissions" warning banner. */
  dangerous?: boolean;
  /** Called when the user confirms cancel — must abort every in-flight run. */
  onCancel: () => void;
  /** Called when the user presses `m` (minimize — runs continue in the background). */
  onMinimize: () => void;
  /**
   * Called when the user presses Esc or `m` while every row is already terminal — i.e. during the
   * post-completion linger, before the caller tears the overlay down on its own timer. Lets a user
   * who's still watching dismiss the finished board immediately instead of waiting it out. Optional
   * so existing callers/tests that don't care about the linger keep working.
   */
  onDismiss?: () => void;
}

/** True once every row has reached a terminal state — the fan-out is fully done. Pure — testable
 *  without a TUI. Used to gate the post-completion dismiss-on-any-key behavior. */
export function isFanoutComplete(rows: RunRow[]): boolean {
  return rows.length > 0 && rows.every(r => r.status === 'done' || r.status === 'failed');
}

/** Per-status glyphs, matching the row markers in the overlay so the chip and the window read alike. */
const CHIP_GLYPHS: ReadonlyArray<readonly [RunStatus, string]> = [
  ['done', '✓'],
  ['failed', '✗'],
  ['running', '▶'],
  ['queued', '…'],
];

/**
 * Compact fan-out status-bar summary, e.g. `1✓ 1✗ 1▶ 1… · ⏱ 0:42 · $0.123`. Zero status counts are
 * omitted, so the common cases stay short (`4▶`, then `4✓`); the aggregate spend segment is
 * likewise omitted until at least one run has actually reported a cost. Counting only `running` —
 * as the first cut did — renders `0/4 running`, which reads as idle when runs have actually failed
 * or are queued behind the cap. `elapsedMs` is passed in (rather than read via `Date.now()`
 * internally) so this stays pure and testable without a TUI.
 */
export function formatFanoutChip(rows: RunRow[], elapsedMs: number): string {
  const parts = CHIP_GLYPHS.map(([status, glyph]) => {
    const n = rows.filter(r => r.status === status).length;
    return n > 0 ? `${n}${glyph}` : null;
  }).filter((s): s is string => s !== null);
  const statusText = parts.length > 0 ? parts.join(' ') : `${rows.length}…`;

  const costs = rows.map(r => r.costUsd).filter((c): c is number => typeof c === 'number');
  const totalCost = costs.length > 0 ? costs.reduce((sum, c) => sum + c, 0) : null;

  const segments = [statusText, `⏱ ${fmtElapsed(elapsedMs)}`];
  if (totalCost !== null) segments.push(`$${totalCost.toFixed(3)}`);
  return segments.join(' · ');
}

/** One row's marker + label, e.g. "✓ claude" / "✗ codex" / "⠋ opencode" / "… amp". Pure — testable
 *  without a TUI/theme. */
export function renderRowLabel(row: RunRow, frame: number): string {
  const mark =
    row.status === 'done'
      ? '✓'
      : row.status === 'failed'
        ? '✗'
        : row.status === 'running'
          ? SPINNER[frame % SPINNER.length]
          : '…';
  return `${mark} ${row.harness}`;
}

/** Create the multi-run overlay component; disposes the spinner timer. */
export function multiProgressWindow(
  tui: TUI,
  theme: Theme,
  opts: MultiProgressWindowOptions,
): Component & { dispose(): void } {
  let frame = 0;
  let armed = false;
  let armTimer: ReturnType<typeof setTimeout> | null = null;
  const timer = setInterval(() => {
    frame++;
    tui.requestRender();
  }, SPIN_INTERVAL_MS);

  const disarm = () => {
    armed = false;
    if (armTimer) {
      clearTimeout(armTimer);
      armTimer = null;
    }
  };

  return {
    render(width: number): string[] {
      const inner = Math.max(10, width - 4);
      const padTo = (s: string, w: number) => `${s}${' '.repeat(Math.max(1, w - visibleWidth(s)))}`;
      const out: string[] = [];
      const rows = opts.getRows();

      const done = rows.filter(r => r.status === 'done' || r.status === 'failed').length;
      const title = `${SPINNER[frame % SPINNER.length]} delegate all · ${opts.mode} · ${done}/${rows.length}`;
      const status = `⏱ ${fmtElapsed(Date.now() - opts.startedAt)}`;
      const titleStr = `${title} · ${status}`;
      const dash = '─'.repeat(Math.max(1, inner - visibleWidth(titleStr) - 2));
      out.push(theme.fg('accent', `╭─ ${titleStr} ${dash}─╮`));

      if (opts.dangerous) {
        const banner = theme.fg('error', '⚠ danger — unrestricted access');
        out.push(`│ ${padTo(banner, inner)} │`);
      }

      for (const row of rows) {
        const label = renderRowLabel(row, frame);
        const styledLabel =
          row.status === 'done'
            ? theme.fg('success', label)
            : row.status === 'failed'
              ? theme.fg('error', label)
              : theme.fg('accent', label);
        const elapsed = row.startedAt !== null ? fmtElapsed(Date.now() - row.startedAt) : 'queued';
        const activity = row.activity ? ` ${theme.fg('muted', row.activity)}` : '';
        const line = `${styledLabel} ${theme.fg('dim', elapsed)}${activity}`;
        out.push(`│ ${padTo(truncateToWidth(line, inner), inner)} │`);
      }

      const hint = isFanoutComplete(rows)
        ? theme.fg('dim', 'esc/m dismiss')
        : armed
          ? theme.fg('warning', 'press esc again to cancel all') + theme.fg('dim', ' · m minimize')
          : theme.fg('dim', 'esc cancel all') + theme.fg('dim', ' · m minimize');
      out.push(`│ ${padTo(hint, inner)} │`);

      out.push(theme.fg('accent', `╰${'─'.repeat(Math.max(1, width - 2))}╯`));
      return out;
    },
    handleInput(data: string): void {
      // Once every run has reached a terminal state, the overlay is just lingering on the
      // finished board before the caller closes it on a timer — any Esc/m here dismisses it right
      // away instead of making a user who's still watching wait out the linger.
      if (isFanoutComplete(opts.getRows()) && opts.onDismiss) {
        if (matchesKey(data, Key.escape) || data === 'm') {
          disarm();
          opts.onDismiss();
        }
        return;
      }
      if (matchesKey(data, Key.escape)) {
        if (armed) {
          disarm();
          opts.onCancel();
        } else {
          armed = true;
          armTimer = setTimeout(() => {
            armed = false;
            armTimer = null;
            tui.requestRender();
          }, 1500);
          tui.requestRender();
        }
      } else if (data === 'm') {
        disarm();
        opts.onMinimize();
      }
    },
    invalidate(): void {
      // stateless render — nothing to clear
    },
    dispose(): void {
      clearInterval(timer);
      disarm();
    },
  };
}
