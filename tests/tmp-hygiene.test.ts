import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { makeTempDir, removeTempDir, sweepTempDirs, trackedTempDirs } from './helpers/tmp.ts';

// Guard for leaked temp dirs: every test temp dir must come from `makeTempDir` (tests/helpers/tmp.ts), which
// registers it so the preload sweeps whatever a test forgot. A raw `mkdtempSync(join(tmpdir(), …))` is
// invisible to that sweep and leaks into $TMPDIR on every run (thousands of `acp-runner-test-*` dirs did).
//
// Static scan: any `mkdtemp`/`mkdtempSync`/`tmpdir(` under tests/ outside the allow-list fails. Comments are
// blanked first (a plain line/block-comment regex). Known false positives: a `//` or `/*` inside a string
// literal or regex blanks the rest of that line / up to the next `*/`, which could hide a call written
// after it on the same line; and a string literal that merely contains `tmpdir(` is flagged — write it
// differently. Neither has occurred; a hit is cheap to rework, a miss is the leak.

const TESTS_DIR = import.meta.dirname;
const SOURCE_FILE = /\.[cm]?[jt]sx?$/;
/** Files allowed to call the raw APIs: the helper itself, and the preload (its pinned agent dir has its own
 *  signal/afterAll cleanup, and the preload must not depend on the registry to protect the real agent dir). */
const ALLOWED = new Set(['helpers/tmp.ts', 'helpers/preload.ts', 'tmp-hygiene.test.ts']);
const RAW_TEMP = /(?<![\w$])(?:mkdtemp(?:Sync)?|tmpdir)\s*[(,}]|(?<![\w$])(?:mkdtemp(?:Sync)?)\b/g;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(p));
    else if (SOURCE_FILE.test(entry.name)) out.push(p);
  }
  return out;
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' ')).replace(/\/\/[^\n]*/g, '');
}

/** `line: text` for every raw temp-dir API use in `source`. */
export function findRawTempUse(source: string): string[] {
  const code = stripComments(source);
  const hits: string[] = [];
  for (const m of code.matchAll(RAW_TEMP)) {
    const line = code.slice(0, m.index).split('\n').length;
    hits.push(`line ${line}: ${m[0]}`);
  }
  return hits;
}

test('tmp hygiene: no test creates temp dirs directly (use makeTempDir from tests/helpers/tmp.ts)', () => {
  const offenders: string[] = [];
  for (const file of sourceFiles(TESTS_DIR)) {
    const rel = relative(TESTS_DIR, file).split('\\').join('/');
    if (ALLOWED.has(rel)) continue;
    for (const hit of findRawTempUse(readFileSync(file, 'utf8'))) offenders.push(`tests/${rel} ${hit}`);
  }
  assert.equal(
    offenders.length,
    0,
    `Create temp dirs with makeTempDir() (tests/helpers/tmp.ts) so the preload can sweep them. Offenders:\n${offenders.join('\n')}`,
  );
});

test('tmp hygiene: the scan flags the raw shapes and ignores comments', () => {
  for (const bad of [
    "mkdtempSync(join(tmpdir(), 'x-'))",
    "const { mkdtempSync } = await import('node:fs');",
    "import { tmpdir } from 'node:os'; const t = tmpdir();",
    "fs.mkdtemp('x', cb)",
    'join(tmpdir (), 1)',
  ]) {
    assert.ok(findRawTempUse(bad).length > 0, bad);
  }
  for (const ok of [
    "makeTempDir('x-')",
    '// mkdtempSync(join(tmpdir(), "x"))',
    '/* os.tmpdir() mkdtemp\n mkdtempSync */ const a = 1;',
    'const tempRoot = () => 1; tempRoot()',
  ]) {
    assert.deepEqual(findRawTempUse(ok), [], ok);
  }
});

test('makeTempDir: creates under the temp root, registers, and removeTempDir unregisters', () => {
  const dir = makeTempDir('tmp-hygiene-a-');
  assert.ok(existsSync(dir));
  assert.ok(trackedTempDirs().includes(dir));
  removeTempDir(dir);
  assert.equal(existsSync(dir), false);
  assert.ok(!trackedTempDirs().includes(dir));
  removeTempDir(dir); // idempotent
});

test('sweepTempDirs: removes the dirs it is given, never follows a symlink out of them', () => {
  const mine = makeTempDir('tmp-hygiene-b-');
  const outside = makeTempDir('tmp-hygiene-outside-'); // registered, but not part of this sweep
  writeFileSync(join(outside, 'keep.txt'), 'keep');
  mkdirSync(join(mine, 'sub'));
  writeFileSync(join(mine, 'sub', 'f'), 'x');
  symlinkSync(outside, join(mine, 'link')); // a link to a live dir outside `mine`
  try {
    assert.deepEqual(sweepTempDirs([mine]), []);
    assert.equal(existsSync(mine), false, 'the swept dir is gone');
    assert.ok(!trackedTempDirs().includes(mine));
    assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'keep', 'the symlink target is untouched');
    assert.ok(trackedTempDirs().includes(outside), 'an unswept dir stays registered');
  } finally {
    removeTempDir(mine);
    removeTempDir(outside);
  }
});
