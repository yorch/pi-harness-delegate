import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAmpLine, resolveAmpBinary } from '../extensions/harnesses/amp.ts';
import { parseClaudeLine } from '../extensions/harnesses/claude.ts';
import { parseCodexLine } from '../extensions/harnesses/codex.ts';
import { parseOpencodeLine } from '../extensions/harnesses/opencode.ts';
import {
  canonicalSafeNativePermission,
  classifyNativePermission,
  getHarness,
  HARNESS_NAMES,
  isNativeDangerPermission,
  resolveHarnessName,
} from '../extensions/harnesses/registry.ts';

test('claude harness parses stream deltas and result', () => {
  const state = { streamedText: '', activities: [], result: null };
  const out1 = parseClaudeLine(
    JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } },
    }),
    state,
  );
  assert.equal(out1.streamedText, 'hi');
  const out2 = parseClaudeLine(
    JSON.stringify({
      type: 'result',
      result: 'done',
      total_cost_usd: 0.1,
      session_id: 'abc',
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    { streamedText: 'hi', activities: [], result: null },
  );
  assert.ok(out2.result);
  assert.equal(out2.result?.sessionId, 'abc');
});

test('codex harness parses plain text fallback', () => {
  const state = { streamedText: '', activities: [], result: null };
  const out = parseCodexLine('hello from codex', state);
  assert.ok(out.streamedText?.includes('hello'));
});

test('codex harness parses json result', () => {
  const state = { streamedText: 'partial', activities: [], result: null };
  const out = parseCodexLine(
    JSON.stringify({
      type: 'result',
      result: 'final',
      session_id: 'sess-1',
      usage: { input_tokens: 5, output_tokens: 5 },
    }),
    state,
  );
  assert.ok(out.result);
  assert.equal(out.result?.sessionId, 'sess-1');
});

test('opencode harness parses text', () => {
  const state = { streamedText: '', activities: [], result: null };
  const out = parseOpencodeLine(JSON.stringify({ type: 'text', text: 'opencode hi' }), state);
  assert.equal(out.streamedText, 'opencode hi');
});

test('amp harness parses text', () => {
  const state = { streamedText: '', activities: [], result: null };
  const out = parseAmpLine(JSON.stringify({ type: 'text', text: 'amp hi' }), state);
  assert.equal(out.streamedText, 'amp hi');
});

test('resolveAmpBinary prefers amp, falls back to omp, then defaults to amp', () => {
  const exists = (available: string[]) => (p: string) => available.some(name => p.endsWith(`/${name}`));
  assert.equal(resolveAmpBinary('/bin:/usr/bin', exists(['amp', 'omp'])), 'amp');
  // the exact situation this fixes: only the omp alias binary is on PATH
  assert.equal(resolveAmpBinary('/bin:/usr/bin', exists(['omp'])), 'omp');
  assert.equal(resolveAmpBinary('/bin:/usr/bin', exists([])), 'amp');
  assert.equal(resolveAmpBinary(undefined, exists([])), 'amp');
});

test('registry returns harnesses and normalizes aliases', () => {
  assert.ok(HARNESS_NAMES.includes('claude'));
  assert.ok(HARNESS_NAMES.includes('codex'));
  assert.ok(HARNESS_NAMES.includes('devin'));
  assert.equal(resolveHarnessName('OMP'), 'amp');
  assert.equal(resolveHarnessName('claude'), 'claude');
  assert.ok(getHarness('claude'));
  assert.ok(getHarness('amp'));
  assert.ok(getHarness('omp'));
  assert.ok(getHarness('devin'));
  assert.equal(getHarness('unknown'), undefined);
});

test('devin harness declares acp transport, spawns `devin acp` regardless of permission, and maps modes', () => {
  const devin = getHarness('devin');
  assert.ok(devin);
  assert.equal(devin.transport, 'acp');
  // buildArgs only launches the ACP server — the prompt/permission/session lifecycle are all
  // negotiated over the wire by acp-runner.ts, not passed as CLI flags.
  for (const permission of ['readonly', 'edit', 'danger'] as const) {
    assert.deepEqual(devin.buildArgs({ prompt: 'hi', cwd: '/tmp', permission }), ['acp']);
  }
  assert.deepEqual(devin.permissionMap, { readonly: ['plan'], edit: ['accept-edits'], danger: ['bypass'] });
});

