import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAmpLine, resolveAmpBinary } from '../extensions/harnesses/amp.ts';
import { parseClaudeLine } from '../extensions/harnesses/claude.ts';
import { parseCodexLine } from '../extensions/harnesses/codex.ts';
import { parseOpencodeLine } from '../extensions/harnesses/opencode.ts';
import {
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
  assert.equal(isNativeDangerPermission(getHarness('devin'), 'smart'), false);
  assert.equal(isNativeDangerPermission(getHarness('claude'), 'plan'), false);
  assert.equal(isNativeDangerPermission(getHarness('amp'), undefined), false);
  // Legacy spellings stay gated regardless of which harness is selected.
  assert.equal(isNativeDangerPermission(getHarness('opencode'), 'bypassPermissions'), true);
});
