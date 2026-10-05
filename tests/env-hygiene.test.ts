import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';

// Guard for the `process.env.X = prev` restore bug: when `X` was unset, `prev` is `undefined`, and
// assigning `undefined` to `process.env` stores the *string* "undefined" — a restored
// `PI_CODING_AGENT_DIR="undefined"` once sent a straggling run's transcript into a relative
// `undefined/delegate/outputs/...` directory inside the repo. Every env mutation in tests must go
// through `tests/helpers/env.ts` (`withEnv`/`restoreEnv`, which delete-when-unset); this test fails on
// any direct write elsewhere, so the unsafe shape can't creep back in. The preload's afterEach
// (tests/helpers/preload.ts) is the runtime backstop for whatever a static scan can't see.
//
// How: comments are blanked and string/template/regex literals are emptied (an identifier-like string
// such as 'env' is kept, so `process['env']` is still recognised), newlines preserved; then the patterns
// below run over the WHOLE file, with `\s*` spanning line breaks. Aliasing env into a variable is banned
// outright — tracking writes through an alias isn't worth the complexity.

const TESTS_DIR = import.meta.dirname;
/** Files allowed to write `process.env` directly — only the helper every other file must go through. */
const ALLOWED = new Set(['helpers/env.ts']);
/** Every JS/TS source flavour bun can run as (or import from) a test file. */
const SOURCE_FILE = /\.[cm]?[jt]sx?$/;

// `process.env`, `process['env']`, `globalThis.process.env`, `Bun.env` (in bun 1.4.1, `Bun.env.X =
// undefined` stores "undefined" too). Optional chaining is tolerated so `process?.env` can't dodge it.
const ENV = String.raw`(?:\bprocess\s*(?:\??\.\s*env|\[\s*(?:'env'|"env"|${'`'}env${'`'})\s*\])|\bBun\s*\??\.\s*env)(?![\w$])`;
// `.X` or `[...]` (one level of nested brackets, e.g. `[k[0]]`) after the env object.
const MEMBER = String.raw`(?:\s*\??\.\s*[A-Za-z_$][\w$]*|\s*\[(?:[^\[\]]|\[[^\[\]]*\])*\])`;
// Every assignment operator; `==`/`===`/`=>` are not (`<=`/`>=`/`!=` never start with one of these).
const ASSIGN = String.raw`(?:=(?![=>])|\?\?=|\|\|=|&&=|\*\*=|<<=|>>>=|>>=|[-+*/%&|^]=)`;
// Not followed by a member access — i.e. the env object itself is the value.
const BARE = String.raw`(?!\s*(?:\??\.|\[))`;

const WRITE_PATTERNS: Array<[string, RegExp]> = [
  ['assignment to an env var', new RegExp(`${ENV}${MEMBER}\\s*${ASSIGN}`, 'g')],
  ['++/-- on an env var', new RegExp(`${ENV}${MEMBER}\\s*(?:\\+\\+|--)|(?:\\+\\+|--)\\s*${ENV}${MEMBER}`, 'g')],
  ['replacing the env object', new RegExp(`${ENV}\\s*${ASSIGN}`, 'g')],
  ['delete on env', new RegExp(`\\bdelete\\s*\\(?\\s*${ENV}`, 'g')],
  [
    'Object.* mutating env',
    new RegExp(
      `\\bObject\\s*\\.\\s*(?:assign|defineProperty|defineProperties|setPrototypeOf)\\s*\\(\\s*${ENV}${BARE}`,
      'g',
    ),
  ],
  [
    'Reflect.* mutating env',
    new RegExp(
      `\\bReflect\\s*\\.\\s*(?:set|defineProperty|deleteProperty|setPrototypeOf)\\s*\\(\\s*${ENV}${BARE}`,
      'g',
    ),
  ],
  // `const e = process.env;` / `x = Bun.env` — not after `}` (`const { HOME } = process.env` is a read).
  ['aliasing env into a variable', new RegExp(`(?<![=!<>])(?<!\\}\\s*)=(?![=>])\\s*${ENV}${BARE}`, 'g')],
  [
    'destructuring env out of process/Bun',
    new RegExp(`\\{[^{}]*\\benv\\b[^{}]*\\}\\s*=\\s*(?:process|Bun)\\b${BARE}`, 'g'),
  ],
];