test('supportsTransports: the ceiling per harness, per docs/acp-harness-assessment.md §5', () => {
  // No ACP surface exists for either — confirmed against full --help output.
  assert.deepEqual(getHarness('claude')?.supportsTransports, ['stdout']);
  assert.deepEqual(getHarness('codex')?.supportsTransports, ['stdout']);
  // Real ACP, permission-tier-clean (readonly->plan live-verified, edit/danger no worse than
  // stdout's own collapse) — legal to configure, not defaulted.
  assert.deepEqual(getHarness('opencode')?.supportsTransports, ['stdout', 'acp']);
  // Real ACP too, but its mode surface is only 2 tiers against stdout's 3 genuine ones — not a
  // legal config value until that changes.
  assert.deepEqual(getHarness('amp')?.supportsTransports, ['stdout']);
  // ACP-only — no stdout mode exists to select between.
  assert.deepEqual(getHarness('devin')?.supportsTransports, ['acp']);
});

test('opencode harness: buildAcpArgs/acpPermissionMap are a distinct vocabulary from the stdout ones', () => {
  const opencode = getHarness('opencode');
  assert.ok(opencode);
  assert.deepEqual(opencode.buildAcpArgs?.({ prompt: 'hi', cwd: '/tmp', permission: 'readonly' }), ['acp']);
  assert.deepEqual(opencode.acpPermissionMap, { readonly: ['plan'], edit: ['build'], danger: ['build'] });
  // Values happen to coincide with the stdout map today, but the fields themselves are distinct —
  // opencode.danger's stdout token carries an extra `--auto` CLI flag the ACP modeId never would.
  assert.notDeepEqual(opencode.acpPermissionMap, opencode.permissionMap);
});

test('harness buildArgs respect permission', () => {
  const claude = getHarness('claude');
  assert.ok(claude);
  const argsRo = claude.buildArgs({ prompt: 'hi', cwd: '/tmp', permission: 'readonly' });
  assert.ok(argsRo.includes('plan'));
  const argsEdit = claude.buildArgs({ prompt: 'hi', cwd: '/tmp', permission: 'edit' });
  assert.ok(argsEdit.includes('acceptEdits'));
  const argsDanger = claude.buildArgs({ prompt: 'hi', cwd: '/tmp', permission: 'danger' });
  assert.ok(argsDanger.includes('bypassPermissions'));

  const codex = getHarness('codex');
  assert.ok(codex);
  const cArgsRo = codex.buildArgs({ prompt: 'hi', cwd: '/tmp', permission: 'readonly' });
  assert.ok(cArgsRo.includes('read-only'));
});

test('codex buildArgs: --add-dir only on a fresh turn, never on resume', () => {
  // `codex exec resume --help` has no --add-dir at all (confirmed live: a hard CLI error,
  // "unexpected argument '--add-dir' found") — only `codex exec` (no resume) supports it.
  const codex = getHarness('codex');
  assert.ok(codex);
  const fresh = codex.buildArgs({ prompt: 'hi', cwd: '/tmp', permission: 'readonly', addDirs: ['/extra'] });
  assert.ok(fresh.includes('--add-dir'));
  const resumed = codex.buildArgs({
    prompt: 'hi',
    cwd: '/tmp',
    permission: 'readonly',
    resumeSessionId: 'abc',
    addDirs: ['/extra'],
  });
  assert.ok(!resumed.includes('--add-dir'), `resume args should never include --add-dir, got: ${resumed}`);
});

test('amp buildArgs: --add-dir is included — confirmed live that omp accepts it', () => {
  const amp = getHarness('amp');
  assert.ok(amp);
  const args = amp.buildArgs({ prompt: 'hi', cwd: '/tmp', permission: 'readonly', addDirs: ['/extra'] });
  assert.ok(args.includes('--add-dir') && args.includes('/extra'));
});

test('isNativeDangerPermission: every harness danger mode is gated', () => {
  // The bug this closes: `yolo` (amp) and `bypass` (devin) are not legacy spellings, so the old
  // hardcoded trio let them through as an `unknown native` while the run was recorded as `edit`.
  assert.equal(isNativeDangerPermission(getHarness('amp'), 'yolo'), true);
  assert.equal(isNativeDangerPermission(getHarness('devin'), 'bypass'), true);
  assert.equal(isNativeDangerPermission(getHarness('claude'), 'bypassPermissions'), true);
  assert.equal(isNativeDangerPermission(getHarness('codex'), 'danger-full-access'), true);
  // Multi-token danger is compared joined, not per token.
  assert.equal(isNativeDangerPermission(getHarness('opencode'), 'build --auto'), true);
});

