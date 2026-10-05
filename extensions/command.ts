import {
  callTimeoutError,
  type DelegateTemplate,
  TEMPLATE_TIMEOUT_MAX_SEC,
  TEMPLATE_TIMEOUT_MIN_SEC,
} from './templates.ts';

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
  /** Per-call harness timeout in seconds (--timeout=<sec>); wins over the template's `timeout:`. */
  timeoutSec?: number;
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
  /**
   * Internal — set only by the rerun planner, never parsed from text: the `timeoutSec` / `budget`
   * came from a stored run record (untrusted data), so each may only NARROW what is configured — the
   * same rule as a model-set tool param. A human-typed `--timeout=`/`--budget=` on the rerun line
   * replaces the stored value and is not marked.
   */
  storedTimeout?: boolean;
  storedBudget?: boolean;
  /** Flag values that were given but are unusable (e.g. `--budget=0`) — the handler reports these
   *  and runs nothing, rather than silently dropping the flag. Absent when there are none. */
  errors?: string[];
  /** Non-fatal heads-ups the handler shows before running — e.g. a recognized `--flag=` that sat
   *  inside a double-quoted span and so was kept as prompt text, not applied. Absent when none. */
  notices?: string[];
}

export type ClaudeCommandArgs = DelegateCommandArgs;

/**
 * The flag set every `/delegate`-family command accepts after the harness — the single source for
 * the `/delegate` description, its usage warning, and every alias command's (`/claude`, `/omp`, …)
 * description, so the hints can't drift from what `parseDelegateCommand` actually parses.
 */
export const COMMAND_FLAGS_HINT =
  '[--mode=review|plan|implement|security-audit|docs|general] [--model=…] [--scope=diff|pr|paths] [--pr=<n|url>] [--budget=<usd>] [--timeout=<sec>] [--verify=<cmd>] [--resume=<id>] [--add-dir=<path>] [--allow-dangerous] <prompt>';

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
 * Normalize a harness spec the same way whether it came from `--harness=`, the first word, or the
 * `delegate` tool's `harness` param: lowercased, empty list elements dropped (`claude,` -> `claude`,
 * `,` -> none), and a single name alias-normalized (`omp` -> `amp`). A real list / `all` is left for
 * `resolveHarnessList`. Sharing it is what keeps both paths agreeing on single run vs fan-out.
 */
