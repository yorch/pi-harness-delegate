import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NormalizedPermission } from './harnesses/types.ts';

export type PermissionMode = 'plan' | 'acceptEdits' | 'bypassPermissions' | 'dontAsk' | 'auto' | 'manual';

const PERMISSION_MODES = new Set<PermissionMode>([
  'plan',
  'acceptEdits',
  'bypassPermissions',
  'dontAsk',
  'auto',
  'manual',
]);

export interface DelegateTemplate {
  name: string;
  description: string;
  permission: NormalizedPermission;
  /** Native harness permission string if user used escape hatch. */
  nativePermission?: string;
  /** Legacy raw permissionMode for transcript compat. */
  permissionMode: PermissionMode;
  model?: string;
  maxBudgetUsd?: number;
  skill?: string;
  defaultTask?: string;
  defaultScope?: string;
  /** Host-run shell command executed after the harness exits to check its claims (e.g. `bun test`). */
  verify?: string;
  prompt: string;
  harness?: string;
}

export function normalizePermission(
  raw: string | undefined,
  fallbackMode: string | undefined,
): { permission: NormalizedPermission; nativePermission?: string; permissionMode: PermissionMode } {
  // Prefer normalized permission
  if (raw) {
    const lower = raw.trim().toLowerCase();
    if (lower === 'readonly' || lower === 'read-only' || lower === 'read_only')
      return { permission: 'readonly', permissionMode: 'plan' };
    if (lower === 'edit' || lower === 'acceptedits' || lower === 'accept-edits')
      return { permission: 'edit', permissionMode: 'acceptEdits' };
    if (
      lower === 'danger' ||
      lower === 'bypasspermissions' ||
      lower === 'danger-full-access' ||
      lower === 'danger_full_access'
    )
      return { permission: 'danger', permissionMode: 'bypassPermissions' };
    // Unknown native — treat as native escape hatch
    return { permission: 'edit', nativePermission: raw.trim(), permissionMode: 'acceptEdits' };
  }
  // Legacy permissionMode mapping
  if (fallbackMode && PERMISSION_MODES.has(fallbackMode as PermissionMode)) {
    const m = fallbackMode as PermissionMode;
    if (m === 'plan') return { permission: 'readonly', permissionMode: m };
    if (m === 'bypassPermissions') return { permission: 'danger', permissionMode: m };
    return { permission: 'edit', permissionMode: m };
  }
  return { permission: 'edit', permissionMode: 'acceptEdits' };
}

/** Parse a template file: frontmatter (---\nkey: value\n---) + markdown body. */
export function parseTemplate(text: string): DelegateTemplate | null {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text.trimStart());
  if (!m) return null;

  const meta: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }

  const name = meta.name?.trim();
  if (!name) return null;

  const permRaw = meta.permission?.trim();
  const permModeRaw = meta.permissionMode?.trim() ?? meta.sandbox?.trim();
  const norm = normalizePermission(permRaw, permModeRaw);

  const budget = meta.maxBudgetUsd ? Number(meta.maxBudgetUsd) : NaN;

  return {
    name,
    description: meta.description ?? '',
    permission: norm.permission,
    nativePermission: norm.nativePermission,
    permissionMode: norm.permissionMode,
    model: meta.model || undefined,
    maxBudgetUsd: Number.isFinite(budget) && budget > 0 ? budget : undefined,
    skill: meta.skill || undefined,
    defaultTask: meta.defaultTask || undefined,
    defaultScope: meta.defaultScope || undefined,
    verify: meta.verify || undefined,
    prompt: m[2].trim(),
    harness: meta.harness || undefined,
  };
}

function loadDir(dir: string, out: Map<string, DelegateTemplate>): void {
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.md')) continue;
    try {
      const t = parseTemplate(readFileSync(join(dir, f), 'utf8'));
      if (t) out.set(t.name, t);
    } catch {
      // skip unreadable files
    }
  }
}

export function builtinTemplatesDir(): string {
  return fileURLToPath(new URL('../templates/', import.meta.url));
}

export function builtinHarnessTemplatesDir(harness: string): string {
  return fileURLToPath(new URL(`../templates/${harness}/`, import.meta.url));
}

export function sharedTemplatesDir(): string {
  return fileURLToPath(new URL('../templates/shared/', import.meta.url));
}

export function userTemplatesDir(harness?: string): string {
  const dir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent');
  if (harness) return join(dir, 'delegate', 'templates', harness);
  return join(dir, 'delegate', 'templates');
}

export function projectTemplatesDir(cwd: string, harness?: string): string {
  if (harness) return join(cwd, '.pi', 'delegate', 'templates', harness);
  return join(cwd, '.pi', 'delegate', 'templates');
}

