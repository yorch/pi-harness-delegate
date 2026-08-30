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
