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
  /** Extra directories the harness may access (--add-dir=, repeatable). */
  addDirs?: string[];
  /**
   * `--allow-dangerous` (or `--allow-dangerous=true`): a human asking to run this one invocation
   * with danger permission. Only ever honored after an interactive confirm in the command handler
   * — never inherited from config, never applied headless. Absent unless explicitly true.
   */
  allowDangerous?: boolean;
  /** Flag values that were given but are unusable (e.g. `--budget=0`) — the handler reports these
   *  and runs nothing, rather than silently dropping the flag. Absent when there are none. */
  errors?: string[];
}

export type ClaudeCommandArgs = DelegateCommandArgs;

/**
 * The flag set every `/delegate`-family command accepts after the harness — the single source for
 * the `/delegate` description, its usage warning, and every alias command's (`/claude`, `/omp`, …)
 * description, so the hints can't drift from what `parseDelegateCommand` actually parses.
 */
export const COMMAND_FLAGS_HINT =
  '[--mode=review|plan|implement|security-audit|docs|general] [--model=…] [--scope=diff|pr|paths] [--pr=<n|url>] [--budget=<usd>] [--verify=<cmd>] [--resume=<id>] [--add-dir=<path>] [--allow-dangerous] <prompt>';

/** Usage line for `/delegate` itself. */
export function delegateUsage(): string {
  return `/delegate [--harness=claude|codex|opencode|amp|devin|all|<a,b>] ${COMMAND_FLAGS_HINT}`;
}

/** Usage line for an alias command (`/claude`, `/omp`, …) — same flags, harness fixed. */
export function aliasUsage(command: string): string {
  return `/${command} ${COMMAND_FLAGS_HINT}`;
}

const KNOWN_HARNESSES = new Set(['claude', 'codex', 'opencode', 'amp', 'omp', 'devin']);
const HARNESS_ALIASES: Readonly<Record<string, string>> = { omp: 'amp' };

/** True when `word` is `all`, a single known harness/alias, or a comma-separated list of them
 *  (a stray empty element, e.g. the trailing comma in `claude,`, is ignored). */
function looksLikeHarnessSpec(word: string, knownHarnesses: ReadonlySet<string>): boolean {
  const lower = word.toLowerCase();
  if (lower === 'all' || knownHarnesses.has(lower)) return true;
  if (!lower.includes(',')) return false;
  const parts = lower.split(',').filter(Boolean);
  return parts.length > 0 && parts.every(p => knownHarnesses.has(p));
}

/**
 * Normalize a harness spec the same way whether it came from `--harness=` or the first word:
 * lowercased, empty list elements dropped (`claude,` -> `claude`, `,` -> none), and a single name
 * alias-normalized (`omp` -> `amp`). A real list / `all` is left for `resolveHarnessList`.
 */
