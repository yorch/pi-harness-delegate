/**
 * How a confirmation body is laid out so that what a person must see is what is on screen.
 *
 * pi shows `ctx.ui.confirm(title, message)` as a bottom-anchored selector (`ExtensionSelectorComponent`):
 * a border, a spacer, the title and the message in ONE `Text` (padding 1 on each side, tabs = 3 columns,
 * word-wrapped to the terminal width), a spacer, `Yes` / `No`, a spacer, a hint, a spacer, a border.
 * It does not scroll: a message taller than the terminal pushes its own TOP off the screen. So the body is
 * built bottom-up:
 *
 * 1. the free-text blocks (task, scope) come FIRST — they are the part that may be long, and the part that
 *    may lose its top;
 * 2. the CRITICAL SECTION comes last, immediately above Yes/No: what will run (the DANGER / target line,
 *    members, tiers, who started it) and every steering field (session, pr, model, budget, timeout, addDirs,
 *    verify, …), then the one-line size summaries. Nothing critical ever sits before a free-text block.
 *
 * Everything is measured with pi-tui's own `visibleWidth` against the REAL terminal (`process.stdout.columns`
 * / `.rows`) and wrapped HERE, at the real width, by hard column breaks, with every continuation row prefixed
 * (`  ┆ `) — so a wrapped row can never pass for an unprefixed summary / marker line, and pi never re-wraps
 * (every row already fits). A terminal narrower than `MIN_COLUMNS` (40: the width of pi's own hint row) is
 * REFUSED, saying its real size; an unknown size is taken to be `DEFAULT_COLUMNS` x `DEFAULT_ROWS` (80x24 — the
 * small side, so nothing is hidden on a real 24-row screen). The free-text blocks get a row budget — the
 * terminal's rows minus the critical section and the chrome (`DIALOG_FRAME_ROWS` + `DIALOG_SPARE_ROWS`: the
 * frame plus the footer / status rows pi keeps below and above a dialog, in regular AND fullscreen mode) — and
 * when they do not fit, a model-set value is REFUSED, a human-typed one is shown as head + tail with a "not
 * shown" marker. A critical section that does not fit is refused outright.
 *
 * The critical section is kept short on purpose (one headline row, one `will apply` row, one row per optional
 * field, one size-summary row when the text is shown whole) so ordinary requests fit a 24-row terminal.
 */

import { ExtensionSelectorComponent } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import { charCount, escapeForDisplay, MAX_COMBINING_RUN, unitEscape } from './sanitize.ts';

export interface Viewport {
  columns: number;
  rows: number;
}

/**
 * The narrowest terminal a confirmation is shown on: pi's hint row (`↑↓ navigate  enter select  esc cancel`, 37
 * columns + its 2 padding) fits from 40 columns, so pi itself never re-wraps below the message. Narrower is refused.
 */
export const MIN_COLUMNS = 40;
/** Columns assumed when the terminal's width is unknown (no TTY). */
export const DEFAULT_COLUMNS = 80;
/** Rows assumed when the terminal's height is unknown (no TTY): a real 24-row screen must not lose its Yes / No. */
export const DEFAULT_ROWS = 24;
/** What pi's selector adds around the message: border, spacer, title row, spacer, Yes, No, spacer, hint, spacer, border. */
export const DIALOG_FRAME_ROWS = 10;
/**
 * Slack for what pi keeps around the dialog: its footer (2 rows, 3 with an extension status line) and, in
 * fullscreen, the working status above it (up to 3) next to the transcript's own minimum row. Checked against
 * pi's real regular and fullscreen layouts with the 3 + 3 worst case (`tests/helpers/screen.ts`): with 12 rows of
 * chrome the whole dialog from its title to the hint is on screen in both modes.
 */
export const DIALOG_SPARE_ROWS = 2;
/** The least a free-text block may be given when it is cut (header, one row, the "not shown" marker, one row). */
export const MIN_BLOCK_ROWS = 4;
/** The fewest rows left for the free-text blocks (header + a row + one more) before a confirmation is refused. */
export const MIN_TEXT_ROWS = 3;
/** Text longer than this (in UTF-16 units) is refused before it is even measured — a person cannot review it anyway. */
export const MAX_MEASURED_CHARS = 100_000;

