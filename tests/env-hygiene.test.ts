import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';

// Guard for the `process.env.X = prev` restore bug: when `X` was unset, `prev` is `undefined`, and
// assigning `undefined` to `process.env` stores the *string* "undefined" — a restored
// `PI_CODING_AGENT_DIR="undefined"` once sent a straggling run's transcript into a relative
// `undefined/delegate/outputs/...` directory inside the repo. Every env mutation in tests must go
// through `tests/helpers/env.ts` (`withEnv`/`withEnvSync`/`restoreEnv`, which delete-when-unset); this
// test fails on any direct write elsewhere, so the unsafe shape can't creep back in. The preload's
// afterEach (tests/helpers/preload.ts) is the runtime backstop for whatever a static scan can't see.
//
// Design — an allowlist of reads, not a denylist of writes. Enumerating write shapes kept missing
// some (`(process.env).X =`, `[process.env.X] = [prev]`, `Object['assign'](process.env, …)`,
// `Reflect.apply(Object.assign, …)`, …): JS has too many ways to reach an object. So instead every
// reference to the env object (`process.env`, `Bun.env`, `import.meta.env`, bracket/optional/parenthesis
// spellings) must be one of a few READ shapes, and anything else fails:
//   - `env.X` / `env[k]` used as a value — not assigned (`=`, compound, `++`/`--`, `delete`), not a
//     for-in/of target, and not inside a destructuring pattern or parenthesised target that is assigned
//     to (any enclosing `)`/`]`/`}` followed by an assignment counts as one, which also flags the rare
//     harmless `obj[process.env.K] = v` and `const { a = process.env.X } = o` — write those differently);
//   - the env object itself only in `X in env`, `{ ...env }`, `{ env: env }` (a spawn option),
//     `Object.keys/values/entries/hasOwn(env, …)`, `const { A } = env` or `typeof env`.
// `process`/`Bun` as a bare value (`const p = process`, `(process).env`, `fn(process)`,
// `const { env } = process`), `= globalThis` aliasing, and importing env from `process`/`node:process`
// or `bun` are banned outright: following writes through an alias isn't worth the complexity.
//
// How: comments are blanked and string/template/regex literal *text* is emptied (an identifier-like
// string such as 'env', or a module name like 'node:process', is kept so bracket spellings and imports
// are still recognised; `${…}` bodies inside templates stay code), newlines preserved. Telling a regex
// literal from a division is heuristic (`slashStartsRegex`), and a division misread as a regex would
// blank code up to the next `/` on that line — so a "regex" whose text holds an env reference, or a
// `;` and a `process`/`Bun`/`globalThis` word, is conservatively kept as code instead of blanked.

const TESTS_DIR = import.meta.dirname;
/** Files allowed to write `process.env` directly — only the helper every other file must go through. */
const ALLOWED = new Set(['helpers/env.ts']);
/** Every JS/TS source flavour bun can run as (or import from) a test file. */
const SOURCE_FILE = /\.[cm]?[jt]sx?$/;

