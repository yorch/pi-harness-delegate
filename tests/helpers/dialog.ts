/**
 * The ground truth for "what is on screen": pi's own `ExtensionSelectorComponent` (what `ctx.ui.confirm` shows)
 * rendered at a given width, so a test measures real wrapping, tab width, CJK width and frame rows instead of
 * counting newlines. The terminal shows the LAST `rows` rows of it (the dialog is bottom-anchored).
 */
import { ExtensionSelectorComponent, initTheme } from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences } from '@earendil-works/pi-tui';
import type { ConfirmLayout, Viewport } from '../../extensions/confirm-layout.ts';

let themed = false;

export interface RenderedDialog {
  /** Every row of the dialog, ANSI-stripped, trailing blanks trimmed. */
  all: string[];
  /** The rows a terminal of `viewport.rows` rows actually shows. */
  visible: string[];
}

export function renderDialog(title: string, message: string, viewport: Viewport): RenderedDialog {
  if (!themed) {
    initTheme('dark');
    themed = true;
  }
  const c = new ExtensionSelectorComponent(
    `${title}\n${message}`,
    ['Yes', 'No'],
    () => {},
    () => {},
  );
  const all = c.render(viewport.columns).map(l => stripTerminalSequences(l).trimEnd());
  return { all, visible: all.slice(-viewport.rows) };
}

export { withViewport } from './viewport.ts';

/** `text` with every wrap point (`\n  ┆ `) joined back, so a test can look for a string a long line split across rows. */
export function unwrap(text: string): string {
  return text.replace(/\n {2}┆ /g, '');
}

/** The text of a successful layout with its wrap points joined back (fails the test on a refusal). */
export function textOf(layout: ConfirmLayout): string {
  if (!layout.ok) throw new Error(`layout refused: ${layout.reason}`);
  return unwrap(layout.lines.join('\n'));
}