const BLOCK_PREFIX = '  > ';
/** Starts every continuation row of a wrapped line — a row of the text can never begin like one. */
export const CONTINUATION_PREFIX = '  ┆ ';

/**
 * The real terminal: `process.stdout.columns` x `process.stdout.rows` — as they are, no floor (a terminal below
 * `MIN_COLUMNS` is refused by `layoutConfirmation`, with its real size in the message); `DEFAULT_COLUMNS` /
 * `DEFAULT_ROWS` when unknown (undefined, 0, NaN, non-numeric).
 */
export function currentViewport(): Viewport {
  const c = process.stdout.columns;
  const r = process.stdout.rows;
  return {
    columns: typeof c === 'number' && Number.isFinite(c) && c > 0 ? Math.floor(c) : DEFAULT_COLUMNS,
    rows: typeof r === 'number' && Number.isFinite(r) && r > 0 ? Math.floor(r) : DEFAULT_ROWS,
  };
}

/** Columns a message row may fill: pi's `Text` pads one column on each side (never measured below `MIN_COLUMNS`). */
export function contentWidth(vp: Viewport): number {
  return Math.max(MIN_COLUMNS, vp.columns) - 2;
}

/** Columns pi's own hint row (`↑↓ navigate  enter select  escape/ctrl+c cancel`, default keys) needs, padding included. */
const DEFAULT_HINT_COLUMNS = 49;

/**
 * The rows pi's selector adds around the message at `columns` — measured on pi's own component (a one-row title:
 * border, spacer, title, spacer, Yes, No, spacer, hint, spacer, border), so a hint row that pi wraps on a narrow
 * terminal (49 columns with the default keys, more with longer custom ones) is counted. Falls back to the
 * default-key arithmetic when the component cannot be built (pi's theme not initialised).
 */
export function dialogFrameRows(columns: number): number {
  try {
    return new ExtensionSelectorComponent(
      'x',
      ['Yes', 'No'],
      () => {},
      () => {},
    ).render(Math.max(1, columns)).length;
  } catch {
    return DIALOG_FRAME_ROWS - 1 + Math.max(1, Math.ceil((DEFAULT_HINT_COLUMNS - 2) / Math.max(1, columns - 2)));
  }
}

/** Message rows that are on screen once the frame (and the slack for pi's footer / status rows) is accounted for. */
export function messageRowBudget(vp: Viewport): number {
  return Math.max(0, vp.rows - dialogFrameRows(vp.columns) - DIALOG_SPARE_ROWS);
}

// ── Display rows ────────────────────────────────────────────────────────────────────────────────

interface Row {
  text: string;
  /** Characters of the source text this row shows. */
  chars: number;
}

const widthCache = new Map<string, number>();
function unitWidth(s: string): number {
  let w = widthCache.get(s);
  if (w === undefined) {
    w = visibleWidth(s);
    if (widthCache.size < 4096) widthCache.set(s, w);
  }
  return w;
}

const COMBINING_RE = /\p{M}/u;

/** `line` as display units — what `escapeForDisplay` would show, one entry per source character, tabs as pi's 3 columns. */
function toUnits(line: string): { s: string; w: number }[] {
  const out: { s: string; w: number }[] = [];
  let run = 0;
  for (const cp of line) {
    let s: string;
    if (cp === '\t') {
      s = '   ';
      run = 0;
    } else {
      s = escapeForDisplay(cp);
      if (s === cp && COMBINING_RE.test(cp)) {
        run++;
        if (run > MAX_COMBINING_RUN) s = unitEscape(cp);
      } else run = 0;
    }
    out.push({ s, w: unitWidth(s) });
  }
  return out;
}

/**
 * `line` (no newline) cut into rows — the first of at most `firstWidth` columns, the others of at most `width`.
 * Hard breaks at the column; with `soft`, a row that has a space in its last third ends after that space instead
 * (the space stays at the end of the row, so joining the rows gives the line back exactly).
 */