test('isNativeDangerPermission: non-danger natives are not gated', () => {
  // `build` alone is opencode's EDIT token; gating it would block legitimate edit templates.
  assert.equal(isNativeDangerPermission(getHarness('opencode'), 'build'), false);
  assert.equal(isNativeDangerPermission(getHarness('devin'), 'ask'), false);
  assert.equal(isNativeDangerPermission(getHarness('claude'), 'plan'), false);
  assert.equal(isNativeDangerPermission(getHarness('amp'), undefined), false);
  // Legacy spellings stay gated regardless of which harness is selected.
  assert.equal(isNativeDangerPermission(getHarness('opencode'), 'bypassPermissions'), true);
});

test('isNativeDangerPermission: every allowlisted native value is non-danger on its own harness', () => {
  const safe: Record<string, string[]> = {
    claude: ['plan', 'acceptEdits', 'manual', 'default'],
    codex: ['read-only', 'workspace-write'],
    opencode: ['plan', 'build'],
    amp: ['always-ask', 'write'],
    devin: ['plan', 'accept-edits', 'ask'],
  };
  for (const [name, values] of Object.entries(safe)) {
    for (const v of values) assert.equal(isNativeDangerPermission(getHarness(name), v), false, `${name}:${v}`);
    // each harness's own normalized readonly/edit tokens are on its allowlist
    const map = getHarness(name)?.permissionMap;
    for (const tier of ['readonly', 'edit'] as const) {
      assert.equal(isNativeDangerPermission(getHarness(name), map?.[tier].join(' ')), false, `${name}:${tier}`);
    }
  }
});

test('isNativeDangerPermission: unlisted native values fail closed as danger', () => {
  // Permissive modes the old denylist let through as `edit`.
  assert.equal(isNativeDangerPermission(getHarness('claude'), 'auto'), true);
  assert.equal(isNativeDangerPermission(getHarness('claude'), 'dontAsk'), true);
  assert.equal(isNativeDangerPermission(getHarness('devin'), 'smart'), true);
  // Anything never heard of, a custom opencode agent, case variants, another harness's safe value.
  assert.equal(isNativeDangerPermission(getHarness('claude'), 'totally-new-mode'), true);
  assert.equal(isNativeDangerPermission(getHarness('opencode'), 'my-custom-agent'), true);
  assert.equal(isNativeDangerPermission(getHarness('codex'), 'acceptEdits'), true);
  assert.equal(isNativeDangerPermission(getHarness('codex'), 'ACCEPTEDITS'), true);
  // No harness resolved: nothing is known safe.
  assert.equal(isNativeDangerPermission(undefined, 'plan'), true);
});

test('classifyNativePermission: none / safe / danger / unlisted', () => {
  assert.equal(classifyNativePermission(getHarness('claude'), undefined), 'none');
  assert.equal(classifyNativePermission(getHarness('claude'), '  '), 'none');
  assert.equal(classifyNativePermission(getHarness('claude'), ' plan '), 'safe');
  assert.equal(classifyNativePermission(getHarness('amp'), 'yolo'), 'danger');
  assert.equal(classifyNativePermission(getHarness('codex'), 'bypassPermissions'), 'danger');
  assert.equal(classifyNativePermission(getHarness('devin'), 'smart'), 'unlisted');
});

test('classifyNativePermission: allowlist matching is case-insensitive and canonicalizes, on every harness', () => {
  const variants = (v: string) => [v, v.toUpperCase(), v[0].toUpperCase() + v.slice(1), ` ${v.toUpperCase()}\t`];
  for (const name of HARNESS_NAMES) {
    const h = getHarness(name);
    const safe = h?.safeNativePermissions ?? [];
    assert.ok(safe.length > 0, `${name} has an allowlist`);
    for (const canonical of safe) {
      for (const v of variants(canonical)) {
        assert.equal(classifyNativePermission(h, v), 'safe', `${name}:${JSON.stringify(v)}`);
        // what reaches argv/ACP is the allowlist's own spelling, never the template's
        assert.equal(canonicalSafeNativePermission(h, v), canonical, `${name}:${JSON.stringify(v)}`);
      }
    }
  }
  // claude's camelCase edit mode: any casing in, `acceptEdits` out
  assert.equal(canonicalSafeNativePermission(getHarness('claude'), 'ACCEPTEDITS'), 'acceptEdits');
  assert.equal(canonicalSafeNativePermission(getHarness('claude'), 'Plan'), 'plan');
});

