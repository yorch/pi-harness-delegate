import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NormalizedPermission } from './harnesses/types.ts';
import { INVISIBLE_OR_CONTROL_RE } from './sanitize.ts';

/** Where a loaded template came from: shipped with the package, the user's own dirs, or the project. */
export type TemplateSource = 'builtin' | 'user' | 'project';

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
  /**
   * Set when `permission:` is a native value and legacy `permissionMode:`/`sandbox:` keys were also
   * present (and ignored). Whether they *disagree* depends on the native value's tier, which is only
   * known per harness — so `delegate()` decides, via `nativeOverrideWarning()`. Never changes the tier.
   */
  ignoredLegacyPermission?: IgnoredLegacyPermission;
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
  /** Which tier this template was loaded from — set by `loadTemplates`, absent from `parseTemplate`. */
  source?: TemplateSource;
  /**
   * Per-run harness timeout in seconds (`timeout: 900`), an integer within
   * [`TEMPLATE_TIMEOUT_MIN_SEC`, `TEMPLATE_TIMEOUT_MAX_SEC`]. An out-of-range or non-integer value is
   * ignored (the config timeout applies) and reported in `fieldWarnings`. See `resolveRunTimeoutMs`.
   */
  timeoutSec?: number;
  /**
   * Default harness(es) for this mode (`harnesses: codex` or `harnesses: claude, codex`), used ONLY
   * when the caller names no harness. Lowercased; well-formed but unknown names are kept so the
   * existing fan-out reporting (`resolveHarnessList`) names them. Never widens permission. Several
   * names make a run with no harness a fan-out on both the `/delegate` command and the `delegate`
   * tool — see `templateHarnessDefault` (command.ts).
   */
  harnesses?: string[];
  /**
   * Non-permission frontmatter problems (an invalid `timeout:`, a rejected `harnesses:` entry):
   * the value was ignored and the default applies. Shown in `/delegate list`, `delegate_modes` and
   * at run time — never silently dropped.
   */
  fieldWarnings?: string[];
}

/** Bounds for a template's `timeout:` (seconds). A template can never raise a run past the max. */
export const TEMPLATE_TIMEOUT_MIN_SEC = 10;
export const TEMPLATE_TIMEOUT_MAX_SEC = 7200;

const HARNESS_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;

/**
 * `harnesses:` frontmatter → a deduped, lowercased list. `all` is refused (a template must name
 * its harnesses — `all` would silently fan out, and multiply spend, to whatever happens to be
 * installed) and so is anything that isn't a plain harness-shaped word; both are reported as
 * warnings and dropped. Unknown-but-well-formed names are kept for the run-time reporting.
 */
export function parseTemplateHarnesses(raw: string | undefined): { harnesses?: string[]; warnings: string[] } {
  const warnings: string[] = [];
  const out: string[] = [];
  for (const item of parseList(raw) ?? []) {
    const name = item.toLowerCase();
    if (name === 'all') {
      warnings.push('harnesses: "all" ignored — name the harnesses explicitly');
      continue;
    }
    if (!HARNESS_NAME_RE.test(name)) {
      warnings.push(`harnesses: entry ${quoteValue(item)} ignored — not a harness name`);
      continue;
    }
    if (!out.includes(name)) out.push(name);
  }
  return { harnesses: out.length > 0 ? out : undefined, warnings };
}

/** `timeout:` frontmatter → seconds, or a warning (value ignored) when it isn't a bounded integer. */
export function parseTemplateTimeout(raw: string | undefined): { timeoutSec?: number; warning?: string } {
  const v = raw?.trim();
  if (!v) return {};
  const n = /^\d{1,9}$/.test(v) ? Number(v) : NaN;
  if (Number.isInteger(n) && n >= TEMPLATE_TIMEOUT_MIN_SEC && n <= TEMPLATE_TIMEOUT_MAX_SEC) return { timeoutSec: n };
  return {
    warning: `timeout: ${quoteValue(v)} ignored — must be a whole number of seconds from ${TEMPLATE_TIMEOUT_MIN_SEC} to ${TEMPLATE_TIMEOUT_MAX_SEC}; the configured timeout applies`,
  };
}

