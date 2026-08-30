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
 */
const LEGACY_DANGER_TOKENS = new Set(['bypassPermissions', 'danger-full-access', 'danger']);

/**
 * Does this native permission string mean "unrestricted" for this harness?
 *
 * A template can declare any native mode via the escape hatch (`permission: <native>`), and
 * `normalizePermission` files anything unrecognised under `nativePermission` with a normalized
 * tier of `edit`. Without this check, a template declaring `yolo` (amp) or `bypass` (devin) would
 * skip the `allowDangerous` gate entirely and run the harness unsandboxed while `delegate()`
 * recorded the run as `edit` — breaking the invariant that danger is only ever reachable through
 * an explicit per-call `allowDangerous: true`.
 *
 * Matches the harness's own `permissionMap.danger`, joined, so a multi-token danger mode is
 * compared as a whole: opencode's danger is `['build', '--auto']`, and bare `build` is its *edit*
 * token — treating each token separately would wrongly gate legitimate `edit` templates.
 */
export function isNativeDangerPermission(harness: Harness | undefined, nativePermission: string | undefined): boolean {
  if (!nativePermission) return false;
  const native = nativePermission.trim();
  if (LEGACY_DANGER_TOKENS.has(native)) return true;
  const danger = harness?.permissionMap?.danger;
  return Array.isArray(danger) && danger.length > 0 && native === danger.join(' ');
}
