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
  /**
   * A problem with the template's permission keys, shown in `/delegate list` and at run time: an
   * unrecognized legacy `permissionMode:`/`sandbox:` value (failed closed to `readonly`), or a
   * legacy key that disagrees with `permission:` and was ignored (tier unchanged).
   */
  permissionWarning?: string;
  model?: string;
  maxBudgetUsd?: number;
  skill?: string;
  defaultTask?: string;
  defaultScope?: string;
  /** Host-run shell command executed after the harness exits to check its claims (e.g. `bun test`). */
  verify?: string;
  /** Extra directories the harness may access (`addDirs: ../shared, /opt/lib` — comma-separated). */
  addDirs?: string[];
  prompt: string;
  harness?: string;
}

/** Tier order, least permissive first — used to pick the safer of two conflicting legacy keys. */
const TIER_RANK: Record<NormalizedPermission, number> = { readonly: 0, edit: 1, danger: 2 };

const TIER_PERMISSION_MODE: Record<NormalizedPermission, PermissionMode> = {
  readonly: 'plan',
  edit: 'acceptEdits',
  danger: 'bypassPermissions',
};

/** Claude `PermissionMode` names, matched case- and `-`/`_`-insensitively (`accept-edits` → `acceptEdits`). */
const PERMISSION_MODES_BY_LOWER = new Map<string, PermissionMode>([...PERMISSION_MODES].map(m => [m.toLowerCase(), m]));

/** Codex `--sandbox` values (the legacy `sandbox:` key) → normalized tier. Keys are lowercase, `_`→`-`. */
const LEGACY_SANDBOX_TIERS: Record<string, NormalizedPermission> = {
  'read-only': 'readonly',
  readonly: 'readonly',
  'workspace-write': 'edit',
  'danger-full-access': 'danger',
};

/**
 * A frontmatter value echoed back in a warning (`/delegate list`, run-time notes): JSON-quoted so
 * control characters / ANSI escapes are inert, and capped so a huge value can't flood the line.
 */
function quoteValue(value: string): string {
  return JSON.stringify(value).slice(0, 60);
}

interface LegacyPermission {
  permission: NormalizedPermission;
  permissionMode: PermissionMode;
  /** Set when a legacy value was unrecognized and the template was failed closed to `readonly`. */
  permissionWarning?: string;
}

/**
 * Map one legacy `permissionMode:`/`sandbox:` value onto a normalized tier. Both keys accept both
 * vocabularies (claude PermissionMode names and codex sandbox values), case/whitespace/`-`/`_`-insensitive.
 * Returns `null` for an unrecognized value — the caller fails that closed.
 */
function classifyLegacyValue(value: string): Omit<LegacyPermission, 'permissionWarning'> | null {
  const lower = value.trim().toLowerCase();
  // Claude names have no separators of their own, so `accept-edits`/`bypass_permissions` can only
  // ever mean that same name (and tier) — danger stays gated behind allowDangerous downstream.
  const mode = PERMISSION_MODES_BY_LOWER.get(lower.replace(/[-_]/g, ''));
  if (mode) {
    if (mode === 'plan') return { permission: 'readonly', permissionMode: mode };
    if (mode === 'bypassPermissions') return { permission: 'danger', permissionMode: mode };
    return { permission: 'edit', permissionMode: mode };
  }
  const tier = LEGACY_SANDBOX_TIERS[lower.replace(/_/g, '-')];
  return tier ? { permission: tier, permissionMode: TIER_PERMISSION_MODE[tier] } : null;
}

/** The legacy keys actually set (non-empty), as `[key, value]` pairs. */
function legacyEntries(permissionMode: string | undefined, sandbox: string | undefined): [string, string][] {
  return [
    ['permissionMode', permissionMode?.trim()],
    ['sandbox', sandbox?.trim()],
  ].filter((e): e is [string, string] => Boolean(e[1]));
}

/**
 * Legacy `permissionMode:`/`sandbox:` keys → normalized tier. Only consulted when `permission:` is
 * absent. An empty/absent value means "not set" (default `edit`, as always).
 *
 * **Fails closed:** an unrecognized value (a typo, a value from some other harness's vocabulary)
 * yields `readonly` plus `permissionWarning` — never the old silent `edit`, and never a refusal
 * to load. Not loading would let a same-named lower tier (e.g. the builtin `implement`, `edit`)
 * silently win instead, which can be MORE permissive than an author who wrote `sandbox: readonyl`
 * meant; `readonly` is the one tier that can never exceed what any author meant (and it also skips
 * `verify:`). When both keys are set, the less permissive of the two wins.
 */