function wrapLine(line: string, width: number, soft = false, firstWidth = width): Row[] {
  const rows: Row[] = [];
  let cur: { s: string; w: number }[] = [];
  let curW = 0;
  const limit = (): number => (rows.length === 0 ? firstWidth : width);
  const push = (units: { s: string; w: number }[]): void => {
    rows.push({ text: units.map(u => u.s).join(''), chars: units.length });
  };
  for (const u of toUnits(line)) {
    if (curW + u.w > limit() && cur.length > 0) {
      let cut = cur.length;
      if (soft) {
        const at = cur.map(x => x.s).lastIndexOf(' ');
        const restW = cur.slice(at + 1).reduce((n, x) => n + x.w, 0);
        // (only when what carries over still fits a continuation row together with the unit that overflowed)
        if (at >= Math.floor((cur.length * 2) / 3) && restW + u.w <= width) cut = at + 1;
      }
      push(cur.slice(0, cut));
      cur = cur.slice(cut);
      curW = cur.reduce((n, x) => n + x.w, 0);
    }
    cur.push(u);
    curW += u.w;
  }
  push(cur);
  return rows;
}

/** A wrapped line with its first row prefixed `first` and every continuation row `CONTINUATION_PREFIX`. */
function prefixedRows(line: string, width: number, first: string, soft = false): Row[] {
  const firstW = Math.max(1, width - visibleWidth(first));
  const contW = Math.max(1, width - visibleWidth(CONTINUATION_PREFIX));
  return wrapLine(line, contW, soft, firstW).map((r, i) => ({
    ...r,
    text: (i === 0 ? first : CONTINUATION_PREFIX) + r.text,
  }));
}

// ── Free-text blocks ────────────────────────────────────────────────────────────────────────────

/** How much of a free-text value is shown whole: beyond these it is cut (human) or refused (model). */
export interface TextBlockLimits {
  /** Characters shown whole. */
  full: number;
  /** Display rows shown whole (the real cap is also the terminal's row budget — whichever is smaller). */
  maxRows: number;
}
/** A task: whole up to 2000 characters / 20 rows. */
export const TASK_LIMITS: TextBlockLimits = { full: 2000, maxRows: 20 };
/** A scope: whole up to 1000 characters / 10 rows. */
export const SCOPE_LIMITS: TextBlockLimits = { full: 1000, maxRows: 10 };

type Piece = { kind: 'line'; text: string } | { kind: 'blank'; n: number };

/** `text` as display pieces: its lines, with every run of 2+ blank (whitespace-only) lines collapsed to one marker. */
function toPieces(text: string): Piece[] {
  const out: Piece[] = [];
  let run = 0;
  const flush = (): void => {
    if (run === 1) out.push({ kind: 'line', text: '' });
    else if (run > 1) out.push({ kind: 'blank', n: run });
    run = 0;
  };
  for (const l of text.split('\n')) {
    if (/^[ \t]*$/.test(l)) run++;
    else {
      flush();
      out.push({ kind: 'line', text: l });
    }
  }
  flush();
  return out;
}

interface BodyRow extends Row {
  /** Index of the source piece, and how many source lines that piece stands for (a blank run stands for several). */
  piece: number;
  weight: number;
}

export interface TextMeasure {
  chars: number;
  /** Lines in the text as written. */
  lines: number;
  /** Display rows at `vp`, once blank runs are collapsed and long lines wrapped. */
  rows: number;
}

function bodyRows(text: string, vp: Viewport): BodyRow[] {
  const width = contentWidth(vp);
  const out: BodyRow[] = [];
  toPieces(text).forEach((p, i) => {
    if (p.kind === 'blank') out.push({ text: `  (${p.n} blank lines)`, chars: 0, piece: i, weight: p.n });
    else for (const r of prefixedRows(p.text, width, BLOCK_PREFIX)) out.push({ ...r, piece: i, weight: 1 });
  });
  return out;
}

export function measureText(text: string, vp: Viewport = currentViewport()): TextMeasure {
  return { chars: charCount(text), lines: text.split('\n').length, rows: bodyRows(text, vp).length };
}

/**
 * Why `text` cannot be shown whole under `limits` (words for an error message), or `null` when it can. Characters
 * are checked first, so a huge text is refused before any of it is measured against the terminal's width.
 */
export function textTooLongReason(
  text: string,
  limits: TextBlockLimits,
  vp: Viewport = currentViewport(),
): string | null {
  const chars = charCount(text);
  if (chars > limits.full) return `${chars} characters (a confirmation shows at most ${limits.full} whole)`;
  const m = measureText(text, vp);
  if (m.rows > limits.maxRows)
    return `${m.lines} lines / ${m.rows} display rows (a confirmation shows at most ${limits.maxRows} whole)`;
  return null;
}

