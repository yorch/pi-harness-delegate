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
 * minimize.
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
  /** Short current-activity text (tool call, "thinking…", or a text tail). Empty when queued/done. */
  activity: string;
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

      const hint = armed
        ? theme.fg('warning', 'press esc again to cancel all') + theme.fg('dim', ' · m minimize')
        : theme.fg('dim', 'esc cancel all') + theme.fg('dim', ' · m minimize');
      out.push(`│ ${padTo(hint, inner)} │`);

      out.push(theme.fg('accent', `╰${'─'.repeat(Math.max(1, width - 2))}╯`));
      return out;
    },
    handleInput(data: string): void {
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
