/**
 * The one sanitizer for template-authored text shown to a model or a terminal (`delegate_modes`,
 * `/delegate list`). Template files are attacker-influenceable in a trusted-but-hostile repo, so
 * everything a reader could be fooled by — terminal escapes, invisible characters, stacked combining
 * marks, homoglyph names — is neutralized here, in one place, rather than per call site.
 */

// ANSI CSI / OSC / two-byte escape sequences.
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping terminal escapes is the point
const ANSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[@-Z\\-_]/g;

/**
 * Characters that render as nothing (or act on the terminal) but that a model still reads:
 *
 * - `\p{Cc}` C0/C1 controls and DEL (U+009B is the 8-bit CSI);
 * - `\p{Cf}` every format character — soft hyphen, Arabic letter mark, Mongolian vowel separator,
 *   zero-width space/joiners, bidi marks/embeddings/overrides/isolates (Trojan Source), word joiner
 *   and invisible operators, BOM, interlinear annotation anchors, the invisible musical-notation
 *   formatters, and Unicode tag characters U+E0000–E007F ("ASCII smuggling");
 * - `\p{Zl}`/`\p{Zp}` line / paragraph separators;
 * - `\p{Co}` private-use characters (no standard glyph — free to mean anything to a font or model);
 * - invisible characters outside those categories: variation selectors (U+FE00–FE0F, U+E0100–E01EF),
 *   the combining grapheme joiner U+034F, the Hangul fillers U+115F/U+1160/U+3164/U+FFA0, the Khmer
 *   inherent vowels U+17B4/U+17B5, and the blank Braille pattern U+2800;
 * - the whole U+2060–U+206F and U+E0000–U+E007F (tag) blocks by range, including their unassigned
 *   code points, which `\p{Cf}` alone would miss.
 *
 * The one shared set: `sanitizeTemplateText` strips it (discovery output), `quoteValue` (templates.ts)
 * escapes it as `\uXXXX` (permission/field warnings). Only the character set is shared — each channel
 * keeps its own treatment. Never add a second list elsewhere; widen this one.
 */
// Built from a string so the escapes stay escapes (a formatter would otherwise inline them as literal
// invisible characters).
export const INVISIBLE_OR_CONTROL_RE = new RegExp(
  [
    '[\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}\\p{Co}',
    '\\u034f\\u115f\\u1160\\u17b4\\u17b5\\u2800\\u3164\\ufe00-\\ufe0f\\uffa0\\u{e0100}-\\u{e01ef}',
    '\\u2060-\\u206f\\u{e0000}-\\u{e007f}]',
  ].join(''),
  'gu',
);

/** At most this many combining marks in a row survive — enough for real scripts, not for "Zalgo". */
export const MAX_COMBINING_RUN = 2;
const COMBINING_RUN_RE = new RegExp(`(\\p{M}{${MAX_COMBINING_RUN}})\\p{M}+`, 'gu');