/**
 * The rows of one free-text block: header, then its rows — all of them, or head + a marker + tail within
 * `bodyBudget` rows (marker included) and `maxChars` shown characters in all.
 */
function blockLines(
  label: string,
  text: string,
  rows: BodyRow[],
  bodyBudget: number | null,
  maxChars: number | null = null,
): string[] {
  const header = `${label} (${charCount(text)} characters, ${text.split('\n').length} lines):`;
  const total = rows.reduce((n, r) => n + r.chars, 0);
  // (a value of one or two rows has no middle to leave out)
  if (rows.length < 3 || bodyBudget === null || (rows.length <= bodyBudget && (maxChars === null || total <= maxChars)))
    return [header, ...rows.map(r => r.text)];
  const shownChars = (head: number, tail: number): number =>
    rows.slice(0, head).reduce((n, r) => n + r.chars, 0) +
    rows.slice(rows.length - tail).reduce((n, r) => n + r.chars, 0);
  let keep = Math.max(2, Math.min(bodyBudget - 1, rows.length - 1));
  let head = Math.ceil(keep / 2);
  let tail = keep - head;
  while (maxChars !== null && keep > 2 && shownChars(head, tail) > maxChars) {
    keep--;
    head = Math.ceil(keep / 2);
    tail = keep - head;
  }
  const hidden = rows.slice(head, rows.length - tail);
  const shownPieces = new Set([...rows.slice(0, head), ...rows.slice(rows.length - tail)].map(r => r.piece));
  const seen = new Set<number>();
  let hiddenLines = 0;
  for (const r of hidden)
    if (!shownPieces.has(r.piece) && !seen.has(r.piece)) {
      seen.add(r.piece);
      hiddenLines += r.weight;
    }
  const hiddenChars = hidden.reduce((n, r) => n + r.chars, 0);
  const marker = `(${hidden.length} rows not shown in the middle: ${hiddenLines > 0 ? `${hiddenLines} lines, ` : ''}${hiddenChars} characters)`;
  return [header, ...rows.slice(0, head).map(r => r.text), marker, ...rows.slice(rows.length - tail).map(r => r.text)];
}

/**
 * A labelled free-text block, alone (no budget beyond `limits`): every line prefixed (`  > `, continuation rows
 * `  ┆ `), escaped, nothing flattened; blank runs collapse to a `(N blank lines)` row; over `limits` it shows its
 * head and tail with an explicit "not shown" marker. The confirmation layout uses `layoutConfirmation` instead.
 */
export function renderTextBlock(
  label: string,
  text: string,
  limits: TextBlockLimits,
  vp: Viewport = currentViewport(),
): string {
  const rows = bodyRows(text, vp);
  const cut = textTooLongReason(text, limits, vp) !== null;
  return blockLines(label, text, rows, cut ? limits.maxRows : null, cut ? limits.full : null).join('\n');
}

/**
 * The one line per value that goes in the critical section: how big the value is and its first non-blank
 * line (up to 80 characters, escaped, runs of whitespace shown as one space), so a payload hidden further up
 * is at least accompanied by an honest size — and the exact number of characters of that line left out.
 */
export function describeTextSummary(label: string, text: string): string {
  const m = { chars: charCount(text), lines: text.split('\n').length };
  const first = Array.from(text.split('\n').find(l => l.trim() !== '') ?? '').reverse();
  while (first.length > 0 && /\s/.test(first[0])) first.shift(); // trailing whitespace is not "content"
  const cps = first.reverse();
  let shown = '';
  let n = 0;
  let i = 0;
  let prevSpace = true; // leading whitespace is dropped
  let collapsed = false;
  for (; i < cps.length && n < 80; i++) {
    if (/\s/.test(cps[i])) {
      if (prevSpace) {
        collapsed = true;
        continue;
      }
      shown += ' ';
      n++;
      prevSpace = true;
      if (cps[i] !== ' ') collapsed = true;
    } else {
      shown += cps[i];
      n++;
      prevSpace = false;
    }
  }
  const cut = cps.length - i;
  const more = cut > 0 ? ` (+${cut} more characters on that line)` : '';
  const note = collapsed ? ' [runs of whitespace shown as one space]' : '';
  return `${label}: ${m.chars} chars, ${m.lines} lines — first line: ${escapeForDisplay(shown)}${more}${note}`;
}