/** Legacy dirs for compat */
function legacyUserTemplatesDir(): string {
  const dir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent');
  return join(dir, 'claude-delegate', 'templates');
}
function legacyProjectTemplatesDir(cwd: string): string {
  return join(cwd, '.pi', 'claude-delegate', 'templates');
}

/**
 * Legacy root < shared < harness builtins < legacyUser < user < user/harness < legacyProject <
 * project < project/harness (later wins).
 *
 * `trusted` gates the project-local tiers only (global/user tiers always load — they're the
 * operator's own files, not the project's). It must come from pi's own trust store
 * (`ctx.isProjectTrusted()`), never from anything inside `cwd` itself: a trust anchor that lives
 * in the content it's supposed to gate can simply declare itself trusted. Callers that fail to
 * resolve trust should pass `false` — untrusted is the safe default.
 */
export function loadTemplates(cwd: string, harnessName?: string, trusted = false): Map<string, DelegateTemplate> {
  const out = new Map<string, DelegateTemplate>();
  const harness = harnessName ?? 'claude';
  // legacy root builtins (templates/*.md) lowest — for migration from pi-claude-delegate
  loadDir(builtinTemplatesDir(), out);
  // shared canonical bodies
  loadDir(sharedTemplatesDir(), out);
  // harness-specific builtins override shared
  loadDir(builtinHarnessTemplatesDir(harness), out);
  // user globals: legacy before new so new wins
  loadDir(legacyUserTemplatesDir(), out);
  loadDir(userTemplatesDir(), out);
  loadDir(userTemplatesDir(harness), out);
  // project locals: legacy before new so new wins — only if trusted
  if (trusted) {
    loadDir(legacyProjectTemplatesDir(cwd), out);
    loadDir(projectTemplatesDir(cwd), out);
    loadDir(projectTemplatesDir(cwd, harness), out);
  }
  return out;
}

export function loadAllTemplates(cwd: string, trusted = false): Map<string, DelegateTemplate> {
  return loadTemplates(cwd, undefined, trusted);
}

/**
 * Which native permission string (if any) to hand the harness for this run.
 *
 * A template's native escape hatch (`permissionMode`/`sandbox`) applies only while the effective
 * permission is still the template's own. Every harness's `buildArgs` prefers `nativePermission`
 * over the normalized map, so passing it unconditionally would let a template's native mode
 * silently override an explicit `allowDangerous` escalation — a per-call escalation would be
 * quietly downgraded back to whatever the template declared.
 */
export function resolveNativePermission(
  templatePermission: NormalizedPermission,
  effectivePermission: NormalizedPermission,
  nativePermission: string | undefined,
): string | undefined {
  if (!nativePermission) return undefined;
  return effectivePermission === templatePermission ? nativePermission : undefined;
}

/**
 * What a project has on disk that only loads when the project is trusted.
 *
 * Used to warn a user whose project-local templates stopped loading after the 0.6.0 security fix
 * (§19 of ROADMAP) — before it, a committed `.pi/trusted` file or `PI_TRUSTED=1` granted trust, and
 * both were removed. The failure is otherwise invisible: an override shares its name with the
 * builtin it replaces, so the run silently uses the builtin and produces plausible output.
 *
 * Pure filesystem inspection — no trust logic. The caller supplies the trust decision.
 */
export function projectTemplatePresence(cwd: string): {
  /** Template dirs that exist and would load if the project were trusted. */
  dirs: string[];
  /** A leftover `.pi/trusted` file — strong evidence the user relied on the removed mechanism. */
  staleTrustFile: boolean;
} {
  const candidates = [projectTemplatesDir(cwd), legacyProjectTemplatesDir(cwd)];
  const dirs: string[] = [];
  for (const dir of candidates) {
    try {
      if (readdirSync(dir).some(f => f.endsWith('.md'))) dirs.push(dir);
    } catch {
      // absent or unreadable — nothing to warn about
    }
  }
  let staleTrustFile = false;
  try {
    staleTrustFile = existsSync(join(cwd, '.pi', 'trusted'));
  } catch {
    staleTrustFile = false;
  }
  return { dirs, staleTrustFile };
}

/** One-line notices for a project whose trusted-only content was skipped. Empty when nothing applies. */
export function describeSkippedProjectTemplates(presence: { dirs: string[]; staleTrustFile: boolean }): string[] {
  if (presence.dirs.length === 0 && !presence.staleTrustFile) return [];
  const out: string[] = [];
  if (presence.dirs.length > 0) {
    out.push(
      `⚠ project-local templates were NOT loaded — this project is untrusted (${presence.dirs.join(', ')})`,
      "  trust it via pi's trust prompt or defaultProjectTrust; /delegate status shows trust state",
    );
  }
  if (presence.staleTrustFile) {
    out.push(
      '  a leftover .pi/trusted file was found — it no longer grants trust (removed in 0.6.0 as a',
      '  security fix, since a repo could use it to trust itself) and can be deleted',
    );
  }
  return out;
}
