import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { makeTempDir, removeTempDir, sweepTempDirs, trackedTempDirs } from './helpers/tmp.ts';

// Guard for leaked temp dirs: every test temp dir must come from `makeTempDir` (tests/helpers/tmp.ts), which
// registers it so the preload sweeps whatever a test forgot. A raw `mkdtempSync(join(tmpdir(), …))` is
// invisible to that sweep and leaks into $TMPDIR on every run (thousands of `acp-runner-test-*` dirs did).
//
// Static scan over tests/ (outside the allow-list), comments blanked first (a plain line/block-comment regex).
// It flags, as identifiers (so `import { tmpdir as t }`, `os.tmpdir`, `fs.promises.mkdtemp`, aliases and
// destructuring all match): `mkdtemp*`, `tmpdir`, `mktemp`, `TMPDIR`; any `/var/folders`/`/private/tmp`
// literal; a `/tmp` literal on a line that also creates/writes something (`Bun.write('/tmp/x')`,
// `mkdirSync('/tmp/x')`, …); and `tempRoot()` anywhere except on a line that only *asserts* about it
// (`startsWith`/`relative`/`isAbsolute`) — `tempRoot()` names the temp root, so `join(tempRoot(), 'leak')`
// would be an unregistered dir by another name.
//
// Known misses (heuristics, not a parser): a `/tmp` literal that is stored and used on a different line
// (`const d = '/tmp/x'; mkdirSync(d)`); a path built from pieces (`'/t' + 'mp'`); `tempRoot()` stored in a
// variable on an assert-looking line. Known false positives: a `//` or `/*` inside a string literal or regex
// blanks the rest of that line / up to the next `*/`, which could hide a call written after it on the same
// line; and a string literal that merely contains one of the names above is flagged — write it differently
// (a `/tmp/...` literal used as inert path data on a line with no fs call is fine). A hit is cheap to
// rework, a miss is the leak.

const TESTS_DIR = import.meta.dirname;
const SOURCE_FILE = /\.[cm]?[jt]sx?$/;
/** Files allowed to call the raw APIs: the helper itself, and the preload (its pinned agent dir has its own
 *  signal/afterAll cleanup, and the preload must not depend on the registry to protect the real agent dir). */
