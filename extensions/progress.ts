/**
 * Live progress window for /delegate runs — a framed overlay showing the
 * activity feed, thinking indicator and text tail while the delegation runs.
 *
 * Controls:
 *   - ESC twice: cancel (first press arms, second confirms within 1.5s)
 *   - `m`: minimize (hide the window, run continues in the background;
 *     re-show with /delegate watch)
 */

import type { Theme } from '@earendil-works/pi-coding-agent';
import { type Component, Key, matchesKey, type TUI, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPIN_INTERVAL_MS = 100;
const MAX_VISIBLE_ENTRIES = 12;

export type FeedEntry =
  | { kind: 'tool'; text: string; ok?: boolean }
  | { kind: 'thinking'; text: string }
  | { kind: 'text'; text: string };

export interface ProgressWindowOptions {
  /** Harness name shown in title. */
  harness?: string;
  /** Mode name, shown in the title bar (e.g. "review"). */
  mode: string;
  /** Model (or alias) shown in the title bar. */
  model?: string | null;
  /** Epoch ms when the run started — drives the live elapsed timer. */
  startedAt: number;
  /** Live feed entries (tool calls, thinking, text tail). */
  getEntries: () => FeedEntry[];
  /** Show an "unrestricted permissions" warning banner. */
  dangerous?: boolean;
  /** Called when the user confirms cancel. */
  onCancel: () => void;
  /** Called when the user presses `m` (minimize — keep the run going). */
  onMinimize: () => void;
}

export function fmtElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `0:${String(s).padStart(2, '0')}`;
}

/** Style one feed entry; the returned string may contain ANSI colors. */
export function renderEntry(entry: FeedEntry, theme: Theme): string {
  switch (entry.kind) {
    case 'tool': {
      const mark = entry.ok === undefined ? '' : entry.ok ? theme.fg('success', ' ✓') : theme.fg('error', ' ✗');
      return theme.fg('accent', '▶ ') + theme.fg('muted', entry.text) + mark;
    }
    case 'thinking':
      return theme.fg('dim', entry.text);
    case 'text':
      return theme.fg('text', entry.text);
  }
}

/** Create the overlay component; disposes the spinner timer. */
export function progressWindow(tui: TUI, theme: Theme, opts: ProgressWindowOptions): Component & { dispose(): void } {
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

      // title bar: ⠋ <harness> <mode> · <model> · ⏱ elapsed
      const harness = opts.harness ?? 'delegate';
      const title = `${SPINNER[frame % SPINNER.length]} ${harness} ${opts.mode}`;
      const status = [opts.model ?? '', `⏱ ${fmtElapsed(Date.now() - opts.startedAt)}`].filter(Boolean).join(' · ');
      const titleStr = status ? `${title} · ${status}` : title;
      const dash = '─'.repeat(Math.max(1, inner - visibleWidth(titleStr) - 2));
      out.push(theme.fg('accent', `╭─ ${titleStr} ${dash}─╮`));

      // danger banner
      if (opts.dangerous) {
        const banner = theme.fg('error', '⚠ danger — unrestricted access');
        out.push(`│ ${padTo(banner, inner)} │`);
      }

      // feed
      for (const entry of opts.getEntries().slice(-MAX_VISIBLE_ENTRIES)) {
        out.push(`│ ${padTo(truncateToWidth(renderEntry(entry, theme), inner), inner)} │`);
      }

      // hint row (double-ESC guard + minimize)
      const hint = armed
        ? theme.fg('warning', 'press esc again to cancel') + theme.fg('dim', ' · m minimize')
        : theme.fg('dim', 'esc cancel') + theme.fg('dim', ' · m minimize');
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
