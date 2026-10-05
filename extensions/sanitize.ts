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
export function unitEscape(text: string): string {
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

/** Characters (code points) in `text` — what the limits above count. */
export function charCount(text: string): number {
  return Array.from(text).length;
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