const Q = '[\'"`]';
// `process`/`Bun`, by name or as a bracket key (`globalThis['process']`).
const ROOT = String.raw`(?:(?<![\w$])(?:process|Bun)(?![\w$])|\[\s*(${Q})(?:process|Bun)\1\s*\])`;
// The env object: `<ROOT>.env`, `<ROOT>?.env`, `<ROOT>['env']`, and bun's `import.meta.env`.
const ENV_RE = new RegExp(
  String.raw`(?:${ROOT}\s*(?:\??\.\s*env|\[\s*(${Q})env\2\s*\])|(?<![\w$])import\s*\.\s*meta\s*\.\s*env)(?![\w$])`,
  'g',
);
// One `.X` / `?.X` / `[...]` (one level of nested brackets, e.g. `[k[0]]`) member access.
const MEMBER_RE = /\s*(?:\??\.\s*[A-Za-z_$][\w$]*|\[(?:[^[\]]|\[[^[\]]*\])*\])/y;
// Every assignment operator; `==`/`===`/`=>` are not (`<=`/`>=`/`!=` never start with one of these).
const ASSIGN = String.raw`(?:=(?![=>])|\?\?=|\|\|=|&&=|\*\*=|<<=|>>>=|>>=|[-+*/%&|^]=)`;
// What directly follows a member access when it is written: an assignment (a TS `!` may sit before
// it), `++`/`--`, or `of`/`in` (a for-in/of target — `env.X in o` as a read is rare enough to forbid).
const WRITE_AFTER_RE = new RegExp(String.raw`\s*(?:!(?!=)\s*)?(?:${ASSIGN}|\+\+|--|(?:of|in)(?![\w$]))`, 'y');
const ASSIGN_AFTER_CLOSER_RE = new RegExp(String.raw`\s*(?:!(?!=)\s*)?${ASSIGN}`, 'y');
// Before a member access (parentheses allowed in between): `delete`, `++`, `--`.
const WRITE_BEFORE_RE = /(?:(?<![\w$])delete|\+\+|--)[\s(]*$/;
// The only shapes the bare env object may appear in (matched against the code just before it).
const BARE_READ_BEFORE_RE = new RegExp(
  [
    String.raw`(?<![\w$])in\s*$`, // 'X' in process.env, for (k in process.env)
    String.raw`\.\.\.\s*$`, // { ...process.env }
    String.raw`(?<![\w$.])env\s*:\s*$`, // spawn(cmd, { env: process.env })
    String.raw`(?<![\w$])Object\s*\.\s*(?:keys|values|entries|hasOwn)\s*\(\s*$`, // Object.keys(process.env)
    String.raw`\}\s*=\s*$`, // const { HOME } = process.env
    String.raw`(?<![\w$])typeof\s*$`,
  ].join('|'),
);
// `process`/`Bun` as a bare value, i.e. not immediately followed by a member access.
const BARE_ROOT_RE = new RegExp(`${ROOT}(?!\\s*(?:\\??\\.|\\[))`, 'g');
const GLOBALTHIS_ALIAS_RE = /(?<![=!<>])=\s*globalThis(?![\w$])(?!\s*(?:\??\.|\[))/g;
const ENV_MODULE_RE = new RegExp(
  [
    String.raw`(?:(?<![\w$])from|(?<![\w$.])(?:require|import)\s*\()\s*(${Q})(?:node:)?process\1`,
    String.raw`(?<![\w$.])(?:require|import)\s*\(\s*(${Q})bun\2`,
    String.raw`(?<![\w$])import\s+[^;]*?(?:\*|(?<![\w$])env(?![\w$]))[^;]*?\bfrom\s*(${Q})bun\3`,
  ].join('|'),
  'g',
);

/** Chars after which a `/` starts a regex literal rather than a division. (`)` is decided separately.) */
const REGEX_PRECEDERS = new Set([...'(,=:[!&|?{};+-*%<>~^']);
const REGEX_KEYWORD_BEFORE =
  /(?:^|[^\w$])(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/;

/** Whether a `/` right after `before` (code so far, trailing whitespace trimmed) starts a regex. */
function slashStartsRegex(before: string): boolean {
  const prev = before[before.length - 1];
  if (prev === undefined) return true;
  if (before.endsWith('++') || before.endsWith('--')) return false; // `a++ / 2`
  if (prev === ')') {
    // `if (a) /re/.test(s)` — a regex only after the head of if/while/for/with
    let depth = 0;
    for (let k = before.length - 1; k >= 0; k--) {
      if (before[k] === ')') depth++;
      else if (before[k] === '(' && --depth === 0)
        return /(?:^|[^\w$.])(?:if|while|for|with)\s*$/.test(before.slice(0, k));
    }
    return false;
  }
  return REGEX_PRECEDERS.has(prev) || REGEX_KEYWORD_BEFORE.test(before);
}

/** A regex candidate's text that must not be blanked, in case the `/` was really a division. */
function mayHideEnvCode(body: string): boolean {
  return (
    new RegExp(ENV_RE.source).test(body) ||
    (body.includes(';') && /(?<![\w$])(?:process|Bun|globalThis)(?![\w$])/.test(body))
  );
}

/**
 * `source` with comments blanked and string/template/regex literal text emptied (identifier-like and
 * `node:`-module strings kept verbatim, `${…}` bodies kept as code), every newline preserved so offsets
 * map back to the original lines.
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
  /** The template `source[i, end)` with its text blanked and each `${…}` body stripped as code. */
  const stripTemplate = (i: number, end: number): string => {
    let r = '`';
    let j = i + 1;
    while (j < end) {
      const c = source[j] as string;
      if (c === '\\') {
        r += blank(source.slice(j, j + 2));
        j += 2;
      } else if (c === '$' && source[j + 1] === '{') {
        const close = Math.min(expressionEnd(j + 2), end);
        const closed = source[close - 1] === '}';
        const body = source.slice(j + 2, closed ? close - 1 : close);
        r += `\${${stripCommentsAndLiterals(body)}${closed ? '}' : ''}`;
        j = close;
      } else {
        r += c === '`' ? c : blank(c);
        j++;
      }
    }
    return r.slice(0, end - i);
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
    return /^(?:node:)?[\w$]*$/.test(body) && literal.endsWith(quote) ? literal : quote + blank(body) + quote;
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
      replacement = literal.includes('${') ? stripTemplate(i, end) : keepOrEmpty(literal, '`');
    } else if (c === '/' && slashStartsRegex(out.trimEnd())) {
      const candidate = regexEnd(i);
      if (!mayHideEnvCode(source.slice(i + 1, candidate - 1))) {
        end = candidate;
        replacement = `/${blank(source.slice(i + 1, end - 1))}/`;
      }
    }
    if (end === -1) {
      out += c;
      i++;
    } else {
      out += replacement.length === end - i ? replacement : replacement.padEnd(end - i).slice(0, end - i);
      i = end;
    }
  }
  return out;
}

/** Whether a bracket enclosing `code[from]` closes and is then assigned to — `[env.X] = …`,
 *  `({ a: env.X } = …)`, `(env.X) = …`. Stops at a `;` on the starting level. */
function enclosingTargetAssigned(code: string, from: number): boolean {
  let depth = 0;
  for (let j = from; j < code.length; j++) {
    const c = code[j];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth > 0) depth--;
      else {
        ASSIGN_AFTER_CLOSER_RE.lastIndex = j + 1;
        if (ASSIGN_AFTER_CLOSER_RE.test(code)) return true;
      }
    } else if (c === ';' && depth === 0) return false;
  }
  return false;
}