/** Chars after which a `/` starts a regex literal rather than a division. */
const REGEX_PRECEDERS = new Set([...'(,=:[!&|?{};+-*%<>~^']);
const REGEX_KEYWORD_BEFORE =
  /(?:^|[^\w$])(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/;

/**
 * `source` with comments blanked and string/template/regex literal bodies emptied (identifier-like
 * strings kept verbatim), every newline preserved so offsets map back to the original lines.
 */
function stripCommentsAndLiterals(source: string): string {
  const n = source.length;
  const blank = (s: string) => s.replace(/[^\n]/g, ' ');
  let out = '';

  /** Index just past the closing quote of the string starting at `i` (or at the line end if unterminated). */
  const stringEnd = (i: number): number => {
    const q = source[i];
    let j = i + 1;
    while (j < n && source[j] !== q && source[j] !== '\n') j += source[j] === '\\' ? 2 : 1;
    return Math.min(j + 1, n);
  };
  /** Index just past the template literal starting at `i`, skipping nested `${ ... }` expressions. */
  const templateEnd = (i: number): number => {
    let j = i + 1;
    while (j < n) {
      const c = source[j];
      if (c === '\\') j += 2;
      else if (c === '`') return j + 1;
      else if (c === '$' && source[j + 1] === '{') j = expressionEnd(j + 2);
      else j++;
    }
    return n;
  };
  /** Index just past the `}` closing a `${` expression whose body starts at `i`. */
  const expressionEnd = (i: number): number => {
    let depth = 1;
    let j = i;
    while (j < n) {
      const c = source[j];
      if (c === "'" || c === '"') j = stringEnd(j);
      else if (c === '`') j = templateEnd(j);
      else if (c === '{') {
        depth++;
        j++;
      } else if (c === '}') {
        if (--depth === 0) return j + 1;
        j++;
      } else j++;
    }
    return n;
  };
  /** Index just past the regex literal starting at `i` (flags included). */
  const regexEnd = (i: number): number => {
    let j = i + 1;
    let inClass = false;
    while (j < n && source[j] !== '\n') {
      const c = source[j];
      if (c === '\\') {
        j += 2;
        continue;
      }
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) break;
      j++;
    }
    j++;
    while (j < n && /[a-z]/i.test(source[j] as string)) j++;
    return Math.min(j, n);
  };
  const keepOrEmpty = (literal: string, quote: string): string => {
    const body = literal.slice(1, -1);
    return /^[\w$]*$/.test(body) && literal.endsWith(quote) ? literal : quote + blank(body) + quote;
  };

  let i = 0;
  while (i < n) {
    const c = source[i] as string;
    const d = source[i + 1];
    let end = -1;
    let replacement = '';
    if (c === '/' && d === '/') {
      const nl = source.indexOf('\n', i);
      end = nl === -1 ? n : nl;
      replacement = blank(source.slice(i, end));
    } else if (c === '/' && d === '*') {
      const close = source.indexOf('*/', i + 2);
      end = close === -1 ? n : close + 2;
      replacement = blank(source.slice(i, end));
    } else if (c === "'" || c === '"') {
      end = stringEnd(i);
      replacement = keepOrEmpty(source.slice(i, end), c);
    } else if (c === '`') {
      end = templateEnd(i);
      const literal = source.slice(i, end);
      replacement = literal.includes('${') ? `\`${blank(literal.slice(1, -1))}\`` : keepOrEmpty(literal, '`');
    } else if (c === '/') {
      const before = out.trimEnd();
      const prev = before[before.length - 1];
      if (prev === undefined || REGEX_PRECEDERS.has(prev) || REGEX_KEYWORD_BEFORE.test(before)) {
        end = regexEnd(i);
        replacement = `/${blank(source.slice(i + 1, end - 1))}/`;
      }
    }
    if (end === -1) {
      out += c;
      i++;
    } else {
      out += replacement.length === end - i ? replacement : replacement.padEnd(end - i);
      i = end;
    }
  }
  return out;
}

/** Every direct env write in `source`, as `line N: <kind>: <original line text>`. */
function findEnvWrites(source: string): string[] {
  const code = stripCommentsAndLiterals(source);
  const lines = source.split('\n');
  const hits = new Set<string>();
  for (const [kind, re] of WRITE_PATTERNS) {
    for (const m of code.matchAll(re)) {
      // report the line the env reference itself is on (a match may start on an earlier `=`)
      const envAt = m.index + m[0].search(/process|Bun/);
      const line = code.slice(0, envAt).split('\n').length;
      hits.add(`line ${line}: ${kind}: ${(lines[line - 1] ?? '').trim()}`);
    }
  }
  return [...hits];
}

function testFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'fixtures' || entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...testFiles(full));
    else if (SOURCE_FILE.test(entry.name)) out.push(full);
  }
  return out;
}