// ── The whole body ──────────────────────────────────────────────────────────────────────────────

export interface ConfirmBlock {
  /** Shown above the block (`Task`, `Scope`, …). */
  label: string;
  text: string;
  limits: TextBlockLimits;
  /** What the size summary calls it (`task`, `scope [claude]`); `layoutConfirmation` writes the summary row itself. */
  summaryLabel?: string;
  /** A person typed this text (not a model, not a stored record): when it does not fit it is cut, never refused. */
  mayCut?: boolean;
}

export interface ConfirmLayoutInput {
  /** Free text: shown FIRST, in this order. */
  blocks: ConfirmBlock[];
  /** The critical section, one logical line each (wrapped here): what will run, then every steering field. */
  critical: string[];
  /** Extra last lines (a block's own size summary is written by the layout from its `summaryLabel`). */
  summaries: string[];
  /** A block that does not fit: `refuse` (a model-set value) or show its head + tail (`headtail`, a human-typed one). */
  onOverflow: 'refuse' | 'headtail';
  viewport?: Viewport;
}

export type ConfirmLayout =
  | { ok: true; lines: string[]; rows: number }
  /** `critical`: what the confirmation must show does not fit the terminal; `blocks`: a task / scope is too long to show whole. */
  | { ok: false; reason: string; kind: 'critical' | 'blocks' };

/** The critical lines as display rows (each wrapped, continuation rows prefixed). */
export function criticalRows(lines: readonly string[], vp: Viewport): string[] {
  const width = contentWidth(vp);
  return lines.flatMap(l => prefixedRows(l, width, '', true).map(r => r.text));
}

/** The one-line size summary of a block shown whole: its first line is right above, so only the size is repeated. */
function shortSummary(label: string, text: string): string {
  return `${label}: ${charCount(text)} chars, ${text.split('\n').length} lines`;
}