export function normalizeLegacyPermission(
  permissionMode: string | undefined,
  sandbox: string | undefined,
): LegacyPermission {
  const set = legacyEntries(permissionMode, sandbox);
  if (set.length === 0) return { permission: 'edit', permissionMode: 'acceptEdits' };
  let best: Omit<LegacyPermission, 'permissionWarning'> | null = null;
  for (const [key, value] of set) {
    const c = classifyLegacyValue(value);
    if (!c) {
      return {
        permission: 'readonly',
        permissionMode: 'plan',
        permissionWarning: `unrecognized ${key}: ${quoteValue(value)} — loaded as readonly (fail closed)`,
      };
    }
    if (!best || TIER_RANK[c.permission] < TIER_RANK[best.permission]) best = c;
  }
  return best as LegacyPermission;
}

export function normalizePermission(
  raw: string | undefined,
  fallbackMode: string | undefined,
  sandbox?: string,
): {
  permission: NormalizedPermission;
  nativePermission?: string;
  permissionMode: PermissionMode;
  permissionWarning?: string;
} {
  // Prefer normalized permission
  if (raw) {
    const resolved = normalizeTierValue(raw);
    // `permission:` always wins; a legacy key that disagrees is ignored, but said so — an author who
    // wrote `sandbox: read-only` next to `permission: edit` should see which one ran. Skipped for a
    // native value: its tier is only known per harness at run time, so "disagrees" isn't decidable here.
    const legacy = legacyEntries(fallbackMode, sandbox);
    if (resolved.nativePermission || legacy.length === 0) return resolved;
    const l = normalizeLegacyPermission(fallbackMode, sandbox);
    if (!l.permissionWarning && l.permission === resolved.permission) return resolved;
    const ignored = legacy.map(([k, v]) => `${k}: ${quoteValue(v)}`).join(', ');
    return { ...resolved, permissionWarning: `permission: ${resolved.permission} overrides ${ignored} (ignored)` };
  }
  // Legacy permissionMode/sandbox mapping — fails closed to readonly on an unrecognized value
  return normalizeLegacyPermission(fallbackMode, sandbox);
}

/** One `permission:` value → tier, or (unknown value) the native escape hatch. */
function normalizeTierValue(raw: string): {
  permission: NormalizedPermission;
  nativePermission?: string;
  permissionMode: PermissionMode;
} {
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

/** Comma-separated frontmatter list (`a, b`) — undefined when absent or empty. */
function parseList(raw: string | undefined): string[] | undefined {
  const items = (raw ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
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
  const norm = normalizePermission(permRaw, meta.permissionMode, meta.sandbox);

  const budget = meta.maxBudgetUsd ? Number(meta.maxBudgetUsd) : NaN;
  const description = meta.description ?? '';

  return {
    name,
    // A permission-key problem is surfaced where the template is listed (`/delegate list`).
    description: norm.permissionWarning
      ? `⚠ ${norm.permissionWarning}${description ? ` · ${description}` : ''}`
      : description,
    permission: norm.permission,
    nativePermission: norm.nativePermission,
    permissionMode: norm.permissionMode,
    permissionWarning: norm.permissionWarning,
    model: meta.model || undefined,
    maxBudgetUsd: Number.isFinite(budget) && budget > 0 ? budget : undefined,
    skill: meta.skill || undefined,
    defaultTask: meta.defaultTask || undefined,
    defaultScope: meta.defaultScope || undefined,
    verify: meta.verify || undefined,
    addDirs: parseList(meta.addDirs),
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
export function projectTemplatePresence(
  cwd: string,
  /** Canonical harness names — the only partitions `loadTemplates` ever reads (callers pass the
   *  registry's `HARNESS_NAMES`; injected so this module stays free of the harness registry). */
  harnessNames: readonly string[],
): {
  /** Template dirs that exist and would load if the project were trusted. */
  dirs: string[];
  /** A leftover `.pi/trusted` file — strong evidence the user relied on the removed mechanism. */
  staleTrustFile: boolean;
} {
  // the per-harness partitions (`.pi/delegate/templates/<harness>/`) load too — see loadTemplates —
  // so they count as skipped content just like the shared root does. Only real harness partitions:
  // loadTemplates is always called with a canonical name, so `omp/` (an alias), `archive/`,
  // `shared/` etc. are never read and must not trigger the warning either.
  const known = new Set(harnessNames);
  let partitions: string[] = [];
  try {
    partitions = readdirSync(projectTemplatesDir(cwd), { withFileTypes: true })
      .filter(e => e.isDirectory() && known.has(e.name))
      .map(e => projectTemplatesDir(cwd, e.name))
      .sort();
  } catch {
    // absent or unreadable
  }
  const candidates = [projectTemplatesDir(cwd), ...partitions, legacyProjectTemplatesDir(cwd)];
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
