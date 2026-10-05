/**
 * What must never reach a terminal / confirm dialog / model raw: C0/C1 controls (ESC, CR, the 8-bit CSI),
 * DEL, line/paragraph separators, bidi marks/embeddings/overrides/isolates, zero-width characters, the
 * invisible U+2060 block and tag characters. Assembled from escaped range strings so this file (and every
 * test that uses it) holds no raw invisible character and no control-character regex literal.
 */
const RANGES = [
  '\\u0000-\\u0008',
  '\\u000b-\\u001f',
  '\\u007f-\\u009f',
  '\\u200b-\\u200f',
  '\\u2028\\u2029',
  '\\u202a-\\u202e',
  '\\u2060-\\u206f',
  '\\u{e0000}-\\u{e007f}',
];
export const UNSAFE = new RegExp(`[${RANGES.join('')}]`, 'u');

/** A hostile identifier: ESC/OSC, BEL, bidi override, zero-width, C1 CSI, bidi isolate. */
export const EVIL = `ev${String.fromCodePoint(0x1b)}]0;PWN${String.fromCodePoint(7)}il${String.fromCodePoint(0x202e, 0x200b, 0x9b, 0x2066)}x`;