/** Cap `text` at `max` code points (with `…`), never leaving half a surrogate pair behind. */
function capText(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, Math.max(0, max - 1)).join('')}…` : text;
}

/**
 * Template-authored free text made safe to show: ANSI escapes removed, invisible / control
 * characters (`INVISIBLE_OR_CONTROL_RE`) replaced by a space, runs of combining marks cut to
 * `MAX_COMBINING_RUN`, whitespace (including newlines) collapsed to one line, capped at `max`.
 */
export function sanitizeTemplateText(text: string, max: number): string {
  const clean = text
    .replace(ANSI_RE, '')
    .replace(INVISIBLE_OR_CONTROL_RE, ' ')
    .replace(COMBINING_RUN_RE, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return capText(clean, max);
}

/**
 * An identifier (a mode name, a model name) made safe **and unambiguous** to show: sanitized as
 * above, then every character outside printable ASCII escaped as `\u{…}`, so a homoglyph or
 * mixed-script name (`reviеw` with a Cyrillic `е`) can never look identical to a real one (`review`).
 * `escaped` says whether anything was escaped, for a warning alongside it.
 */
export function sanitizeIdentifier(text: string, max: number): { text: string; escaped: boolean } {
  const clean = sanitizeTemplateText(text, Number.MAX_SAFE_INTEGER);
  let escaped = false;
  const ascii = Array.from(clean)
    .map(ch => {
      if (/^[\x20-\x7e]$/.test(ch)) return ch;
      escaped = true;
      return `\\u{${(ch.codePointAt(0) ?? 0).toString(16)}}`;
    })
    .join('');
  return { text: capText(ascii, max), escaped };
}

// ── Display escaping and the stored-text reject list ───────────────────────────────────────────

/** `\uXXXX` per UTF-16 unit — the one escape notation every confirmation uses. */
function unitEscape(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) out += `\\u${text.charCodeAt(i).toString(16).padStart(4, '0')}`;
  return out;
}

// Everything `INVISIBLE_OR_CONTROL_RE` hides, plus unassigned code points (`\p{Cn}`, they render as
// nothing or as a box) and lone surrogates (`\p{Cs}`).
// (and the Mongolian free variation selectors U+180B-180D / U+180F, which are combining marks, not format characters)
const DISPLAY_ESCAPE_RE = new RegExp(
  `(?:${INVISIBLE_OR_CONTROL_RE.source}|[\\p{Cn}\\p{Cs}\\u180b-\\u180d\\u180f])`,
  'gu',
);
const COMBINING_EXTRA_RE = new RegExp(`(\\p{M}{${MAX_COMBINING_RUN}})(\\p{M}+)`, 'gu');

/**
 * `text` made safe to put in front of a human **without changing what it says**: every control,
 * format (zero-width, joiners, variation selectors, bidi, tag), separator, private-use, unassigned
 * and lone-surrogate character is written out as `\uXXXX`, and combining marks beyond
 * `MAX_COMBINING_RUN` in a row are written out too, so nothing can hide in what a confirmation shows.
 * Newlines and tabs stay as they are (free text is multi-line). Nothing is stripped or collapsed.
 */
export function escapeForDisplay(text: string): string {
  return text
    .replace(DISPLAY_ESCAPE_RE, ch => (ch === '\n' || ch === '\t' ? ch : unitEscape(ch)))
    .replace(COMBINING_EXTRA_RE, (_m, keep: string, extra: string) => keep + unitEscape(extra));
}

// What a stored (untrusted) task/scope/value may NOT contain — it is refused rather than run. These are
// the characters that act on a terminal or reorder/spoof what is displayed: C0 controls other than
// newline/tab (NUL, ESC, CR, …), DEL, C1 controls (incl. U+0085), line/paragraph separators, bidi marks,
// embeddings, overrides and isolates, Unicode tag characters ("ASCII smuggling") and lone surrogates.
// Zero-width joiners (ZWJ emoji sequences), variation selectors and the other format characters are
// NOT refused: they are legitimate in real text and `escapeForDisplay` makes them visible.
const FORBIDDEN_CHARS =
  '\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u061c\\u200e\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069\\u{e0000}-\\u{e007f}\\p{Cs}';
const FORBIDDEN_RE = new RegExp(`[${FORBIDDEN_CHARS}]`, 'u');
const FORBIDDEN_NO_WS_RE = new RegExp(`[${FORBIDDEN_CHARS}\\n\\t]`, 'u');

/**
 * The first character of `text` that may not be run, as `U+XXXX`, or `null` when there is none.
 * `allowNewlines` (free text: task, scope) also admits `\n` and `\t`; single-line values (model, pr,
 * session id, directory names) do not.
 */
export function forbiddenCharacter(text: string, allowNewlines: boolean): string | null {
  const m = (allowNewlines ? FORBIDDEN_RE : FORBIDDEN_NO_WS_RE).exec(text);
  return m ? `U+${(m[0].codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}` : null;
}

/**
 * How much of a free-text value a confirmation shows whole, and — beyond that — from each end. A
 * confirmation dialog is bottom-anchored and does not scroll, so a value taller than the screen pushes
 * its own top (and whatever the human most needs to see) off it: the limits therefore cap DISPLAY ROWS
 * as well as characters. A row is one line, or `CONFIRM_COLUMNS` characters of a longer one (counted on
 * the escaped text, which can be several times the raw length).
 */
export interface TextBlockLimits {
  /** Characters shown whole. */
  full: number;
  head: number;
  tail: number;
  /** Display rows shown whole. */
  maxRows: number;
  headRows: number;
  tailRows: number;
}
/** The width one display row is assumed to hold. A narrower terminal wraps more — the summary line (`describeTextSummary`) is the backstop. */
export const CONFIRM_COLUMNS = 120;
/** A task: whole up to 2000 characters / 20 rows; beyond that the first and last 1000 characters / 10 rows. */
export const TASK_LIMITS: TextBlockLimits = {
  full: 2000,
  head: 1000,
  tail: 1000,
  maxRows: 20,
  headRows: 10,
  tailRows: 10,
};
/** A scope: whole up to 1000 characters / 10 rows; beyond that the first and last 500 characters / 5 rows. */
export const SCOPE_LIMITS: TextBlockLimits = {
  full: 1000,
  head: 500,
  tail: 500,
  maxRows: 10,
  headRows: 5,
  tailRows: 5,
};

/** Characters (code points) in `text` — what the limits above count. */
export function charCount(text: string): number {
  return Array.from(text).length;
}

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

const PREFIX = '  > ';

function rowsOf(p: Piece): number {
  if (p.kind === 'blank') return 1;
  return Math.max(1, Math.ceil((Array.from(escapeForDisplay(p.text)).length + PREFIX.length) / CONFIRM_COLUMNS));
}

function renderPiece(p: Piece): string {
  // a collapse marker is NOT `> `-prefixed, so a line of the text itself can never pass for one
  return p.kind === 'blank' ? `  (${p.n} blank lines)` : `${PREFIX}${escapeForDisplay(p.text)}`;
}

export interface TextMeasure {
  chars: number;
  /** Lines in the text as written. */
  lines: number;
  /** Display rows once blank runs are collapsed and long lines wrapped. */
  rows: number;
}

export function measureText(text: string): TextMeasure {
  return {
    chars: charCount(text),
    lines: text.split('\n').length,
    rows: toPieces(text).reduce((n, p) => n + rowsOf(p), 0),
  };
}

/** Why `text` cannot be shown whole under `limits` (`'…'` words for an error message), or `null` when it can. */
export function textTooLongReason(text: string, limits: TextBlockLimits): string | null {
  const m = measureText(text);
  if (m.chars > limits.full) return `${m.chars} characters (a confirmation shows at most ${limits.full} whole)`;
  if (m.rows > limits.maxRows)
    return `${m.lines} lines / ${m.rows} display rows (a confirmation shows at most ${limits.maxRows} whole)`;
  return null;
}

function takeEdge(
  ps: readonly Piece[],
  maxChars: number,
  maxRows: number,
  fromEnd: boolean,
): { taken: Piece[]; chars: number; whole: number; partial: boolean } {
  const order = fromEnd ? [...ps].reverse() : [...ps];
  const taken: Piece[] = [];
  let chars = 0;
  let rows = 0;
  let whole = 0;
  let partial = false;
  for (const p of order) {
    if (p.kind === 'blank') {
      if (rows + 1 > maxRows) break;
      taken.push(p);
      rows++;
      whole++;
      continue;
    }
    const len = Array.from(p.text).length;
    const r = rowsOf(p);
    if (rows + r <= maxRows && chars + len <= maxChars) {
      taken.push(p);
      rows += r;
      chars += len;
      whole++;
      continue;
    }
    // a line too big for what is left: take as much of its near end as fits
    const cps = Array.from(p.text);
    let k = Math.min(maxChars - chars, (maxRows - rows) * CONFIRM_COLUMNS - PREFIX.length, cps.length);
    while (k > 0) {
      const part = (fromEnd ? cps.slice(cps.length - k) : cps.slice(0, k)).join('');
      const cand: Piece = { kind: 'line', text: part };
      if (rows + rowsOf(cand) <= maxRows) {
        taken.push(cand);
        chars += k;
        partial = true;
        break;
      }
      k = Math.floor(k * 0.8);
    }
    break;
  }
  return { taken: fromEnd ? taken.reverse() : taken, chars, whole, partial };
}

/**
 * A labelled multi-line block for a confirmation body: every line prefixed (`  > `), escaped with
 * `escapeForDisplay`, nothing flattened; runs of blank lines collapse to a `(N blank lines)` line. A
 * value over `limits` (characters or display rows) shows its head and its tail with an explicit
 * `(N lines, M characters not shown in the middle)` line between — never a silent `…`. Callers that must
 * not run a value they cannot show whole check `textTooLongReason` first.
 */
export function renderTextBlock(label: string, text: string, limits: TextBlockLimits): string {
  const m = measureText(text);
  const header = `${label} (${m.chars} characters, ${m.lines} lines):`;
  const ps = toPieces(text);
  if (textTooLongReason(text, limits) === null) return `${header}\n${ps.map(renderPiece).join('\n')}`;
  const head = takeEdge(ps, limits.head, limits.headRows, false);
  const rest = ps.slice(head.whole);
  const tail = takeEdge(rest, limits.tail, limits.tailRows, true);
  // the tail reached the line the head cut part of: its two pieces must not overlap (or repeat) — drop the tail's
  const shared = rest[0];
  if (head.partial && shared?.kind === 'line' && tail.taken.length === rest.length) {
    const first = tail.taken[0];
    const tailPart = first.kind === 'line' ? Array.from(first.text).length : 0;
    const headPart = (() => {
      const last = head.taken[head.taken.length - 1];
      return last.kind === 'line' ? Array.from(last.text).length : 0;
    })();
    if (headPart + tailPart >= Array.from(shared.text).length) {
      tail.taken.shift();
      tail.chars -= tailPart;
    }
  }
  const shownLines = [...head.taken, ...tail.taken].reduce((n, p) => n + (p.kind === 'blank' ? p.n : 1), 0);
  const hiddenLines = Math.max(0, m.lines - shownLines);
  const hiddenChars = Math.max(0, m.chars - head.chars - tail.chars);
  const marker = `(${hiddenLines > 0 ? `${hiddenLines} lines, ` : ''}${hiddenChars} characters not shown in the middle)`;
  return [header, ...head.taken.map(renderPiece), marker, ...tail.taken.map(renderPiece)].join('\n');
}

/**
 * The one line that goes LAST in a confirmation body — right above the Yes/No options, the part of a
 * bottom-anchored dialog that is always on screen: how big the value is and its first non-blank line
 * (up to 80 characters, escaped), so a payload hidden further up is at least accompanied by an honest size.
 */
export function describeTextSummary(label: string, text: string): string {
  const m = measureText(text);
  const first = text.split('\n').find(l => l.trim() !== '') ?? '';
  const cps = Array.from(first);
  const shown = escapeForDisplay(cps.slice(0, 80).join(''));
  const more = cps.length > 80 ? ` (+${cps.length - 80} more characters on that line)` : '';
  return `${label}: ${m.chars} chars, ${m.lines} lines — first line: ${shown}${more}`;
}

/**
 * A short value (a name) for a confirmation: JSON-quoted with every invisible character escaped, up to
 * `max` characters; anything longer says how much is not shown instead of cutting silently.
 */
export function quoteCapped(value: string, max: number): string {
  const chars = Array.from(value);
  const shown = chars.length > max ? chars.slice(0, max).join('') : value;
  const q = escapeForDisplay(JSON.stringify(shown));
  return chars.length > max ? `${q} (${chars.length - max} more characters not shown)` : q;
}