function normalizeHarnessSpec(spec: string): string | undefined {
  const parts = spec
    .toLowerCase()
    .split(',')
    .map(p => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return undefined;
  if (parts.length === 1) return HARNESS_ALIASES[parts[0]] ?? parts[0];
  return parts.join(',');
}

/**
 * One pass over the raw command: a backticked or double-quoted prose span is skipped verbatim (so
 * `explain "--mode=x"` or `` `--allow-dangerous` `` in the prompt is never eaten as a flag); a
 * `--key=value` (value bare, "double" or 'single' quoted) or bare `--allow-dangerous` token that
 * starts a word is a flag. Every other `--word` stays in the text untouched.
 */
const FLAG_OR_PROSE = /`[^`]*`|"[^"]*"|(^|\s)--([a-zA-Z][a-zA-Z-]*)(?:=(?:"([^"]*)"|'([^']*)'|(\S+))|(?=\s|$))/g;

export function parseDelegateCommand(
  raw: string,
  knownModes: ReadonlySet<string>,
  knownHarnesses: ReadonlySet<string> = KNOWN_HARNESSES,
): DelegateCommandArgs {
  const flags: Record<string, string> = {};
  const addDirs: string[] = [];
  const errors: string[] = [];
  let allowDangerousBare = false;
  const rest = raw.replace(
    FLAG_OR_PROSE,
    (
      m: string,
      lead: string | undefined,
      k: string | undefined,
      dq: string | undefined,
      sq: string | undefined,
      bare: string | undefined,
    ) => {
      if (k === undefined) return m; // quoted/backticked prose — leave it alone
      const hasValue = dq !== undefined || sq !== undefined || bare !== undefined;
      if (!hasValue) {
        // bare boolean flag: only `--allow-dangerous`; any other bare `--word` is prose
        if (k !== 'allow-dangerous') return m;
        allowDangerousBare = true;
        return lead ?? '';
      }
      const value = dq ?? sq ?? bare ?? '';
      // --add-dir is the one repeatable flag — every occurrence is kept, in order
      if (k === 'add-dir') {
        if (value) addDirs.push(value);
      } else flags[k] = value;
      return lead ?? '';
    },
  );

  let harness = flags.harness !== undefined ? normalizeHarnessSpec(flags.harness) : undefined;
  let mode = flags.mode;
  let task = rest.trim();

  // First word handling: harness (single, `all`, or comma list), mode, or both
  const words = task.split(/\s+/).filter(Boolean);
  let idx = 0;
  if (!harness && words[idx] && looksLikeHarnessSpec(words[idx], knownHarnesses)) {
    harness = normalizeHarnessSpec(words[idx]);
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
    // an explicit spend cap that can't be honored is an error, never silently "no cap"
    if (flags.budget.trim() !== '' && Number.isFinite(budget) && budget > 0) out.budget = budget;
    else errors.push(`--budget must be a positive number of USD (got "${flags.budget}")`);
  }
  if (flags.resume) out.sessionId = flags.resume;
  if (flags.pr) out.pr = flags.pr;
  if (flags.verify) out.verify = flags.verify;
  if (addDirs.length > 0) out.addDirs = addDirs;
  // `=true` is tolerated; any other explicit value (`=false`, `=yes`, …) means off — fail closed
  if (allowDangerousBare || flags['allow-dangerous']?.toLowerCase() === 'true') out.allowDangerous = true;
  if (errors.length > 0) out.errors = errors;
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

/**
 * A session id belongs to exactly one harness's session store, so resuming "it" across a fan-out
 * is meaningless — every other harness would either error out or silently start fresh under a
 * foreign id. Returns the rejection message (null when fine); shared by the tool and command paths.
 */
export function fanoutResumeError(harnessSpec: string | undefined, sessionId: string | undefined): string | null {
  if (!sessionId || !isFanoutSpec(harnessSpec)) return null;
  return `cannot resume session "${sessionId}" across a fan-out (harness "${harnessSpec}") — a session id belongs to one harness; resume it with that single harness instead (e.g. /delegate --harness=<name> --resume=${sessionId} …)`;
}

export type HarnessFilterResolution =
  | { kind: 'none' } // no filter word given
  | { kind: 'known'; harness: string } // resolved to its canonical name (aliases/case normalized)
  | { kind: 'unknown'; requested: string }; // word given, but not a known harness or alias

/**
 * Resolve a single optional harness-filter word — as used by `/delegate list`/`history`'s bare
 * word or `--harness=` flag — to its canonical name via `aliasOf`, case-insensitively, so `omp`,
 * `OMP`, and `amp` all filter identically. Pure and shared by both subcommands so they can't drift
 * on alias/case handling the way they once did.
 */
export function resolveHarnessFilter(
  word: string | undefined,
  opts: { isKnown: (name: string) => boolean; aliasOf: (name: string) => string },
): HarnessFilterResolution {
  if (!word) return { kind: 'none' };
  const lower = word.toLowerCase();
  if (!opts.isKnown(lower)) return { kind: 'unknown', requested: word };
  return { kind: 'known', harness: opts.aliasOf(lower) };
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
