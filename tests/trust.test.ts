import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { isProjectTrusted, warnIfProjectTemplatesSkipped } from '../extensions/engine.ts';

/** isProjectTrusted is the only trust anchor (pi's own store, outside the project) — it must fail
 *  closed on anything other than an explicit `true` from the host. */
test('isProjectTrusted: fails closed when the host API is missing, throws, or says anything but true', () => {
  const ctx = (extra: Record<string, unknown>) => ({ cwd: '/repo', hasUI: false, ...extra }) as never;
  assert.equal(isProjectTrusted(ctx({})), false, 'missing');
  assert.equal(isProjectTrusted(ctx({ isProjectTrusted: 'yes' })), false, 'not a function');
  assert.equal(
    isProjectTrusted(
      ctx({
        isProjectTrusted: () => {
          throw new Error('trust store unreadable');
        },
      }),
    ),
    false,
    'throws',
  );
  assert.equal(isProjectTrusted(ctx({ isProjectTrusted: () => false })), false, 'false');
  for (const v of [undefined, null, 1, 'true', {}]) {
    assert.equal(isProjectTrusted(ctx({ isProjectTrusted: () => v })), false, `truthy-ish ${String(v)}`);
  }
  assert.equal(isProjectTrusted(ctx({ isProjectTrusted: () => true })), true, 'explicit true');
});

function tmpProject(withTemplates: boolean): string {
  const cwd = mkdtempSync(join(tmpdir(), 'trust-test-'));
  if (withTemplates) {
    const dir = join(cwd, '.pi', 'delegate', 'templates');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'review.md'), '---\nname: review\npermission: edit\n---\nbody\n');
  }
  return cwd;
}

function capture(cwd: string, hasUI: boolean) {
  const notes: string[] = [];
  let stderr = '';
  const ctx = {
    cwd,
    hasUI,
    ui: { notify: (msg: string) => notes.push(msg) },
  } as never;
  const run = (trusted: boolean) => {
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    try {
      warnIfProjectTemplatesSkipped(ctx, trusted);
    } finally {
      process.stderr.write = orig;
    }
  };
  return { run, notes, stderr: () => stderr };
}

test('warnIfProjectTemplatesSkipped: warns once per cwd for an untrusted project with templates', () => {
  const cwd = tmpProject(true);
  try {
    const ui = capture(cwd, true);
    ui.run(false);
    ui.run(false);
    ui.run(false);
    assert.equal(ui.notes.length, 1, 'exactly one notice per cwd, however many delegations');
    assert.match(ui.notes[0], /templates/i);
    // a different cwd gets its own (single) notice
    const other = tmpProject(true);
    try {
      const headless = capture(other, false);
      headless.run(false);
      headless.run(false);
      assert.match(headless.stderr(), /templates/i);
      const once = headless.stderr();
      headless.run(false);
      assert.equal(headless.stderr(), once, 'headless also warns only once');
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('warnIfProjectTemplatesSkipped: silent when trusted or when the project has no templates', () => {
  const withTpl = tmpProject(true);
  const without = tmpProject(false);
  try {
    const trusted = capture(withTpl, true);
    trusted.run(true);
    assert.deepEqual(trusted.notes, [], 'trusted: templates load, nothing to warn about');
    const none = capture(without, true);
    none.run(false);
    assert.deepEqual(none.notes, [], 'untrusted but nothing skipped: never nag');
    // and being silent once doesn't burn the once-per-cwd budget: templates appearing later still warn
    const dir = join(without, '.pi', 'delegate', 'templates');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'x.md'), '---\nname: x\n---\nb\n');
    none.run(false);
    assert.equal(none.notes.length, 1);
    // nor does a trusted call: the same cwd warns on its first untrusted call
    trusted.run(false);
    assert.equal(trusted.notes.length, 1);
  } finally {
    rmSync(withTpl, { recursive: true, force: true });
    rmSync(without, { recursive: true, force: true });
  }
});
