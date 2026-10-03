import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ampHarness } from '../extensions/harnesses/amp.ts';
import { claudeHarness } from '../extensions/harnesses/claude.ts';
import { codexHarness } from '../extensions/harnesses/codex.ts';
import { devinHarness } from '../extensions/harnesses/devin.ts';
import { opencodeHarness } from '../extensions/harnesses/opencode.ts';
import type { BuildArgsOpts, Harness, NormalizedPermission } from '../extensions/harnesses/types.ts';

/**
 * Table tests for every harness's `buildArgs`: permission × resume × model × addDirs. Each harness's
 * CLI has rejected flags this repo once assumed (see AGENTS.md Gotchas) — the negative assertions
 * pin those out so a regression fails here instead of on every real delegation.
 */

const PERMS: NormalizedPermission[] = ['readonly', 'edit', 'danger'];
const PROMPT = 'do the thing';
const SESSION = 'sess-123';
const MODEL = 'some-model';
const DIRS = ['/abs/one', '/abs/two'];

interface Combo {
  permission: NormalizedPermission;
  resume: boolean;
  model: boolean;
  addDirs: boolean;
}

function* combos(): Generator<Combo> {
  for (const permission of PERMS)
    for (const resume of [false, true])
      for (const model of [false, true])
        for (const addDirs of [false, true]) yield { permission, resume, model, addDirs };
}

function build(h: Harness, c: Combo): string[] {
  const opts: BuildArgsOpts = {
    prompt: PROMPT,
    cwd: '/repo',
    permission: c.permission,
    ...(c.resume ? { resumeSessionId: SESSION } : {}),
    ...(c.model ? { model: MODEL } : {}),
    ...(c.addDirs ? { addDirs: DIRS } : {}),
  };
  return h.buildArgs(opts);
}

const label = (h: Harness, c: Combo) =>
  `${h.name} ${c.permission}${c.resume ? ' +resume' : ''}${c.model ? ' +model' : ''}${c.addDirs ? ' +addDirs' : ''}`;

/** The value right after `flag` (first occurrence), or undefined. */
function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function addDirValues(args: string[]): string[] {
  return args.flatMap((a, i) => (a === '--add-dir' ? [args[i + 1]] : []));
}

test('buildArgs table: claude', () => {
  const modes = { readonly: 'plan', edit: 'acceptEdits', danger: 'bypassPermissions' } as const;
  for (const c of combos()) {
    const args = build(claudeHarness, c);
    const l = label(claudeHarness, c);
    assert.deepEqual(args.slice(0, 2), ['-p', PROMPT], l);
    assert.equal(flagValue(args, '--output-format'), 'stream-json', l);
    assert.ok(args.includes('--verbose'), `${l}: stream-json requires --verbose`);
    assert.equal(flagValue(args, '--permission-mode'), modes[c.permission], l);
    if (c.resume) {
      assert.equal(flagValue(args, '--resume'), SESSION, l);
      assert.ok(!args.includes('--no-session-persistence'), l);
    } else {
      assert.ok(args.includes('--no-session-persistence'), l);
      assert.ok(!args.includes('--resume'), l);
    }
    assert.equal(flagValue(args, '--model'), c.model ? MODEL : undefined, l);
    assert.deepEqual(addDirValues(args), c.addDirs ? DIRS : [], l);
  }
});

test('buildArgs table: codex (never --ask-for-approval/--thread-id; no --add-dir/--sandbox on resume)', () => {
  const sandbox = { readonly: 'read-only', edit: 'workspace-write', danger: 'danger-full-access' } as const;
  for (const c of combos()) {
    const args = build(codexHarness, c);
    const l = label(codexHarness, c);
    assert.ok(!args.includes('--ask-for-approval'), `${l}: rejected by codex exec`);
    assert.ok(!args.includes('--thread-id'), `${l}: rejected by codex exec`);
    assert.ok(args.includes('--json'), l);
    assert.equal(flagValue(args, '--model'), c.model ? MODEL : undefined, l);
    if (c.resume) {
      assert.deepEqual(args.slice(0, 2), ['exec', 'resume'], l);
      // positionals after `--`, every flag before it
      assert.deepEqual(args.slice(-3), ['--', SESSION, PROMPT], l);
      assert.ok(!args.includes('--add-dir'), `${l}: codex exec resume rejects --add-dir`);
      assert.ok(!args.includes('--sandbox'), `${l}: codex exec resume has no --sandbox`);
    } else {
      assert.equal(args[0], 'exec', l);
      assert.notEqual(args[1], 'resume', l);
      assert.ok(args.includes(PROMPT), l);
      assert.equal(flagValue(args, '--sandbox'), sandbox[c.permission], l);
      assert.deepEqual(addDirValues(args), c.addDirs ? DIRS : [], l);
    }
  }
});