export function normalizeHarnessSpec(spec: string): string | undefined {
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
 * The harness spec a template's `harnesses:` frontmatter contributes when the caller named no
 * harness (`undefined` when it declares none). Callers only consult this when no harness was given —
 * an explicit `--harness=`, first-word harness, alias command or tool `harness` param always wins.
 *
 * The same on both paths (the `/delegate` command and the `delegate` tool): one name is a normal
 * single run (fail-fast at capacity); several are a fan-out spec, which each path hands to its
 * unchanged fan-out runner (`runFanoutCommand` / `runFanoutTool`) — `resolveHarnessList` detection
 * filtering and unknown/skipped reporting, `waitForSlot: true` through `acquireSlot`,
 * `fanoutResumeError`, and the path's own danger/addDirs confirm gates resolved against this spec.
 */
export function templateHarnessDefault(harnesses: readonly string[] | undefined): string | undefined {
  if (!harnesses || harnesses.length === 0) return undefined;
  return normalizeHarnessSpec(harnesses.join(','));
}

/** The error for a harness spec that normalizes to nothing (`,`, `" , "`) — shared by `/delegate`'s
 *  `--harness=` and the `delegate` tool's `harness` param, so neither silently runs the default. */
export function emptyHarnessSpecError(raw: string): string {
  return `harness ${JSON.stringify(raw)} names no harness: give a harness name, a comma-separated list, or "all" (omit it for the default harness)`;
}

/**
 * One pass over the raw command: a backticked or double-quoted prose span is skipped verbatim (so
 * `explain "--mode=x"` or `` `--allow-dangerous` `` in the prompt is never eaten as a flag); a
 * `--key=value` (value bare, "double" or 'single' quoted, or empty) or bare `--allow-dangerous` /
 * `--budget` token that starts a word is a flag. Every other `--word` stays in the text untouched.
 */
const FLAG_OR_PROSE = /`[^`]*`|"[^"]*"|(^|\s)--([a-zA-Z][a-zA-Z-]*)(?:=(?:"([^"]*)"|'([^']*)'|(\S*))|(?=\s|$))/g;

/**
 * Pull standalone bare flags (`--here`, `--fanout`, …: no `=value`) named in `names` out of `raw`,
 * using the same quote/backtick-aware pass as `parseDelegateCommand`, so one inside a quoted or
 * backticked span (or a `--verify="… --here …"` value) is left alone. Returns the text without them.
 * For subcommands (like `rerun`) whose own flags the main parser doesn't know.
 */
export function extractBareFlags<N extends string>(raw: string, names: readonly N[]): { rest: string; found: Set<N> } {
  const found = new Set<N>();
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
      if (k === undefined || dq !== undefined || sq !== undefined || bare !== undefined) return m;
      if (!(names as readonly string[]).includes(k)) return m;
      found.add(k as N);
      return lead ?? '';
    },
  );
  return { rest, found };
}

/** Every flag `parseDelegateCommand` acts on — used to notice one stranded inside quoted prose. */
const RECOGNIZED_FLAGS = new Set([
  'harness',
  'mode',
  'model',
  'scope',
  'budget',
  'timeout',
  'resume',
  'pr',
  'verify',
  'add-dir',
  'allow-dangerous',
]);

/** A recognized flag token starting a word inside a prose span (quote/backtick counts as a word start). */
const FLAG_IN_PROSE = /(?:^|[\s"`])--([a-zA-Z][a-zA-Z-]*)(?==|[\s"`]|$)/g;

/** Prose spans as FLAG_OR_PROSE pairs them; whatever delimiter is left over afterwards is unmatched. */
const PROSE_SPAN = /`[^`]*`|"[^"]*"/g;

export function parseDelegateCommand(
  raw: string,
  knownModes: ReadonlySet<string>,
  knownHarnesses: ReadonlySet<string> = KNOWN_HARNESSES,
): DelegateCommandArgs {
  const flags: Record<string, string> = {};
  const addDirs: string[] = [];
  const errors: string[] = [];
  const notices: string[] = [];
  let allowDangerousBare = false;
  // `--budget` / `--timeout` given with no `=value` (e.g. the space form `--budget 5`)
  const valuelessLimits = new Set<string>();
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
      if (k === undefined) {
        // quoted/backticked prose — left alone. A double-quoted span holding a recognized flag is
        // most likely an accident (`fix "bug --budget=5 and "more`): say so instead of dropping it
        // silently. Backticks are the deliberate "this is literal" marker, so they stay quiet.
        if (m.startsWith('"')) {
          for (const [, name] of m.matchAll(FLAG_IN_PROSE)) {
            if (!RECOGNIZED_FLAGS.has(name)) continue;
            notices.push(
              `--${name} inside double quotes was kept as prompt text, not applied — move it outside the quotes to use it as a flag`,
            );
          }
        }
        return m;
      }
      const hasValue = dq !== undefined || sq !== undefined || bare !== undefined;
      if (!hasValue) {
        // bare boolean flag: only `--allow-dangerous`. A bare `--budget`/`--timeout` (e.g. the space
        // form `--budget 5`) is an explicit limit we can't honor — an error, never silently "no
        // limit". Any other bare `--word` is prose.
        if (k === 'budget' || k === 'timeout') {
          valuelessLimits.add(k);
          return m;
        }
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

  // An unmatched `"` or backtick makes the pairing above a guess: in `fix "x --verify="echo ok"` the
  // stray quote pairs with the flag's own opening quote, so the real flag is eaten as prose and
  // whatever followed it is parsed as flags instead. Text before the first delimiter is outside any
  // span however the quotes pair, so only a flag-shaped token at or after it is in play; when one
  // is, refuse rather than guess — the result must not depend on quote parity.
  const strayDelimiter = /["`]/.test(rest.replace(PROSE_SPAN, ''));
  const firstDelimiter = raw.search(/["`]/);
  const ambiguous = strayDelimiter && firstDelimiter >= 0 && /--[a-zA-Z]/.test(raw.slice(firstDelimiter));
  if (ambiguous) {
    errors.push(
      'unbalanced " or ` in the command — flags around it can\'t be told apart from prompt text; close the quote (or remove it) and try again',
    );
  }
  for (const [k, unit] of [
    ['budget', 'usd'],
    ['timeout', 'sec'],
  ] as const) {
    if (valuelessLimits.has(k) && flags[k] === undefined)
      errors.push(
        `--${k} needs a value: use --${k}=<${unit}> (or wrap the text in backticks if it is part of the prompt)`,
      );
  }

  let harness = flags.harness !== undefined ? normalizeHarnessSpec(flags.harness) : undefined;
  // `--harness=,` / `--harness=" , "` / `--harness=` name no harness at all: an explicit choice we
  // can't honor is an error, never a silent fall-back to the default harness.
  if (flags.harness !== undefined && harness === undefined) errors.push(emptyHarnessSpecError(flags.harness));
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
  if (flags.timeout !== undefined) {
    const v = flags.timeout.trim();
    const sec = /^\d{1,9}$/.test(v) ? Number(v) : Number.NaN;
    // an explicit time limit that can't be honored is an error, never silently "the configured one"
    if (callTimeoutError(sec) === null) out.timeoutSec = sec;
    else
      errors.push(
        `--timeout must be a whole number of seconds from ${TEMPLATE_TIMEOUT_MIN_SEC} to ${TEMPLATE_TIMEOUT_MAX_SEC} (got "${flags.timeout.slice(0, 40)}")`,
      );
  }
  if (flags.resume) out.sessionId = flags.resume;
  if (flags.pr) out.pr = flags.pr;
  if (flags.verify) out.verify = flags.verify;
  if (addDirs.length > 0) out.addDirs = addDirs;
  // `=true` is tolerated; any other explicit value (`=false`, `=yes`, …) means off — fail closed
  // never grant danger off an ambiguous parse — the error above stops the run anyway, but fail closed
  if (!ambiguous && (allowDangerousBare || flags['allow-dangerous']?.toLowerCase() === 'true'))
    out.allowDangerous = true;
  if (errors.length > 0) out.errors = errors;
  if (notices.length > 0) out.notices = [...new Set(notices)];
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
  return `cannot resume session "${sessionId}" across a fan-out (harness "${harnessSpec}") — a session id belongs to one harness; resume it with that single harness instead (e.g. /delegate --harness=<name> --resume=${sessionId} …); to resume every member of a past fan-out, pass its fan-out id instead (--resume=fan_…, shown in the fan-out report)`;
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