test('env hygiene: the detector flags every unsafe write shape', () => {
  for (const bad of [
    'process.env.PI_CODING_AGENT_DIR = prev;',
    "process.env['FAKE_ARGS_FILE'] = prevArgs;",
    'process.env[name] = value;',
    'process.env.X ??= y;',
    'process.env.X ||= y;',
    'process.env.X &&= y;',
    'process.env.X += "a";',
    'process.env.X++;',
    '++process.env.X;',
    'process.env.X--;',
    'delete process.env.X;',
    "delete process.env['X'];",
    'Object.assign(process.env, saved);',
    'Object.defineProperty(process.env, "X", { value: "1" });',
    'Reflect.set(process.env, "X", prev);',
    'Reflect.deleteProperty(process.env, "X");',
    'process.env = { ...saved };',
    'Bun.env.ZZ = undefined;',
    "Bun.env['ZZ'] = prev;",
    'delete Bun.env.ZZ;',
    "process['env'].X = prev;",
    'process["env"]["X"] = prev;',
    'globalThis.process.env.X = prev;',
    "process.env['A]'] = prev;",
    'process.env[k[0]] = prev;',
    'process.env\n  .X = prev;',
    'process\n  .env\n  .X = prev;',
    'Object.assign(\n  process.env,\n  saved,\n);',
    'const { env } = process;\nenv.X = prev;',
    'const { env: e } = process;',
    'const e = process.env;\ne.X = prev;',
    'let e;\ne = process.env;',
    'const e = Bun.env;',
    'const x = 1; // a comment\nprocess.env.X = prev; // trailing',
    "const s = 'a string'; process.env.X = prev;",
    'const r = /["\']/; process.env.X = prev;',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: JS source text under test, not a template
    'const t = `x ${y} z`; process.env.X = prev;',
  ]) {
    assert.ok(findEnvWrites(bad).length > 0, `should flag: ${bad}`);
  }
});

test('env hygiene: the detector ignores reads, comparisons, comments and string literals', () => {
  for (const ok of [
    "const LIVE = process.env.PI_DELEGATE_LIVE === '1';",
    'const prev = process.env.PATH;',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: JS source text under test, not a template
    'withEnv({ PATH: `${binDir}:${process.env.PATH}` }, fn);',
    'if (process.env.X == null) return;',
    'if (process.env.X != null) return;',
    'if (process.env.X === undefined) return;',
    'if (process.env.X !== prev) return;',
    'if (process.env.X <= 1 || process.env.X >= 2) return;',
    'const f = process.env.X => 1;',
    '// process.env.X = prev',
    '/* process.env.X = prev; delete process.env.Y */',
    '/**\n * Never `process.env.X = prev`.\n */',
    "const msg = 'never write process.env.X = prev';",
    'const msg = "Object.assign(process.env, x)";',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: JS source text under test, not a template
    'const msg = `use withEnv, not process.env.X = ${y}`;',
    'const re = /process\\.env\\.X = prev/;',
    'const { HOME } = process.env;',
    'const { HOME, PATH: p } = process.env;',
    'spawn(cmd, { env: process.env });',
    'spawn(cmd, { env: { ...process.env, X: "1" } });',
    'const keys = Object.keys(process.env);',
    'const e = { ...process.env };',
    'const has = "X" in process.env;',
    'const v = Bun.env.X;',
  ]) {
    assert.deepEqual(findEnvWrites(ok), [], `should not flag: ${ok}`);
  }
});

test('env hygiene: the detector reports the line of the env reference', () => {
  assert.deepEqual(findEnvWrites('const a = 1;\n\nprocess.env\n  .X = prev;'), [
    'line 3: assignment to an env var: process.env',
  ]);
});

test('env hygiene: test sources of every JS/TS flavour are scanned', () => {
  for (const name of [
    'a.ts',
    'a.test.ts',
    'a.test.js',
    'a.test.mjs',
    'a.test.cjs',
    'a.test.tsx',
    'a.test.jsx',
    'a.mts',
  ]) {
    assert.ok(SOURCE_FILE.test(name), name);
  }
  for (const name of ['a.md', 'a.json', 'a.jsonl', 'a.d.ts.map']) assert.ok(!SOURCE_FILE.test(name), name);
});

test('env hygiene: no test file writes process.env directly (use tests/helpers/env.ts)', () => {
  const offenders: string[] = [];
  for (const file of testFiles(TESTS_DIR)) {
    const rel = relative(TESTS_DIR, file).split('\\').join('/');
    if (ALLOWED.has(rel)) continue;
    for (const hit of findEnvWrites(readFileSync(file, 'utf8'))) offenders.push(`tests/${rel} ${hit}`);
  }
  // every offender in the message itself — a deepEqual diff gets truncated by the reporter
  assert.equal(
    offenders.length,
    0,
    'Write env vars via withEnv()/restoreEnv() from tests/helpers/env.ts — a bare `process.env.X = prev` ' +
      `stores the string "undefined" when X was unset. Offenders:\n${offenders.join('\n')}`,
  );
});