const ALLOWED = new Set(['helpers/tmp.ts', 'helpers/preload.ts', 'tmp-hygiene.test.ts']);
const IDENTIFIER_RULES: RegExp[] = [
  /(?<![\w$])mkdtemp\w*/g,
  /(?<![\w$])tmpdir(?![\w$])/g,
  /(?<![\w$])mktemp(?![\w$])/g,
  /(?<![\w$])TMPDIR(?![\w$])/g,
];
const ALWAYS_TEMP_PATH = /(?:\/var\/folders|\/private\/tmp)\b/g;
const TMP_LITERAL = /['"`]\/tmp(?:\/|['"`])/;
const FS_WRITE =
  /(?:Bun\.write|\b(?:write|append|mkdir|copy|cp|rename|symlink|link|createWrite|open|rm|unlink|rmdir|truncate)\w*)\s*\(/;
const TEMP_ROOT_CALL = /(?<![\w$])tempRoot\s*\(/;
const TEMP_ROOT_ASSERT_ONLY = /\b(?:startsWith|relative|isAbsolute)\s*\(/;

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

/** `line N: text` for every raw temp-dir API use in `source`. */
export function findRawTempUse(source: string): string[] {
  const lines = stripComments(source).split('\n');
  const hits: string[] = [];
  lines.forEach((line, i) => {
    const found: string[] = [];
    for (const re of [...IDENTIFIER_RULES, ALWAYS_TEMP_PATH]) for (const m of line.matchAll(re)) found.push(m[0]);
    if (TMP_LITERAL.test(line) && FS_WRITE.test(line)) found.push('/tmp literal on an fs-writing line');
    if (
      TEMP_ROOT_CALL.test(line) &&
      (!TEMP_ROOT_ASSERT_ONLY.test(line) || FS_WRITE.test(line) || /\b(?:join|resolve)\s*\(/.test(line))
    )
      found.push('tempRoot() used to build a path');
    for (const f of found) hits.push(`line ${i + 1}: ${f}`);
  });
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
    "import { tmpdir as t } from 'node:os'; t();",
    "import { tmpdir as t } from 'node:os';",
    "const { tmpdir } = os; join(tmpdir, 'x')",
    "join(tempRoot(), 'leak')",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source text under test, not a template
    'const d = `${tempRoot()}/leak`; mkdirSync(d)',
    "mkdirSync(tempRoot() + '/leak')",
    "writeFileSync('/tmp/leak.txt', 'x')",
    "await Bun.write('/tmp/leak.txt', 'x')",
    "mkdirSync('/private/tmp/leak')",
    "const d = '/var/folders/ab/T/leak'",
    'const d = process.env.TMPDIR;',
    "spawnSync('sh', ['-c', 'mktemp -d'])",
    "const { mkdtemp } = await import('node:fs/promises');",
    "import { mkdtemp as m } from 'node:fs/promises';",
    "import { mkdtempSync as m } from 'node:fs'; m('x')",
    "fs.promises.mkdtemp('x')",
  ]) {
    assert.ok(findRawTempUse(bad).length > 0, bad);
  }
  for (const ok of [
    "makeTempDir('x-')",
    '// mkdtempSync(join(tmpdir(), "x"))',
    '/* os.tmpdir() mkdtemp\n mkdtempSync */ const a = 1;',
    'const tempRoot = () => 1;',
    "assert.ok(realpathSync(dir).startsWith(realpathSync(tempRoot()) + sep), 'under the temp root')",
    "const o = { cwd: '/tmp', file: '/tmp/out.md' };",
    "assert.equal(agentDir(), '/tmp/some-test-override')",
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

/** Run `fn` and collect the process warnings it (or the next tick) emitted. */
async function warningsDuring(fn: () => void): Promise<string[]> {
  const seen: string[] = [];
  const listener = (w: Error) => seen.push(w.message);
  process.on('warning', listener);
  try {
    fn();
    await new Promise(resolve => setTimeout(resolve, 20)); // 'warning' is emitted on a later tick
  } finally {
    process.off('warning', listener);
  }
  return seen;
}

test('registry: a dir removed with a raw rmSync and recreated by someone else survives the sweep', async () => {
  const dir = makeTempDir('tmp-hygiene-stale-');
  rmSync(dir, { recursive: true }); // a call site that cleans up without removeTempDir: a dead entry stays
  mkdirSync(dir); // ... and something else later reuses the exact path
  writeFileSync(join(dir, 'foreign.txt'), 'not ours');
  try {
    const warnings = await warningsDuring(() => assert.deepEqual(sweepTempDirs([dir]), []));
    assert.equal(readFileSync(join(dir, 'foreign.txt'), 'utf8'), 'not ours', 'the foreign dir is left alone');
    assert.ok(!trackedTempDirs().includes(dir), 'the stale entry is dropped');
    assert.equal(warnings.filter(w => w.includes(dir)).length, 1, `exactly one warning naming the path: ${warnings}`);
  } finally {
    rmSync(dir, { recursive: true, force: true }); // not registered any more: raw cleanup of our own scratch
  }
});

test('registry: a dir that vanished is unregistered silently', async () => {
  const dir = makeTempDir('tmp-hygiene-vanished-');
  rmSync(dir, { recursive: true });
  const warnings = await warningsDuring(() => assert.deepEqual(sweepTempDirs([dir]), []));
  assert.deepEqual(warnings, []);
  assert.ok(!trackedTempDirs().includes(dir));
  removeTempDir(dir); // already released: a no-op, not an error
});

test('registry: a dir replaced by a symlink is not followed or deleted; the target stays intact', async () => {
  const dir = makeTempDir('tmp-hygiene-swap-');
  const target = makeTempDir('tmp-hygiene-swap-target-');
  writeFileSync(join(target, 'keep.txt'), 'keep');
  rmSync(dir, { recursive: true });
  symlinkSync(target, dir);
  try {
    const warnings = await warningsDuring(() => removeTempDir(dir));
    assert.equal(readFileSync(join(target, 'keep.txt'), 'utf8'), 'keep', 'the link target is intact');
    assert.ok(lstatSync(dir).isSymbolicLink(), 'the foreign link is left in place');
    assert.ok(!trackedTempDirs().includes(dir));
    assert.equal(warnings.filter(w => w.includes(dir)).length, 1, `one warning: ${warnings}`);
  } finally {
    rmSync(dir, { force: true }); // unlinks the link only
    removeTempDir(target);
  }
});

test('registry: removeTempDir refuses unregistered paths, trailing-slash symlink spellings and normalises `..`', () => {
  const real = makeTempDir('tmp-hygiene-real-');
  const holder = makeTempDir('tmp-hygiene-holder-');
  writeFileSync(join(real, 'keep.txt'), 'keep');
  const link = join(holder, 'link');
  symlinkSync(real, link);
  try {
    assert.throws(() => removeTempDir(join(holder, 'never-made')), /not a directory created by makeTempDir/);
    assert.throws(() => removeTempDir(link), /not a directory created by makeTempDir/);
    assert.throws(() => removeTempDir(`${link}/`), /not a directory created by makeTempDir/, 'no following the link');
    assert.throws(() => removeTempDir(join(real, '..', 'x')), /not a directory created/);
    assert.equal(readFileSync(join(real, 'keep.txt'), 'utf8'), 'keep', 'the symlink target is untouched');
    // a registered dir spelled with a trailing slash / a `..` detour is the same registered dir
    removeTempDir(`${holder}/`);
    assert.equal(existsSync(holder), false);
    removeTempDir(join(real, 'sub', '..'));
    assert.equal(existsSync(real), false);
  } finally {
    rmSync(holder, { recursive: true, force: true });
    rmSync(real, { recursive: true, force: true });
  }
});

test('registry: sweepTempDirs ignores (with a warning) a path that was never registered', async () => {
  const holder = makeTempDir('tmp-hygiene-unreg-');
  const other = join(holder, 'never-registered');
  mkdirSync(other);
  writeFileSync(join(other, 'sentinel'), 'x');
  try {
    const warnings = await warningsDuring(() => assert.deepEqual(sweepTempDirs([other]), []));
    assert.ok(existsSync(join(other, 'sentinel')), 'an unregistered dir is never removed');
    assert.equal(warnings.filter(w => w.includes(other)).length, 1, `${warnings}`);
  } finally {
    removeTempDir(holder);
  }
});

test('makeTempDir: a relative TMPDIR is refused, so a chdir can never repoint a registered path', () => {
  const cwd = makeTempDir('tmp-hygiene-reltmp-');
  mkdirSync(join(cwd, 'rel'));
  const helper = join(import.meta.dirname, 'helpers', 'tmp.ts');
  const script = join(cwd, 'probe.ts');
  writeFileSync(
    script,
    `import { makeTempDir } from ${JSON.stringify(helper)};\ntry { console.log('MADE ' + makeTempDir('p-')); } catch (e) { console.log('REFUSED ' + (e as Error).message); }\n`,
  );
  try {
    const run = spawnSync(process.execPath, [script], {
      cwd,
      env: { ...process.env, TMPDIR: 'rel' },
      encoding: 'utf8',
    });
    assert.match(run.stdout, /REFUSED .*not absolute/, run.stdout + run.stderr);
    assert.deepEqual(readdirSync(join(cwd, 'rel')), [], 'nothing was created under the relative root');
  } finally {
    removeTempDir(cwd);
  }
});

/**
 * Run a child `bun test` (from the repo root, so bunfig.toml's preload applies) on a one-test file, with its
 * own temp root. With `lockRoot` the child's test makes the root read-only after creating a tracked dir, so
 * the end-of-run sweep cannot remove that dir (unlinking an entry needs write permission on its parent).
 */
function runChildWithTempRoot(lockRoot: boolean): { code: number | null; output: string } {
  const outer = makeTempDir('tmp-hygiene-child-');
  const root = join(outer, 'root');
  mkdirSync(root);
  const file = join(outer, 'child.test.ts');
  const helper = JSON.stringify(join(import.meta.dirname, 'helpers', 'tmp.ts'));
  writeFileSync(
    file,
    [
      "import { test } from 'node:test';",
      "import { chmodSync } from 'node:fs';",
      `import { makeTempDir, tempRoot } from ${helper};`,
      `test('child', () => { makeTempDir('tracked-'); if (${lockRoot}) chmodSync(tempRoot(), 0o555); });`,
    ].join('\n'),
  );
  try {
    const run = spawnSync(process.execPath, ['test', file], {
      cwd: join(import.meta.dirname, '..'),
      env: { ...process.env, TMPDIR: root },
      encoding: 'utf8',
      timeout: 90_000,
    });
    return { code: run.status, output: run.stdout + run.stderr };
  } finally {
    chmodSync(root, 0o755);
    removeTempDir(outer);
  }
}

test('preload: a tracked dir that cannot be removed fails the run (non-zero exit)', { timeout: 120_000 }, t => {
  if (process.platform === 'win32' || process.getuid?.() === 0)
    return t.skip('needs POSIX permissions and a non-root user');
  const control = runChildWithTempRoot(false);
  assert.equal(control.code, 0, `control run (nothing stuck) must pass: ${control.output}`);
  const stuck = runChildWithTempRoot(true);
  assert.notEqual(stuck.code, 0, `a stuck tracked dir must fail the run: ${stuck.output}`);
  assert.match(stuck.output, /temp dir leak \(tests\/helpers\/tmp\.ts\): could not remove .*tracked-/);
});

test('registry: a dir replaced by a dangling symlink counts as replaced (lstat, not stat), not as vanished', async () => {
  const dir = makeTempDir('tmp-hygiene-dangling-');
  rmSync(dir, { recursive: true });
  symlinkSync(join(dir, 'nowhere'), dir); // a link whose target does not exist: stat() throws, lstat() sees it
  try {
    const warnings = await warningsDuring(() => assert.deepEqual(sweepTempDirs([dir]), []));
    assert.ok(lstatSync(dir).isSymbolicLink(), 'the foreign link is left in place');
    assert.equal(warnings.filter(w => w.includes(dir)).length, 1, `a replaced dir warns: ${warnings}`);
  } finally {
    rmSync(dir, { force: true });
  }
});

test('registry: sweepTempDirs normalises the paths it is given (trailing slash) before matching', () => {
  const dir = makeTempDir('tmp-hygiene-norm-');
  writeFileSync(join(dir, 'f'), 'x');
  assert.deepEqual(sweepTempDirs([`${dir}/`]), []);
  assert.equal(existsSync(dir), false, 'the registered dir was swept via its trailing-slash spelling');
  assert.ok(!trackedTempDirs().includes(dir));
});
