import { ampHarness } from './amp.ts';
import { claudeHarness } from './claude.ts';
import { codexHarness } from './codex.ts';
import { devinHarness } from './devin.ts';
import { opencodeHarness } from './opencode.ts';
import type { Harness } from './types.ts';

export const HARNESSES: Record<string, Harness> = {
  claude: claudeHarness,
  codex: codexHarness,
  opencode: opencodeHarness,
  amp: ampHarness,
  devin: devinHarness,
};

export const ALIASES: Record<string, string> = {
  omp: 'amp',
};

export const HARNESS_NAMES = Object.keys(HARNESSES);

export function resolveHarnessName(name: string): string {
  const lower = name.toLowerCase();
  if (HARNESSES[lower]) return lower;
  if (ALIASES[lower] && HARNESSES[ALIASES[lower]]) return ALIASES[lower];
  return lower;
}

export function getHarness(name: string): Harness | undefined {
  const resolved = resolveHarnessName(name);
  return HARNESSES[resolved];
}

export function getAllHarnesses(): Harness[] {
  return Object.values(HARNESSES);
}

export async function detectAll(): Promise<Record<string, { ok: boolean; version?: string; hint?: string }>> {
  const out: Record<string, { ok: boolean; version?: string; hint?: string }> = {};
  await Promise.all(
    Object.entries(HARNESSES).map(async ([name, h]) => {
      out[name] = await h.detect();
    }),
  );
  return out;
}

export function isKnownHarness(name: string): boolean {
  const r = resolveHarnessName(name);
  return r in HARNESSES;
}

export const normalizeHarnessName = resolveHarnessName;

/**
 * Legacy danger spellings, kept for templates written before harnesses were partitioned.
 * Lowercase: native permissions are compared case-insensitively (see `classifyNativePermission`).
 */
const LEGACY_DANGER_TOKENS = new Set(['bypasspermissions', 'danger-full-access', 'danger']);

/**
 * How a template's native permission string (`permission: <native>` escape hatch) classifies on
 * this harness:
 * - `none` — no native permission declared.
 * - `safe` — on the harness's `safeNativePermissions` allowlist (readonly/edit-equivalent).
 * - `danger` — the harness's own danger mode (`permissionMap.danger`, joined) or a legacy danger
 *   spelling: running it is exactly the harness's normalized danger tier.
 * - `unlisted` — anything else. Treated as danger (fail closed): a permissive mode nobody listed
 *   (claude `auto`, devin `smart`, a custom opencode agent, …) must not slip past the gate.
 *
 * Matching is whitespace-trimmed and case-insensitive (`Plan` is claude's `plan`), and the danger
 * checks run first, so a case variant of a danger token (`BYPASSPERMISSIONS`, `Yolo`) is still
 * `danger`. A `safe` match is only a classification — the value that reaches argv/`session/set_mode`
 * must be the allowlist's own spelling, via `canonicalSafeNativePermission` (claude's `acceptEdits`
 * is camelCase; harness CLIs are case-sensitive, and a custom opencode agent named `PLAN` must
 * never run in place of the built-in `plan` it was classified as).
 */
export type NativePermissionClass = 'none' | 'safe' | 'danger' | 'unlisted';

export function classifyNativePermission(
  harness: Harness | undefined,
  nativePermission: string | undefined,
): NativePermissionClass {
  const native = nativePermission?.trim().toLowerCase();
  if (!native) return 'none';
  if (LEGACY_DANGER_TOKENS.has(native)) return 'danger';
  const danger = harness?.permissionMap?.danger;
  if (Array.isArray(danger) && danger.length > 0 && native === danger.join(' ').toLowerCase()) return 'danger';
  if (canonicalSafeNativePermission(harness, nativePermission) !== undefined) return 'safe';
  return 'unlisted';
}

/**
 * The harness's own allowlist spelling of a native permission that matches it case-insensitively
 * (whitespace-trimmed), or `undefined` when it isn't on the allowlist. Only meaningful for a value
 * `classifyNativePermission` calls `safe` — that's the one class whose value is ever rewritten.
 */
export function canonicalSafeNativePermission(
  harness: Harness | undefined,
  nativePermission: string | undefined,
): string | undefined {
  const native = nativePermission?.trim().toLowerCase();
  if (!native) return undefined;
  return harness?.safeNativePermissions?.find(v => v.toLowerCase() === native);
}

/**
 * Does this native permission string require the danger gate on this harness?
 *
 * A template can declare any native mode via the escape hatch (`permission: <native>`), and
 * `normalizePermission` files anything unrecognised under `nativePermission` with a normalized
 * tier of `edit`. This used to be a denylist (the harness's own danger mode + legacy spellings),
 * so a permissive mode that wasn't listed ran unsandboxed while recorded as `edit`. It is now an
 * allowlist: only values in the harness's `safeNativePermissions` pass as non-danger; everything
 * else needs an explicit per-call `allowDangerous: true`, preserving the invariant that danger is
 * never reachable without one.
 *
 * Multi-token danger modes compare joined: opencode's danger is `['build', '--auto']`, and bare
 * `build` is its *edit* token (on the allowlist).
 */
export function isNativeDangerPermission(harness: Harness | undefined, nativePermission: string | undefined): boolean {
  const cls = classifyNativePermission(harness, nativePermission);
  return cls === 'danger' || cls === 'unlisted';
}

/**
 * Will running `template` on `harnessName` be a danger-tier run? The same test `delegate()` gates on
 * (normalized `danger`, or a native permission that is this harness's own danger mode — see
 * `isNativeDangerPermission`), exposed so the command paths' danger banner can't disagree with the
 * engine about what is actually dangerous.
 */
export function isTemplateDanger(
  harnessName: string,
  template: { permission: string; nativePermission?: string } | undefined,
): boolean {
  if (!template) return false;
  return (
    template.permission === 'danger' || isNativeDangerPermission(getHarness(harnessName), template.nativePermission)
  );
}