/** `[index, kind]` for every disallowed env use in already-stripped `code`. */
function scanStripped(code: string): Array<[number, string]> {
  const hits: Array<[number, string]> = [];
  for (const m of code.matchAll(ENV_RE)) {
    const start = m.index;
    const envEnd = start + m[0].length;
    const before = code.slice(0, start);
    MEMBER_RE.lastIndex = envEnd;
    const member = MEMBER_RE.exec(code);
    if (member) {
      const end = MEMBER_RE.lastIndex;
      WRITE_AFTER_RE.lastIndex = end;
      if (WRITE_BEFORE_RE.test(before) || WRITE_AFTER_RE.test(code)) hits.push([start, 'write to an env var']);
      else if (enclosingTargetAssigned(code, end)) hits.push([start, 'env var inside an assigned pattern/target']);
      continue;
    }
    ASSIGN_AFTER_CLOSER_RE.lastIndex = envEnd;
    if (ASSIGN_AFTER_CLOSER_RE.test(code)) hits.push([start, 'replacing the env object']);
    else if (!BARE_READ_BEFORE_RE.test(before)) hits.push([start, 'env object used outside an allowed read']);
    else if (enclosingTargetAssigned(code, envEnd)) hits.push([start, 'env object inside an assigned pattern']);
  }
  for (const m of code.matchAll(BARE_ROOT_RE)) {
    if (/(?<![\w$])typeof\s*$/.test(code.slice(0, m.index))) continue;
    hits.push([m.index, 'process/Bun used as a bare value (aliasing)']);
  }
  for (const m of code.matchAll(GLOBALTHIS_ALIAS_RE)) hits.push([m.index, 'aliasing globalThis']);
  for (const m of code.matchAll(ENV_MODULE_RE)) hits.push([m.index, 'importing env from process/bun']);
  return hits;
}

/** Every disallowed env use in `source`, as `line N: <kind>: <original line text>`. */
function findEnvWrites(source: string): string[] {
  const lines = source.split('\n');
  const hits = new Set<string>();
  const code = stripCommentsAndLiterals(source);
  for (const [index, kind] of scanStripped(code)) {
    const line = code.slice(0, index).split('\n').length;
    hits.add(`line ${line}: ${kind}: ${(lines[line - 1] ?? '').trim()}`);
  }
  return [...hits];
}

function testFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    // fixtures/ included: a .ts helper there runs in the test process like any other; data files
    // (.jsonl, .json, .md) never match SOURCE_FILE.
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
    // (a) writes inside a template's `${…}` expression
    // biome-ignore lint/suspicious/noTemplateCurlyInString: JS source text under test, not a template
    'const t = `${(process.env.X = prev)}`;',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: JS source text under test, not a template
    'const t = `a ${`b ${(process.env.X = prev)}`} c`;',
    // (b) a division misread as a regex, a regex misread as a division
    "x = a++ / 2; process.env.X = prev; y = 'q' / 1;",
    'x = a / b; process.env.X = prev; y = c / d;',
    "if (a) /'/.test(s); process.env.X = prev;",
    "while (a) /'/.test(s); process.env.X = prev;",
    // (c) parenthesised / bracketed / aliased roots
    '(process.env).X = prev;',
    '(process).env.X = prev;',
    '(process.env.X) = prev;',
    '(process.env.X as string) = prev;',
    'process.env.X! = prev;',
    "globalThis['process']['env'].X = prev;",
    'globalThis["process"].env.X = prev;',
    '(globalThis as any).process.env.X = prev;',
    'import.meta.env.X = prev;',
    "import { env } from 'node:process';\nenv.X = prev;",
    "import { env } from 'process';",
    "import * as p from 'node:process';\np.env.X = prev;",
    "import p from 'node:process';",
    "require('node:process').env.X = prev;",
    "const { env } = require('process');",
    "const p = await import('node:process');",
    "import { env } from 'bun';",
    "import * as bun from 'bun';",
    "const { env } = require('bun');",
    'const proc = process; proc.env.X = prev;',
    'const B = Bun; B.env.X = prev;',
    'const g = globalThis; g.process.env.X = prev;',
    'let g; g = globalThis;',
    'const p = globalThis.process; p.env.X = prev;',
    'mutate(process);',
    'process!.env.X = prev;',
    // (d) indirect writes through the env object
    'Object.assign((process.env), s);',
    "Object['assign'](process.env, s);",
    'Reflect.apply(Object.assign, null, [process.env, s]);',
    'mutate(process.env);',
    'const o = { e: process.env };',
    'return process.env;',
    '[process.env.X] = [prev];',
    '[a, [process.env.X]] = [1, [prev]];',
    '({a: process.env.X} = o);',
    '({ env: process.env } = o);',
    'for (process.env.X of xs) {}',
    'for (process.env.X in o) {}',
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
    'const v = import.meta.env.X;',
    'const v = process.env.X ?? "d";',
    'const v = process.env.X || "d";',
    'const v = c ? process.env.X : "d";',
    'const v = process.env.X?.trim();',
    'const v = [process.env.A, process.env.B];',
    'f({ a: process.env.A }, [process.env.B]);',
    '(process.env.X);',
    'if (process.env.X) { [a] = b; }',
    'if (process.env.X) a = 1;',
    'const f = (a = process.env.X) => a;',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: JS source text under test, not a template
    'const s = `${a}:${process.env.PATH}`;',
    'for (const k of Object.keys(process.env)) {}',
    'for (const k in process.env) {}',
    'Object.hasOwn(process.env, "X");',
    'const t = typeof process;',
    'type E = typeof process.env;',
    "const v = process['env'].X;",
    "import { spawn } from 'node:child_process';",
    "import { $ } from 'bun';",
    "import { test } from 'bun:test';",
    'const r = /child process exited/;',
    'const ok = process.exitCode === 0 && process.pid > 0;',
    'const n = a++ / 2;',
  ]) {
    assert.deepEqual(findEnvWrites(ok), [], `should not flag: ${ok}`);
  }
});

test('env hygiene: the detector reports the line of the env reference', () => {
  assert.deepEqual(findEnvWrites('const a = 1;\n\nprocess.env\n  .X = prev;'), [
    'line 3: write to an env var: process.env',
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

test('env hygiene: .ts sources under fixtures/ are scanned, data files are not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'env-hygiene-files-'));
  try {
    mkdirSync(join(dir, 'fixtures', 'nested'), { recursive: true });
    for (const f of [
      'a.test.ts',
      'fixtures/helper.ts',
      'fixtures/nested/x.mjs',
      'fixtures/run.jsonl',
      'fixtures/d.json',
    ]) {
      writeFileSync(join(dir, f), '');
    }
    const found = testFiles(dir)
      .map(f => relative(dir, f).split('\\').join('/'))
      .sort();
    assert.deepEqual(found, ['a.test.ts', 'fixtures/helper.ts', 'fixtures/nested/x.mjs']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
