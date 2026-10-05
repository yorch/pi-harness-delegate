/**
 * What a terminal really shows of a pi dialog, in BOTH of pi's layouts — built from pi's own components:
 *
 * - regular mode: the dialog is the bottom-anchored tail of the document, followed by the footer; the terminal
 *   shows the last `rows` rows of everything;
 * - fullscreen mode: pi's real `VStack` dock (pending, status, widgets, editor container, footer — the same
 *   `shrink` / `minSize` it uses) under a transcript `ScrollView`, laid out by pi-tui's own `renderLayoutFrame`;
 *   when the dock is taller than the screen it clips the BOTTOM of the dialog.
 *
 * `status` (the working loader: a blank row plus its line) and `footer` rows are parameters: the layout's row
 * budget has to hold for the worst case it assumes (status 3, footer 3) and the common one (0 and 2).
 */
import { ExtensionSelectorComponent, initTheme } from '@earendil-works/pi-coding-agent';
import { Container, ScrollView, stripTerminalSequences, Text, VStack } from '@earendil-works/pi-tui';
// (pi-tui ships no `exports` map: the layout entry point is reached by path)
import { renderLayoutFrame } from '../../node_modules/@earendil-works/pi-tui/dist/layout.js';

let themed = false;

export type ScreenMode = 'regular' | 'fullscreen';
export interface Chrome {
  /** Rows of the working status above the dialog (a loader renders a blank row + its line). */
  status: number;
  /** Rows of pi's footer below it. */
  footer: number;
}
/** The chrome the layout's budget is built for (`DIALOG_SPARE_ROWS`), and the common smaller one. */
export const WORST_CHROME: Chrome = { status: 3, footer: 3 };
export const COMMON_CHROME: Chrome = { status: 0, footer: 2 };

function rowsOf(prefix: string, n: number, pad: number): Container {
  const c = new Container();
  for (let i = 0; i < n; i++) c.addChild(new Text(i === 0 && prefix === 'status' ? '' : `${prefix} ${i}`, pad, 0));
  return c;
}

/** The rows on a `columns` x `rows` terminal while a confirmation (`title`, `message`) is up. */
export function screenOf(
  mode: ScreenMode,
  title: string,
  message: string,
  columns: number,
  rows: number,
  chrome: Chrome = WORST_CHROME,
): string[] {
  if (!themed) {
    initTheme('dark');
    themed = true;
  }
  const dialog = new ExtensionSelectorComponent(
    `${title}\n${message}`,
    ['Yes', 'No'],
    () => {},
    () => {},
  );
  const clean = (lines: string[]): string[] => lines.map(l => stripTerminalSequences(l).trimEnd());
  if (mode === 'regular')
    return clean([
      ...Array.from({ length: 80 }, (_, i) => `transcript ${i}`),
      ...rowsOf('status', chrome.status, 1).render(columns),
      ...dialog.render(columns),
      ...rowsOf('footer', chrome.footer, 0).render(columns),
    ]).slice(-rows);
  const doc = new Container();
  for (let i = 0; i < 80; i++) doc.addChild(new Text(`transcript ${i}`, 0, 0));
  const editor = new Container();
  editor.addChild(dialog);
  const dock = new VStack([
    { component: new Container(), shrink: 1, minSize: 0 },
    { component: rowsOf('status', chrome.status, 1), shrink: 1, minSize: 0 },
    { component: new Container(), shrink: 1, minSize: 0 },
    { component: editor, shrink: 1, minSize: 3 },
    { component: new Container(), shrink: 1, minSize: 0 },
    { component: rowsOf('footer', chrome.footer, 0), shrink: 1, minSize: 1 },
  ]);
  const root = new VStack([
    { component: new ScrollView(doc, { follow: 'end', primary: true }), basis: 0, grow: 1, shrink: 1, minSize: 1 },
    { component: dock, basis: 'auto', grow: 0, shrink: 1, minSize: 1 },
  ]);
  return clean(renderLayoutFrame(root, columns, rows, () => {}).lines as string[]);
}

export const SCREEN_MODES: ScreenMode[] = ['regular', 'fullscreen'];
