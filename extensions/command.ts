import type { DelegateTemplate } from './templates.ts';

/**
 * Pure parser for /delegate and alias commands: --key=value flags, with optional
 * harness as first word and template name as next word.
 */

export interface DelegateCommandArgs {
  task: string;
  harness?: string;
  mode?: string;
  model?: string;
  scope?: string;
  budget?: number;
  /** Resume an existing delegated session (--resume=<id>). */
  sessionId?: string;
  /** GitHub PR number/URL to review (--pr=). */
  pr?: string;
  /** Host-run verification command override (--verify=); takes precedence over the template's. */
  verify?: string;
}

export type ClaudeCommandArgs = DelegateCommandArgs;

const KNOWN_HARNESSES = new Set(['claude', 'codex', 'opencode', 'amp', 'omp']);

/** True when `word` is `all`, a single known harness/alias, or a comma-separated list of them. */
function looksLikeHarnessSpec(word: string, knownHarnesses: ReadonlySet<string>): boolean {
  const lower = word.toLowerCase();
  if (lower === 'all' || knownHarnesses.has(lower)) return true;
  const parts = lower.split(',').filter(Boolean);
  return parts.length > 1 && parts.every(p => knownHarnesses.has(p));
}

export function parseDelegateCommand(
  raw: string,
  knownModes: ReadonlySet<string>,
  knownHarnesses: ReadonlySet<string> = KNOWN_HARNESSES,
): DelegateCommandArgs {
  const flags: Record<string, string> = {};
  // supports quoted values ("…"/'…') so multi-word flags like --verify="bun test" survive intact
  const rest = raw.replace(
    /--([a-zA-Z-]+)=(?:"([^"]*)"|'([^']*)'|(\S+))/g,
    (_m, k: string, dq: string | undefined, sq: string | undefined, bare: string | undefined) => {
      flags[k] = dq ?? sq ?? bare ?? '';
      return '';
    },
  );

  let harness = flags.harness?.toLowerCase();
  let mode = flags.mode;
  let task = rest.trim();

  // First word handling: harness (single, `all`, or comma list), mode, or both
  const words = task.split(/\s+/).filter(Boolean);
  let idx = 0;
  if (!harness && words[idx] && looksLikeHarnessSpec(words[idx], knownHarnesses)) {
    harness = words[idx].toLowerCase();
    // single-name alias normalization only — a list/`all` is resolved later by resolveHarnessList
    if (harness === 'omp') harness = 'amp';
    idx++;
  }
  if (!mode && words[idx] && knownModes.has(words[idx])) {
    mode = words[idx];
    idx++;
  }
  if (idx > 0) task = words.slice(idx).join(' ').trim();

  const out: DelegateCommandArgs = { task };
  if (harness) out.harness = harness;
  if (mode) out.mode = mode;
  if (flags.model) out.model = flags.model;
  if (flags.scope) out.scope = flags.scope;
  if (flags.budget !== undefined) {
    const budget = Number(flags.budget);
    if (Number.isFinite(budget) && budget > 0) out.budget = budget;
  }
  if (flags.resume) out.sessionId = flags.resume;
  if (flags.pr) out.pr = flags.pr;
  if (flags.verify) out.verify = flags.verify;
  return out;
}

export function parseClaudeCommand(raw: string, knownModes: ReadonlySet<string>): ClaudeCommandArgs {
  return parseDelegateCommand(raw, knownModes);
}

/** True when a `harness` field selects more than one harness: `all` or a comma-separated list. */
export function isFanoutSpec(harness: string | undefined): boolean {
  if (!harness) return false;
  const lower = harness.trim().toLowerCase();
  return lower === 'all' || lower.includes(',');
}

export interface HarnessListResolution {
  /** Canonical harness names to run, in request order, deduped. */
  resolved: string[];
  /** Requested names that don't match any known harness or alias. */
  unknown: string[];
  /** Known harnesses that were requested/selected by `all` but aren't detected as installed. */
  skipped: string[];
}

/**
 * Resolve a `harness` field (`all` or a comma-separated list of names/aliases) into the
 * canonical harness names a fan-out should actually run. Pure — detection results and the
 * known-harness/alias lookups are passed in, no I/O happens here.
 *
 * `all` resolves to every *detected* harness (skipping uninstalled ones). An explicit list is
 * validated against `isKnown`/`aliasOf` and also filtered by detection, so a named-but-uninstalled
 * harness is reported (via `skipped`) instead of failing the whole run.
 */
export function resolveHarnessList(
  spec: string,
  opts: {
    knownHarnesses: readonly string[];
    aliasOf: (name: string) => string;
    isKnown: (name: string) => boolean;
    detection: Readonly<Record<string, { ok: boolean }>>;
  },
): HarnessListResolution {
  const lower = spec.trim().toLowerCase();
  const isAll = lower === 'all';
  const requested = isAll
    ? opts.knownHarnesses
    : lower
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);

  const resolved: string[] = [];
  const unknown: string[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  for (const raw of requested) {
    if (!isAll && !opts.isKnown(raw)) {
      unknown.push(raw);
      continue;
    }
    const canon = opts.aliasOf(raw);
    if (seen.has(canon)) continue;
    seen.add(canon);
    if (opts.detection[canon]?.ok) resolved.push(canon);
    else skipped.push(canon);
  }
  return { resolved, unknown, skipped };
}

/**
 * Apply template defaults when the prompt is empty.
 */
export function resolveDefaults(
  args: DelegateCommandArgs,
  templates: ReadonlyMap<string, DelegateTemplate>,
): { task: string; scope?: string } | null {
  if (args.task) {
    return args.scope ? { task: args.task, scope: args.scope } : { task: args.task };
  }
  if (args.mode) {
    const t = templates.get(args.mode);
    if (t?.defaultTask) {
      const scope = args.scope ?? t.defaultScope;
      return scope ? { task: t.defaultTask, scope } : { task: t.defaultTask };
    }
    return null;
  }
  return null;
}