/**
 * A per-call timeout (`delegate` tool `timeoutSec`, `/delegate --timeout=<sec>`) must be a whole
 * number of seconds within the same bounds as a template's `timeout:`. Unlike a bad frontmatter
 * value (ignored with a warning — the template author isn't there to ask), a bad per-call value is
 * an error: the caller asked for a specific limit we can't honor. `null` when valid.
 */
export function callTimeoutError(sec: unknown): string | null {
  if (
    typeof sec === 'number' &&
    Number.isInteger(sec) &&
    sec >= TEMPLATE_TIMEOUT_MIN_SEC &&
    sec <= TEMPLATE_TIMEOUT_MAX_SEC
  )
    return null;
  const shown =
    typeof sec === 'number' && Number.isFinite(sec) ? String(sec) : JSON.stringify(String(sec)).slice(0, 40);
  return `timeout must be a whole number of seconds from ${TEMPLATE_TIMEOUT_MIN_SEC} to ${TEMPLATE_TIMEOUT_MAX_SEC} (got ${shown})`;
}

/** The legacy keys ignored next to a native `permission:` value — keys already sanitized (`displayKey`). */
export interface IgnoredLegacyPermission {
  /** The `permission:` key as the author spelled it. */
  permissionKey: string;
  legacy: FrontmatterEntry[];
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

/** Each match → `\uXXXX` (per UTF-16 code unit), so it is visible and inert. */
function escapeInvisible(text: string): string {
  return text.replace(INVISIBLE_OR_CONTROL_RE, ch =>
    Array.from({ length: ch.length }, (_, i) => `\\u${ch.charCodeAt(i).toString(16).padStart(4, '0')}`).join(''),
  );
}

/**
 * A frontmatter-derived string echoed back in a warning (`/delegate list`, run-time notes): JSON-quoted
 * so C0 controls / ANSI escapes are inert, the characters `JSON.stringify` leaves raw (C1, bidi,
 * zero-width, U+2028/9, tag characters, … — the shared `INVISIBLE_OR_CONTROL_RE` set from
 * `sanitize.ts`) escaped as `\uXXXX` too, and capped at `max` chars so a huge value can't flood the
 * line. Escaped rather than stripped (unlike `sanitizeTemplateText`): a warning must show what the
 * author actually wrote.
 */
export function quoteValue(value: string, max = 60): string {
  return escapeInvisible(JSON.stringify(value)).slice(0, max);
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

/** The legacy keys actually set (non-empty), as `[key, value]` pairs — `key` as the author spelled it. */
function legacyEntries(permissionMode: FrontmatterValues, sandbox: FrontmatterValues): [string, string][] {
  return [...entries(permissionMode, 'permissionMode'), ...entries(sandbox, 'sandbox')];
}

/** One occurrence of a permission key: its value, plus the key as the author spelled it (`Sandbox`). */
export interface FrontmatterEntry {
  key: string;
  value: string;
}

/**
 * A permission key's value(s): the keys are read case-insensitively and every occurrence is kept
 * (`sandbox:` + `Sandbox:` is two values), so callers take an array; a single string still works.
 * A bare string element is attributed to the canonical key; a `FrontmatterEntry` keeps the author's.
 */
type FrontmatterValues = string | readonly (string | FrontmatterEntry)[] | undefined;

/** Non-empty trimmed `[key, value]` pairs — an empty value means "not set". */
function entries(v: FrontmatterValues, canonical: string): [string, string][] {
  return (typeof v === 'string' ? [v] : (v ?? []))
    .map((x): [string, string] =>
      typeof x === 'string' ? [canonical, x.trim()] : [displayKey(x.key, canonical), x.value.trim()],
    )
    .filter(([, value]) => value !== '');
}

/** Non-empty trimmed values — an empty value means "not set". */
function values(v: FrontmatterValues): string[] {
  return entries(v, '').map(([, value]) => value);
}

/**
 * A frontmatter key echoed back in a warning: the author's own spelling (`Sandbox`, `SANDBOX`) so
 * the warning points at the line they actually wrote — but only when it is a plain case variant of
 * the canonical key made of `[A-Za-z_]` (capped). Keys come from template files a hostile project
 * controls, so anything else (control chars, ANSI escapes, Unicode look-alikes) falls back to the
 * canonical name rather than reaching the terminal.
 */
export function displayKey(raw: string, canonical: string): string {
  const key = raw.trim();
  return /^[A-Za-z_]{1,32}$/.test(key) && key.toLowerCase() === canonical.toLowerCase() ? key : canonical;
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
 * `verify:`). When both keys (or several case variants of one) are set, the least permissive wins.
 */
export function normalizeLegacyPermission(
  permissionMode: FrontmatterValues,
  sandbox: FrontmatterValues,
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
  raw: FrontmatterValues,
  fallbackMode: FrontmatterValues,
  sandbox?: FrontmatterValues,
): {
  permission: NormalizedPermission;
  nativePermission?: string;
  permissionMode: PermissionMode;
  permissionWarning?: string;
  ignoredLegacyPermission?: IgnoredLegacyPermission;
} {
  // Prefer normalized permission
  const raws = values(raw);
  if (raws.length > 1) {
    // `permission:` given more than once (e.g. `permission:` and `Permission:`) — the same tier is
    // fine; disagreeing tiers take the least permissive, and a disagreement involving a native value
    // (whose tier is per-harness, so not comparable here) fails closed to readonly. Never "last wins".
    const all = raws.map(normalizeTierValue);
    const distinct = new Set(all.map(r => `${r.permission}|${r.nativePermission ?? ''}`));
    if (distinct.size > 1) {
      const listed = raws.map(v => quoteValue(v)).join(', ');
      const least = all.some(r => r.nativePermission)
        ? undefined
        : all.reduce((a, b) => (TIER_RANK[b.permission] < TIER_RANK[a.permission] ? b : a));
      const resolved = least
        ? {
            ...least,
            permissionWarning: `conflicting permission: values ${listed} — using the least permissive, ${least.permission}`,
          }
        : {
            permission: 'readonly' as const,
            permissionMode: 'plan' as const,
            permissionWarning: `conflicting permission: values ${listed} — loaded as readonly (fail closed)`,
          };
      // Legacy keys are ignored here too — judged against the tier this resolved to, and appended
      // rather than dropped (no native value survives this branch, so delegate() can't judge them).
      const [[permissionKey]] = entries(raw, 'permission');
      const ignored = legacyOverrideWarning(
        `${permissionKey}: ${resolved.permission}`,
        resolved.permission,
        legacyEntries(fallbackMode, sandbox),
      );
      return ignored ? { ...resolved, permissionWarning: `${resolved.permissionWarning}; ${ignored}` } : resolved;
    }
  }
  if (raws.length > 0) {
    const resolved = normalizeTierValue(raws[0]);
    // `permission:` always wins; a legacy key that disagrees is ignored, but said so — an author who
    // wrote `sandbox: read-only` next to `permission: edit` should see which one ran. For a native
    // value the tier is only known per harness, so the ignored keys are carried for delegate() to judge.
    const legacy = legacyEntries(fallbackMode, sandbox);
    if (legacy.length === 0) return resolved;
    const [[permissionKey]] = entries(raw, 'permission');
    if (resolved.nativePermission)
      return {
        ...resolved,
        ignoredLegacyPermission: { permissionKey, legacy: legacy.map(([key, value]) => ({ key, value })) },
      };
    const warning = legacyOverrideWarning(`${permissionKey}: ${resolved.permission}`, resolved.permission, legacy);
    return warning ? { ...resolved, permissionWarning: warning } : resolved;
  }
  // Legacy permissionMode/sandbox mapping — fails closed to readonly on an unrecognized value
  return normalizeLegacyPermission(fallbackMode, sandbox);
}

/**
 * `<label> overrides <legacy keys> (ignored)` unless every ignored legacy value is recognized and maps
 * to exactly `tier` — so one that disagrees with `tier`, one that is unrecognized, or ignored keys that
 * disagree with each other (`sandbox: read-only` + `Sandbox: workspace-write`, even when the least
 * permissive of them matches `tier`) are all flagged; `undefined` when there are none or they all
 * agree. Keys are echoed as given (already `displayKey`-sanitized), values quoted via `quoteValue`.
 */
function legacyOverrideWarning(
  label: string,
  tier: NormalizedPermission,
  legacy: readonly [string, string][],
): string | undefined {
  if (legacy.every(([, v]) => classifyLegacyValue(v)?.permission === tier)) return undefined;
  const ignored = legacy.map(([k, v]) => `${k}: ${quoteValue(v)}`).join(', ');
  return `${label} overrides ${ignored} (ignored)`;
}

/**
 * The run-time counterpart of the override warning for a native `permission:` value: `delegate()`
 * passes the tier that value actually runs at on `harnessName` (readonly/edit for an allowlisted
 * value, danger for one gated as danger); `harnessName` must be the canonical, registry-resolved
 * name (it is echoed unquoted). Only a warning — the tier is never changed by it.
 */
export function nativeOverrideWarning(
  ignored: IgnoredLegacyPermission,
  nativePermission: string,
  tier: NormalizedPermission,
  harnessName: string,
): string | undefined {
  return legacyOverrideWarning(
    `${ignored.permissionKey}: ${quoteValue(nativePermission)} (${tier} on ${harnessName})`,
    tier,
    ignored.legacy.map(e => [e.key, e.value]),
  );
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

type PermissionKey = 'permission' | 'permissionMode' | 'sandbox';
const PERMISSION_KEYS = new Map<string, PermissionKey>([
  ['permission', 'permission'],
  ['permissionmode', 'permissionMode'],
  ['sandbox', 'sandbox'],
]);

/** Parse a template file: frontmatter (---\nkey: value\n---) + markdown body. */
export function parseTemplate(text: string): DelegateTemplate | null {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text.trimStart());
  if (!m) return null;

  const meta: Record<string, string> = {};
  // The keys that decide the tier are matched case-insensitively and keep every occurrence: an
  // exact-case lookup let `Sandbox: read-only` be silently ignored (→ the `edit` default, verify on).
  // Each occurrence keeps the author's key spelling, so a warning names the line they wrote.
  const perm: Record<PermissionKey, FrontmatterEntry[]> = { permission: [], permissionMode: [], sandbox: [] };
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const key = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim();
    const permKey = PERMISSION_KEYS.get(key.toLowerCase());
    if (permKey) perm[permKey].push({ key, value });
    else meta[key] = value;
  }

  const name = meta.name?.trim();
  if (!name) return null;

  const norm = normalizePermission(perm.permission, perm.permissionMode, perm.sandbox);

  const budget = meta.maxBudgetUsd ? Number(meta.maxBudgetUsd) : NaN;
  const description = meta.description ?? '';
  const fieldWarnings: string[] = [];
  const timeout = parseTemplateTimeout(meta.timeout);
  if (timeout.warning) fieldWarnings.push(timeout.warning);
  const harnesses = parseTemplateHarnesses(meta.harnesses);
  fieldWarnings.push(...harnesses.warnings);

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
    ignoredLegacyPermission: norm.ignoredLegacyPermission,
    model: meta.model || undefined,
    maxBudgetUsd: Number.isFinite(budget) && budget > 0 ? budget : undefined,
    skill: meta.skill || undefined,
    defaultTask: meta.defaultTask || undefined,
    defaultScope: meta.defaultScope || undefined,
    verify: meta.verify || undefined,
    addDirs: parseList(meta.addDirs),
    prompt: m[2].trim(),
    harness: meta.harness || undefined,
    timeoutSec: timeout.timeoutSec,
    harnesses: harnesses.harnesses,
    fieldWarnings: fieldWarnings.length > 0 ? fieldWarnings : undefined,
  };
}

function loadDir(dir: string, out: Map<string, DelegateTemplate>, source: TemplateSource): void {
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.md')) continue;
    try {
      const t = parseTemplate(readFileSync(join(dir, f), 'utf8'));
      if (t) out.set(t.name, { ...t, source });
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
  loadDir(builtinTemplatesDir(), out, 'builtin');
  // shared canonical bodies
  loadDir(sharedTemplatesDir(), out, 'builtin');
  // harness-specific builtins override shared
  loadDir(builtinHarnessTemplatesDir(harness), out, 'builtin');
  // user globals: legacy before new so new wins
  loadDir(legacyUserTemplatesDir(), out, 'user');
  loadDir(userTemplatesDir(), out, 'user');
  loadDir(userTemplatesDir(harness), out, 'user');
  // project locals: legacy before new so new wins — only if trusted
  if (trusted) {
    loadDir(legacyProjectTemplatesDir(cwd), out, 'project');
    loadDir(projectTemplatesDir(cwd), out, 'project');
    loadDir(projectTemplatesDir(cwd, harness), out, 'project');
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
