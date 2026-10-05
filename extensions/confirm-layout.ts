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
 * / `.rows`) and wrapped HERE, by hard column breaks, with every continuation row prefixed (`  ┆ `) — so a
 * wrapped row can never pass for an unprefixed summary / marker line, and pi never re-wraps (every row
 * already fits). The free-text blocks get a row budget — the terminal's rows minus the critical section and
 * the frame — and when they do not fit, a model-set value is REFUSED, a human-typed one is shown as head +
 * tail with a "not shown" marker. A critical section that does not fit is refused outright.
 */

import { visibleWidth } from '@earendil-works/pi-tui';
import { charCount, escapeForDisplay, MAX_COMBINING_RUN, unitEscape } from './sanitize.ts';

export interface Viewport {
  columns: number;
  rows: number;
}

/** Narrower terminals are assumed to be this wide (and not narrower), so a dialog is never laid out for less. */
export const MIN_COLUMNS = 80;
/** Rows assumed when the terminal's height is unknown (no TTY). */
export const DEFAULT_ROWS = 40;
/** What pi's selector adds around the message: border, spacer, title row, spacer, Yes, No, spacer, hint, spacer, border. */
export const DIALOG_FRAME_ROWS = 10;
/** A little slack on top of the frame, so a terminal that reserves a line or two still shows everything. */
export const DIALOG_SPARE_ROWS = 2;
/** The least a free-text block may be given (header, one row, the "not shown" marker, one row). */
export const MIN_BLOCK_ROWS = 4;

const BLOCK_PREFIX = '  > ';
/** Starts every continuation row of a wrapped line — a row of the text can never begin like one. */
export const CONTINUATION_PREFIX = '  ┆ ';

/** The real terminal: `process.stdout.columns` (at least `MIN_COLUMNS`) x `process.stdout.rows` (`DEFAULT_ROWS` when unknown). */
export function currentViewport(): Viewport {
  const c = process.stdout.columns;
  const r = process.stdout.rows;
  return {
    columns: Math.max(MIN_COLUMNS, typeof c === 'number' && Number.isFinite(c) && c > 0 ? Math.floor(c) : MIN_COLUMNS),
    rows: typeof r === 'number' && Number.isFinite(r) && r > 0 ? Math.floor(r) : DEFAULT_ROWS,
  };
}

/** Columns a message row may fill: pi's `Text` pads one column on each side. */
export function contentWidth(vp: Viewport): number {
  return Math.max(MIN_COLUMNS, vp.columns) - 2;
}

/** Message rows that are on screen once the frame (and a little slack) is accounted for. */
export function messageRowBudget(vp: Viewport): number {
  return Math.max(0, vp.rows - DIALOG_FRAME_ROWS - DIALOG_SPARE_ROWS);
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

/** `line` (no newline) cut into rows of at most `width` columns — hard breaks at the column, never a word wrap. */
function wrapLine(line: string, width: number): Row[] {
  const rows: Row[] = [];
  let cur = '';
  let curW = 0;
  let chars = 0;
  for (const u of toUnits(line)) {
    if (curW + u.w > width && cur !== '') {
      rows.push({ text: cur, chars });
      cur = '';
      curW = 0;
      chars = 0;
    }
    cur += u.s;
    curW += u.w;
    chars++;
  }
  rows.push({ text: cur, chars });
  return rows;
}

/** A wrapped line with its first row prefixed `first` and every continuation row `CONTINUATION_PREFIX`. */
function prefixedRows(line: string, width: number, first: string): Row[] {
  const inner = Math.max(1, width - Math.max(visibleWidth(first), visibleWidth(CONTINUATION_PREFIX)));
  return wrapLine(line, inner).map((r, i) => ({ ...r, text: (i === 0 ? first : CONTINUATION_PREFIX) + r.text }));
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

/** Why `text` cannot be shown whole under `limits` (words for an error message), or `null` when it can. */
export function textTooLongReason(
  text: string,
  limits: TextBlockLimits,
  vp: Viewport = currentViewport(),
): string | null {
  const m = measureText(text, vp);
  if (m.chars > limits.full) return `${m.chars} characters (a confirmation shows at most ${limits.full} whole)`;
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
  /** A person typed this text (not a model, not a stored record): when it does not fit it is cut, never refused. */
  mayCut?: boolean;
}

export interface ConfirmLayoutInput {
  /** Free text: shown FIRST, in this order. */
  blocks: ConfirmBlock[];
  /** The critical section, one logical line each (wrapped here): what will run, then every steering field. */
  critical: string[];
  /** The last lines: one `describeTextSummary` line per block. */
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
  return lines.flatMap(l => prefixedRows(l, width, '').map(r => r.text));
}

export function layoutConfirmation(input: ConfirmLayoutInput): ConfirmLayout {
  const vp = input.viewport ?? currentViewport();
  const crit = criticalRows(input.critical, vp);
  const sums = criticalRows(input.summaries, vp);
  const avail = messageRowBudget(vp);
  const separator = input.blocks.length > 0 ? 1 : 0;
  const fixed = crit.length + sums.length + separator;
  const size = `${vp.columns}x${vp.rows}`;
  const tooTall = (need: number): ConfirmLayout => ({
    ok: false,
    kind: 'critical',
    reason: `the confirmation's key lines (what will run and every setting) need ${need} rows, but this terminal (${size}) leaves room for ${avail} — enlarge the terminal, or give fewer / shorter values`,
  });
  if (fixed > avail) return tooTall(fixed);
  const budget = avail - fixed;
  const prepared = input.blocks.map(b => ({ b, rows: bodyRows(b.text, vp) }));
  const within = (p: (typeof prepared)[number]): boolean =>
    charCount(p.b.text) <= p.b.limits.full && p.rows.length <= p.b.limits.maxRows;
  const whole = prepared.reduce((n, p) => n + 1 + p.rows.length, 0);
  let bodyBudgets: (number | null)[];
  if (prepared.every(within) && whole <= budget) bodyBudgets = prepared.map(() => null);
  else if (
    input.onOverflow === 'refuse' &&
    // blocks a person typed are only ever cut; a refusal needs at least one that is not
    (prepared.some(p => !p.b.mayCut && (!within(p) || whole > budget)) || prepared.every(p => !p.b.mayCut))
  ) {
    const bad = prepared.find(p => !within(p) && !p.b.mayCut);
    if (bad)
      return {
        ok: false,
        kind: 'blocks',
        reason: `the ${bad.b.label.toLowerCase()} is ${textTooLongReason(bad.b.text, bad.b.limits, vp)} — too long for a person to review in the confirmation, so it is refused. Shorten it`,
      };
    return {
      ok: false,
      kind: 'blocks',
      reason: `the ${prepared.map(p => p.b.label.toLowerCase()).join(' and ')} take ${whole} display rows, but only ${budget} fit on this terminal (${size}) next to what the confirmation must show — too long for a person to review, so it is refused. Shorten it`,
    };
  } else {
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