test('buildArgs table: opencode stdout (agents, never --permission/--add-dir)', () => {
  const agent = { readonly: 'plan', edit: 'build', danger: 'build' } as const;
  for (const c of combos()) {
    const args = build(opencodeHarness, c);
    const l = label(opencodeHarness, c);
    assert.deepEqual(args.slice(0, 2), ['run', PROMPT], l);
    assert.equal(flagValue(args, '--format'), 'json', l);
    assert.equal(flagValue(args, '--agent'), agent[c.permission], l);
    assert.equal(args.includes('--auto'), c.permission === 'danger', `${l}: --auto only on danger`);
    assert.ok(!args.includes('--permission'), `${l}: rejected by opencode run`);
    assert.ok(!args.includes('--add-dir'), `${l}: rejected by opencode run (addDirs silently unsupported)`);
    assert.equal(flagValue(args, '--model'), c.model ? MODEL : undefined, l);
    assert.equal(flagValue(args, '--session'), c.resume ? SESSION : undefined, l);
  }
});

test('buildArgs table: opencode ACP launches bare `opencode acp` (no --model flag exists there)', () => {
  assert.ok(opencodeHarness.buildAcpArgs);
  for (const c of combos()) {
    const args = opencodeHarness.buildAcpArgs({
      prompt: PROMPT,
      cwd: '/repo',
      permission: c.permission,
      ...(c.model ? { model: MODEL } : {}),
      ...(c.resume ? { resumeSessionId: SESSION } : {}),
      ...(c.addDirs ? { addDirs: DIRS } : {}),
    });
    assert.deepEqual(args, ['acp'], label(opencodeHarness, c));
  }
});

test('buildArgs table: amp/omp', () => {
  const approval = { readonly: 'always-ask', edit: 'write', danger: 'yolo' } as const;
  for (const c of combos()) {
    const args = build(ampHarness, c);
    const l = label(ampHarness, c);
    assert.equal(args[0], '-p', l);
    assert.equal(flagValue(args, '--mode'), 'json', l);
    assert.equal(flagValue(args, '--approval-mode'), approval[c.permission], l);
    assert.equal(args[args.length - 1], PROMPT, `${l}: prompt is the trailing positional`);
    assert.equal(flagValue(args, '--model'), c.model ? MODEL : undefined, l);
    assert.equal(flagValue(args, '--resume'), c.resume ? SESSION : undefined, l);
    assert.deepEqual(addDirValues(args), c.addDirs ? DIRS : [], l);
    // the real Sourcegraph-amp-shaped flags this harness does NOT speak
    assert.ok(!args.includes('--permission'), l);
    assert.ok(!args.includes('--output'), l);
  }
});

test('buildArgs table: devin only launches `devin acp` (+ --model); everything else is negotiated over ACP', () => {
  for (const c of combos()) {
    const args = build(devinHarness, c);
    assert.deepEqual(args, c.model ? ['acp', '--model', MODEL] : ['acp'], label(devinHarness, c));
  }
});

test('buildArgs: a native permission overrides the mapped tier, and opencode adds no --auto for it', () => {
  const native = (h: Harness, nativePermission: string) =>
    h.buildArgs({ prompt: PROMPT, cwd: '/repo', permission: 'edit', nativePermission });
  assert.equal(flagValue(native(claudeHarness, 'default'), '--permission-mode'), 'default');
  assert.equal(flagValue(native(codexHarness, 'read-only'), '--sandbox'), 'read-only');
  assert.equal(flagValue(native(ampHarness, 'yolo'), '--approval-mode'), 'yolo');
  const oc = opencodeHarness.buildArgs({
    prompt: PROMPT,
    cwd: '/repo',
    permission: 'danger',
    nativePermission: 'plan',
  });
  assert.equal(flagValue(oc, '--agent'), 'plan');
  assert.ok(!oc.includes('--auto'));
});

test('buildArgs: claude passes its native --max-budget-usd only when a budget is set', () => {
  const base = { prompt: PROMPT, cwd: '/repo', permission: 'edit' as const };
  assert.equal(flagValue(claudeHarness.buildArgs({ ...base, maxBudgetUsd: 1.5 }), '--max-budget-usd'), '1.5');
  assert.ok(!claudeHarness.buildArgs(base).includes('--max-budget-usd'));
  for (const h of [codexHarness, opencodeHarness, ampHarness, devinHarness]) {
    assert.ok(!h.buildArgs({ ...base, maxBudgetUsd: 1.5 }).includes('--max-budget-usd'), h.name);
  }
});
