import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';

// Guard for the `process.env.X = prev` restore bug: when `X` was unset, `prev` is `undefined`, and
// assigning `undefined` to `process.env` stores the *string* "undefined" — a restored
// `PI_CODING_AGENT_DIR="undefined"` once sent a straggling run's transcript into a relative
// `undefined/delegate/outputs/...` directory inside the repo. Every env mutation in tests must go
// through `tests/helpers/env.ts` (`withEnv`/`restoreEnv`, which delete-when-unset); this test fails on
// any direct write elsewhere, so the unsafe shape can't creep back in.

const TESTS_DIR = import.meta.dirname;
const ALLOWED = new Set(['helpers/env.ts', 'env-hygiene.test.ts']);

const WRITE_PATTERNS: Array<[string, RegExp]> = [
  [
    'assignment to process.env.X / process.env[...]',
    /process\.env(?:\.[A-Za-z_$][\w$]*|\[[^\]]+\])\s*(?:=(?!=)|\?\?=|\|\|=)/,
  ],
  ['replacing process.env', /process\.env\s*=(?!=)/],
  ['delete process.env', /delete\s+process\.env/],
  ['Object.assign(process.env, ...)', /Object\.assign\(\s*process\.env\b/],
];

function testFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'fixtures' || entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...testFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Every direct `process.env` write in `source`, as `line N: <kind>: <text>`. */
function findEnvWrites(source: string): string[] {
  const hits: string[] = [];
  source.split('\n').forEach((line, i) => {
    for (const [kind, re] of WRITE_PATTERNS) {
      if (re.test(line)) hits.push(`line ${i + 1}: ${kind}: ${line.trim()}`);
    }
  });
  return hits;
}

test('env hygiene: the detector flags every unsafe write shape and ignores reads', () => {
  for (const bad of [
    'process.env.PI_CODING_AGENT_DIR = prev;',
    "process.env['FAKE_ARGS_FILE'] = prevArgs;",
    'process.env[name] = value;',
    'process.env.X ??= y;',
    'delete process.env.X;',
    'Object.assign(process.env, saved);',
    'process.env = { ...saved };',
  ]) {
    assert.equal(findEnvWrites(bad).length > 0, true, bad);
  }
  for (const ok of [
    "const LIVE = process.env.PI_DELEGATE_LIVE === '1';",
    'const prev = process.env.PATH;',
    'withEnv({ PATH: `${binDir}:${process.env.PATH}` }, fn);',
    'if (process.env.X == null) return;',
  ]) {
    assert.deepEqual(findEnvWrites(ok), [], ok);
  }
});

test('env hygiene: no test file writes process.env directly (use tests/helpers/env.ts)', () => {
  const offenders: string[] = [];
  for (const file of testFiles(TESTS_DIR)) {
    const rel = relative(TESTS_DIR, file).split('\\').join('/');
    if (ALLOWED.has(rel)) continue;
    for (const hit of findEnvWrites(readFileSync(file, 'utf8'))) offenders.push(`tests/${rel} ${hit}`);
  }
  assert.deepEqual(
    offenders,
    [],
    'Write env vars via withEnv()/restoreEnv() from tests/helpers/env.ts — a bare `process.env.X = prev` ' +
      'stores the string "undefined" when X was unset.',
  );
});