test('classifyNativePermission: case variants of danger tokens stay danger, never safe', () => {
  const danger: Array<[string, string]> = [
    ['claude', 'BYPASSPERMISSIONS'],
    ['claude', 'BypassPermissions'],
    ['amp', 'Yolo'],
    ['amp', 'YOLO'],
    ['devin', 'Bypass'],
    ['codex', 'DANGER-FULL-ACCESS'],
    ['opencode', 'Build --Auto'],
    ['opencode', 'BYPASSPERMISSIONS'],
    ['codex', 'Danger'],
  ];
  for (const [name, v] of danger) {
    assert.equal(classifyNativePermission(getHarness(name), v), 'danger', `${name}:${v}`);
    assert.equal(isNativeDangerPermission(getHarness(name), v), true, `${name}:${v}`);
    assert.equal(canonicalSafeNativePermission(getHarness(name), v), undefined, `${name}:${v}`);
  }
  // Unlisted stays unlisted (and gated) in any casing; another harness's safe value is not borrowed.
  for (const [name, v] of [
    ['claude', 'Auto'],
    ['claude', 'DONTASK'],
    ['devin', 'Smart'],
    ['codex', 'AcceptEdits'],
    ['opencode', 'My-Custom-Agent'],
  ]) {
    assert.equal(classifyNativePermission(getHarness(name), v), 'unlisted', `${name}:${v}`);
    assert.equal(canonicalSafeNativePermission(getHarness(name), v), undefined, `${name}:${v}`);
  }
  assert.equal(classifyNativePermission(undefined, 'Plan'), 'unlisted');
});

test('every bundled template classifies the same: no native permission, danger only where declared', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { loadTemplates } = await import('../extensions/templates.ts');
  const { isTemplateDanger } = await import('../extensions/harnesses/registry.ts');
  // isolate from the user's own ~/.pi/agent templates and the repo's own .pi
  const agentDir = mkdtempSync(join(tmpdir(), 'bundled-tpl-'));
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    for (const name of HARNESS_NAMES) {
      const templates = loadTemplates(agentDir, name, false);
      assert.ok(templates.size > 0, name);
      for (const t of templates.values()) {
        assert.equal(classifyNativePermission(getHarness(name), t.nativePermission), 'none', `${name}/${t.name}`);
        assert.equal(isTemplateDanger(name, t), t.permission === 'danger', `${name}/${t.name}`);
      }
      for (const ro of ['review', 'plan', 'security-audit']) {
        assert.equal(templates.get(ro)?.permission, 'readonly', `${name}/${ro}`);
      }
    }
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test('codex buildArgs: resume puts every flag before `--` and the session id/prompt after it', () => {
  const codex = getHarness('codex');
  assert.ok(codex);
  const args = codex.buildArgs({
    prompt: 'go on',
    cwd: '/tmp',
    permission: 'edit',
    model: 'gpt-5',
    resumeSessionId: 'abc-123',
  });
  assert.deepEqual(args, ['exec', 'resume', '--json', '--model', 'gpt-5', '--', 'abc-123', 'go on']);
});

function freshState(): import('../extensions/harnesses/types.ts').ParseState {
  return { streamedText: '', activities: [], result: null, _harness: {} };
}

test('opencode: step_finish without a cost field reports totalCostUsd null, not $0', () => {
  const state = freshState();
  const out = parseOpencodeLine(
    JSON.stringify({ type: 'step_finish', sessionID: 's1', part: { tokens: { input: 10, output: 5 } } }),
    state,
  );
  assert.equal(out.result?.totalCostUsd, null);
  assert.equal(out.result?.usage?.inputTokens, 10, 'tokens are still measured');
  // a later step that does report cost makes the total measured
  const out2 = parseOpencodeLine(JSON.stringify({ type: 'step_finish', part: { cost: 0.25, tokens: {} } }), state);
  assert.equal(out2.result?.totalCostUsd, 0.25);
});

test('opencode: a real $0 step_finish cost stays a measured 0', () => {
  const out = parseOpencodeLine(JSON.stringify({ type: 'step_finish', part: { cost: 0, tokens: {} } }), freshState());
  assert.equal(out.result?.totalCostUsd, 0);
});

test('amp: turn_end without usage.cost reports totalCostUsd null, not $0', () => {
  const state = freshState();
  const out = parseAmpLine(
    JSON.stringify({ type: 'turn_end', message: { content: [], usage: { input: 3, output: 4 } } }),
    state,
  );
  assert.equal(out.result?.totalCostUsd, null);
  assert.equal(out.result?.numTurns, 1);
  const out2 = parseAmpLine(
    JSON.stringify({
      type: 'turn_end',
      message: { content: [], usage: { input: 1, output: 1, cost: { total: 0.5 } } },
    }),
    state,
  );
  assert.equal(out2.result?.totalCostUsd, 0.5);
});