export function layoutConfirmation(input: ConfirmLayoutInput): ConfirmLayout {
  const vp = input.viewport ?? currentViewport();
  const size = `${vp.columns}x${vp.rows}`;
  if (vp.columns < MIN_COLUMNS)
    return {
      ok: false,
      kind: 'critical',
      reason: `this terminal is ${size}: a confirmation needs at least ${MIN_COLUMNS} columns to be shown whole, every row laid out for the real width — widen the terminal`,
    };
  const huge = input.blocks.find(b => b.text.length > MAX_MEASURED_CHARS);
  if (huge)
    return {
      ok: false,
      kind: 'blocks',
      reason: `the ${huge.label.toLowerCase()} is over ${MAX_MEASURED_CHARS} characters — too long to show even its head and tail, so it is refused. Shorten it`,
    };
  // a model-set text over its character limit is refused before any of it is measured against the width
  if (input.onOverflow === 'refuse')
    for (const b of input.blocks)
      if (!b.mayCut) {
        const chars = charCount(b.text);
        if (chars > b.limits.full)
          return {
            ok: false,
            kind: 'blocks',
            reason: `the ${b.label.toLowerCase()} is ${chars} characters (a confirmation shows at most ${b.limits.full} whole) — too long for a person to review in the confirmation, so it is refused. Shorten it`,
          };
      }
  const crit = criticalRows(input.critical, vp);
  const avail = messageRowBudget(vp);
  const separator = input.blocks.length > 0 ? 1 : 0;
  const tooTall = (need: number): ConfirmLayout => ({
    ok: false,
    kind: 'critical',
    reason: `the confirmation's key lines (what will run and every setting) need ${need} rows, but this terminal (${size}) leaves room for ${avail} — enlarge the terminal, or give fewer / shorter values`,
  });
  const prepared = input.blocks.map(b => ({ b, rows: bodyRows(b.text, vp) }));
  const within = (p: (typeof prepared)[number]): boolean =>
    charCount(p.b.text) <= p.b.limits.full && p.rows.length <= p.b.limits.maxRows;
  const labelOf = (p: (typeof prepared)[number], i: number): string => p.b.summaryLabel ?? `text ${i + 1}`;
  // Size summaries LAST: a block shown whole gets one short entry (the whole text is right above), packed into a
  // single row; a cut one gets the descriptive line (size + first line + what was left out)
  const summariesFor = (cutSummaries: boolean): string[] => {
    const out: string[] = [];
    let packed: string[] = [];
    const flush = (): void => {
      if (packed.length > 0) out.push(packed.join(' · '));
      packed = [];
    };
    prepared.forEach((p, i) => {
      if (cutSummaries) {
        flush();
        out.push(describeTextSummary(labelOf(p, i), p.b.text));
      } else packed.push(shortSummary(labelOf(p, i), p.b.text));
    });
    flush();
    return [...out, ...input.summaries];
  };
  const whole = prepared.reduce((n, p) => n + 1 + p.rows.length, 0);
  const shortRows = criticalRows(summariesFor(false), vp);
  let sums = shortRows;
  let fixed = crit.length + sums.length + separator;
  if (fixed > avail) return tooTall(fixed);
  let budget = avail - fixed;
  let bodyBudgets: (number | null)[];
  if (prepared.length === 0 || (prepared.every(within) && whole <= budget)) bodyBudgets = prepared.map(() => null);
  else {
    // something does not fit whole: every block gets the descriptive summary from here on
    sums = criticalRows(summariesFor(true), vp);
    fixed = crit.length + sums.length + separator;
    if (fixed > avail) return tooTall(fixed);
    budget = avail - fixed;
    const refuseMissing =
      input.onOverflow === 'refuse' &&
      // blocks a person typed are only ever cut; a refusal needs at least one that is not
      (prepared.some(p => !p.b.mayCut && (!within(p) || whole > budget)) || prepared.every(p => !p.b.mayCut));
    if (refuseMissing) {
      const bad = prepared.find(p => !within(p) && !p.b.mayCut);
      if (bad)
        return {
          ok: false,
          kind: 'blocks',
          reason: `the ${bad.b.label.toLowerCase()} is ${textTooLongReason(bad.b.text, bad.b.limits, vp)} — too long for a person to review in the confirmation, so it is refused. Shorten it`,
        };
      // it is within its limits but the terminal has too few rows left next to what must be shown: with fewer than
      // MIN_TEXT_ROWS left there is nothing a person could review, so the terminal is the problem, not the text
      if (budget < MIN_TEXT_ROWS) return tooTall(fixed + MIN_TEXT_ROWS);
      return {
        ok: false,
        kind: 'blocks',
        reason: `the ${prepared.map(p => p.b.label.toLowerCase()).join(' and ')} need${prepared.length === 1 ? 's' : ''} ${whole} display rows, but only ${budget} fit on this terminal (${size}) next to what the confirmation must show — too long for a person to review, so it is refused. Shorten it, or enlarge the terminal`,
      };
    }
    // something is cut: every block needs at least a few rows to show anything of itself
    if (budget < MIN_BLOCK_ROWS * prepared.length) return tooTall(fixed + MIN_BLOCK_ROWS * prepared.length);
    // water-filling: a block that fits its fair share keeps what it wants, the rest split what is left
    const want = prepared.map(p => (within(p) ? 1 + p.rows.length : 1 + p.b.limits.maxRows));
    const share: number[] = want.map(() => 0);
    let left = budget;
    let pending = want.map((_, i) => i).sort((a, b) => want[a] - want[b]);
    while (pending.length > 0) {
      const fair = Math.floor(left / pending.length);
      const i = pending[0];
      if (want[i] <= fair) {
        share[i] = want[i];
        left -= want[i];
        pending = pending.slice(1);
      } else {
        for (const j of pending) share[j] = fair;
        break;
      }
    }
    bodyBudgets = prepared.map((p, i) => (within(p) && share[i] >= 1 + p.rows.length ? null : share[i] - 1));
  }
  const lines: string[] = [];
  prepared.forEach((p, i) => {
    lines.push(...blockLines(p.b.label, p.b.text, p.rows, bodyBudgets[i], p.b.limits.full));
  });
  if (separator) lines.push('');
  lines.push(...crit, ...sums);
  return { ok: true, lines, rows: lines.length };
}
