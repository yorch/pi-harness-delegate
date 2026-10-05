/**
 * `/delegate rerun [n|runId]` — re-run a recorded run through the normal command path.
 *
 * Trust model: the run record is **stored data and therefore untrusted** — a hand-edited or hostile
 * sidecar must not be able to inject argv, widen permissions or smuggle terminal escapes. So this
 * module only *plans* a rerun: it re-validates every stored value (`validateDelegateInputs`, the same
 * gate a typed command goes through), requires the mode to resolve *now* (same trust gating as any
 * run), and returns ordinary `DelegateCommandArgs` that the caller feeds to the normal handler path,
 * where the danger confirm, addDirs handling, concurrency guard and verify rules all apply afresh.
 * It never replays `allowDangerous` (a record doesn't hold it; the human passes `--allow-dangerous`
 * again) nor `verify` (a record holds only a boolean; the human passes `--verify=` again), and it
 * starts a fresh session unless `--resume` is passed.
 */

import { resolve } from 'node:path';
import type { DelegateCommandArgs } from './command.ts';
import { legacyOutputsDir, outputsDir } from './config.ts';
import { SCOPE_LIMITS, TASK_LIMITS, textTooLongReason, type Viewport } from './confirm-layout.ts';
import type { EffectiveCall } from './effective.ts';
import { HARNESS_NAMES } from './harnesses/registry.ts';
import { type NormalizedPermission, TIER_RANK, type TierCeiling } from './harnesses/types.ts';
import type { HistoryEntry } from './history-filter.ts';
import {
  displayText,
  isRunId,
  type LocatedRecord,
  loadRecordForTranscript,
  MAX_SIDECARS_SCANNED,
  newestFirst,
  type RunRecord,
  readRecordsIn,
  type SkippedRecord,
} from './run-record.ts';
import { forbiddenCharacter } from './sanitize.ts';
import { callTimeoutError, quoteFull, quoteValue } from './templates.ts';
import { buildConfirmation, fieldRefusal, validateDelegateInputs } from './validate.ts';

/**
 * Every usable record on disk — all harness partitions plus the legacy dir — newest transcript first
 * (the very ordering `/delegate history` lists, `newestFirst`). Only records with a sibling transcript
 * in their own harness's directory count (`readRecordsIn`); unusable ones come back in `skipped`.
 * Never throws.
 */
export function readAllRecordsDetailed(): {
  records: LocatedRecord[];
  skipped: SkippedRecord[];
  /** Outputs directories with more transcripts than were scanned (only the newest `MAX_SIDECARS_SCANNED` count). */
  truncated: string[];
} {
  const records: LocatedRecord[] = [];
  const skipped: SkippedRecord[] = [];
  const truncated: string[] = [];
  const dirs: [string, string][] = [...HARNESS_NAMES.map(h => [outputsDir(h), h] as [string, string])];
  dirs.push([legacyOutputsDir(), 'claude']);
  for (const [dir, harness] of dirs) {
    const r = readRecordsIn(dir, harness);
    records.push(...r.records);
    skipped.push(...r.skipped);
    if (r.truncated) truncated.push(dir === legacyOutputsDir() ? `${harness} (legacy directory)` : harness);
  }
  records.sort((a, b) =>
    newestFirst({ mtimeMs: a.mtimeMs, name: a.transcript }, { mtimeMs: b.mtimeMs, name: b.transcript }),
  );
  return { records, skipped, truncated };
}

/** Every usable record (see `readAllRecordsDetailed`), newest transcript first. */
export function readAllRecords(): RunRecord[] {
  return readAllRecordsDetailed().records.map(l => l.record);
}

export type RecordSelection = { ok: true; record: RunRecord } | { ok: false; error: string };

/** " (N record file(s) were ignored: <reason>; the scan stopped at …)" for an error message, or '' when there is nothing to say. */
function ignoredNote(skipped: readonly SkippedRecord[], truncated: readonly string[] = []): string {
  const parts: string[] = [];
  if (skipped.length > 0)
    parts.push(
      `${skipped.length} record file(s) were ignored as unusable, e.g. ${quoteValue(displayText(skipped[0].reason, 100), 140)}`,
    );
  if (truncated.length > 0)
    parts.push(
      `only the newest ${MAX_SIDECARS_SCANNED} transcripts in each outputs directory are scanned and ${truncated.join(', ')} ${truncated.length > 1 ? 'have' : 'has'} more — older runs are not listed`,
    );
  return parts.length > 0 ? ` (${parts.join('; ')})` : '';
}

/**
 * Pick the record to rerun. `selector` is `undefined` (the newest completed run with a record — by
 * transcript mtime, the order history lists), a 1-based position in `view` (the history listing the user
 * last saw, or the unfiltered history), or a run id.
 */
export function selectRecord(
  selector: string | undefined,
  view: readonly HistoryEntry[],
  /** An alias command's own harness: a bare `rerun` then means the newest run of THAT harness. */
  harness?: string,
): RecordSelection {
  if (selector !== undefined && isRunId(selector)) {
    const { records, skipped, truncated } = readAllRecordsDetailed();
    const hits = records.filter(r => r.record.runId === selector);
    if (hits.length > 1)
      return { ok: false, error: `run id ${selector} is ambiguous — ${hits.length} records claim it` };
    return hits[0]
      ? { ok: true, record: hits[0].record }
      : { ok: false, error: `no run record with id ${selector}${ignoredNote(skipped, truncated)}` };
  }
  if (selector === undefined) {
    // no selector: the newest *completed* run that has a record (a partial run is rerunnable only by id)
    const { records, skipped, truncated } = readAllRecordsDetailed();
    const rec = records.find(r => !r.record.partial && (harness === undefined || r.record.harness === harness));
    return rec
      ? { ok: true, record: rec.record }
      : {
          ok: false,
          error: `no ${harness === undefined ? '' : `${harness} `}run records yet — nothing to rerun${ignoredNote(skipped, truncated)}`,
        };
  }
  if (!/^\d{1,4}$/.test(selector) || Number(selector) < 1)
    return {
      ok: false,
      error: `expected a position (1, 2, …) or a run id (run_…), got ${quoteValue(selector, 60)}`,
    };
  const n = Number(selector);
  const entry = view[n - 1];
  if (!entry)
    return {
      ok: false,
      error: view.length === 0 ? 'no past runs to rerun' : `no run #${n} — the history view has ${view.length}`,
    };
  if (!entry.hasRecord)
    return {
      ok: false,
      error: entry.recordProblem
        ? `run #${n} (${quoteValue(entry.mode, 80)}) has an unusable record (${quoteValue(displayText(entry.recordProblem, 100), 140)}), so it cannot be rerun`
        : `run #${n} (${quoteValue(entry.mode, 80)}) predates run records, so it cannot be rerun`,
    };
  // re-validated against the directory the transcript lives in — the same check the listing applied
  const loaded = loadRecordForTranscript(entry.file, entry.harness);
  return loaded.ok
    ? { ok: true, record: loaded.record }
    : { ok: false, error: `run #${n}'s record is unusable (${quoteValue(displayText(loaded.reason, 100), 140)})` };
}

export interface RerunFlags {
  /** `--here`: run in the current directory even though the record's cwd differs. */
  here: boolean;
  /** `--fanout`: rerun every member of the record's fan-out, not just this run. */
  fanout: boolean;
  /** bare `--resume`: continue the record's own session instead of starting fresh. */
  resumeOwn: boolean;
  /** `--long-task`: the human accepts a task/scope too long for a confirmation to show whole (head + tail are shown). */
  longTask?: boolean;
  /** `--trust-origin`: a non-interactive rerun of a record that was not started by a `/delegate` command. */
  trustOrigin?: boolean;
}

export interface RerunEnv {
  cwd: string;
  /** Whether a person will be shown the plan and asked (a UI session). Absent = headless. */
  hasUI?: boolean;
  isKnownHarness: (name: string) => boolean;
  /**
   * The tier `mode` would run at on `harness` TODAY (the engine's own classification —
   * `effectiveTemplateTier`), or `null` when it does not resolve now (removed, or a project-local
   * template in a project pi does not trust).
   */
  modeTier: (harness: string, mode: string) => NormalizedPermission | null;
  /** Records sharing the selected one's fan-out id (when it has one), newest first. */
  siblings: readonly RunRecord[];
  /** The terminal the plan will be shown on (default: the real one). */
  viewport?: Viewport;
  /** What the run will actually apply once template / config defaults are resolved, one line per harness (`effectiveRunLines`). */
  effective?: (harnesses: string[], mode: string, call: EffectiveCall) => string[];
}

export interface RerunPlan {
  errors: string[];
  notices: string[];
  args?: DelegateCommandArgs;
  /** The plan as one sanitized line per fact — what an interactive session must confirm before anything runs. */
  summary: string[];
  /** Extra directories that came from the stored record (not typed now): treated like model-set values. */
  storedAddDirs: string[];
}

/** How a record says it was started, in words — shown in the plan and in refusals. */
export function describeOrigin(origin: RunRecord['origin']): string {
  return origin === 'command'
    ? 'a /delegate command'
    : origin === 'tool'
      ? 'the delegate tool (the model)'
      : 'unknown (a legacy record, or one that does not say)';
}

/**
 * Turn a record + the human's command-line overrides into the `DelegateCommandArgs` of an ordinary
 * `/delegate` invocation. `overrides` is the parsed rest of the rerun command line (`--harness=`,
 * `--model=`, …); anything it sets wins over the record. Pure aside from the env callbacks.
 *
 * A rerun uses TODAY's template for the mode, never a stored copy: if that template's tier is WIDER
 * than the recorded run's, it is refused (the human can start the run with the normal command) —
 * unless the human TYPED a different `--mode=`/`--harness=` (an override equal to the record's own
 * value is not a choice and skips nothing).
 * Stored values are untrusted: a stored `timeoutSec`/budget may only narrow what is configured
 * (`storedTimeout`/`storedBudget`), stored `addDirs` are returned in `storedAddDirs` for the caller to
 * gate like model-set ones; only values typed on the rerun line carry human trust. The whole task is
 * shown in the plan (see `renderTextBlock`): a value too long to show whole is refused unless the human
 * typed `--long-task`. A record that was not started by a `/delegate command` is flagged in the plan and
 * is refused non-interactively unless `--trust-origin` was typed.
 */
export function planRerun(
  record: RunRecord,
  overrides: DelegateCommandArgs,
  flags: RerunFlags,
  env: RerunEnv,
): RerunPlan {
  const errors: string[] = [];
  const notices: string[] = [];
  const summary: string[] = [];
  const fail = (msg: string): RerunPlan => ({ errors: [...errors, msg], notices, summary, storedAddDirs: [] });
  const input = record.input;
  // Only members recorded in the SAME working directory as the selected run belong to this rerun (a session and
  // a template belong to the directory they ran in) — the others are listed, never silently dropped.
  const sameDir = (r: RunRecord): boolean => resolve(r.cwd) === resolve(record.cwd);
  const siblings = env.siblings.filter(sameDir);
  const otherDir = env.siblings.filter(r => !sameDir(r));

  if (overrides.errors?.length) return { errors: overrides.errors, notices, summary, storedAddDirs: [] };
  if (overrides.task) return fail('rerun takes no new prompt — use /delegate <prompt> to start a different run');

  if (input.taskTruncated)
    return fail('the stored task was truncated when the run was recorded, so it cannot be rerun faithfully');
  if (input.scopeTruncated && overrides.scope === undefined)
    return fail(
      'the stored scope was truncated when the run was recorded (a cut scope would silently widen the restriction), so it cannot be rerun faithfully — pass --scope=… to give one',
    );
  if (resolve(record.cwd) !== resolve(env.cwd)) {
    if (!flags.here)
      return fail(
        `this run was in ${quoteValue(record.cwd, 160)} but the current directory is ${quoteValue(env.cwd, 160)} — cd there, or pass --here to run it in the current directory`,
      );
    notices.push(
      `running in the current directory (${quoteValue(env.cwd, 160)}), not the original ${quoteValue(record.cwd, 160)}`,
    );
  }
  if (flags.fanout && flags.resumeOwn)
    return fail(
      '--fanout --resume is not supported — resume a whole fan-out with /delegate --resume=<fan_…id> <prompt>',
    );

  // A typed --harness is normalized and de-duplicated first: `claude,claude` IS the record's single `claude`,
  // not a different choice (and not a one-member fan-out).
  const typedHarnesses =
    overrides.harness === undefined ? undefined : [...new Set(overrides.harness.split(',').filter(Boolean))];
  const typedHarness = typedHarnesses === undefined ? undefined : typedHarnesses.join(',');
  const harness = typedHarness ?? record.harness;
  const fanoutSpec =
    flags.fanout || (typedHarnesses !== undefined && typedHarnesses.length > 1) || typedHarness === 'all';
  let harnessSpec = harness;
  if (flags.fanout) {
    if (!record.fanoutId) return fail('--fanout: this run was not part of a fan-out');
    if (typedHarness === undefined) {
      const members = [...new Set([record, ...siblings].map(r => r.harness))];
      harnessSpec = members.join(',');
    }
  }
  const harnessNames = harnessSpec.split(',').filter(Boolean);
  for (const h of harnessNames)
    if (h !== 'all' && !env.isKnownHarness(h)) return fail(`unknown harness ${quoteValue(h, 80)}`);
  const mode = overrides.mode ?? record.mode;

  // Who started the run(s) being repeated: shown in the plan; a record that was not started by a
  // /delegate command (tool call, or unknown) needs `--trust-origin` when there is no person to look at the plan.
  const started = flags.fanout ? [record, ...siblings.filter(r => r.runId !== record.runId)] : [record];
  const origins = [...new Set(started.map(r => r.origin ?? 'unknown'))];
  const notCommand = started.some(r => r.origin !== 'command');
  if (notCommand && !env.hasUI && !flags.trustOrigin)
    return fail(
      `${origins.length > 1 ? 'a member of this fan-out was' : 'this run was'} not started by a /delegate command typed by a person — the record says: ${started
        .filter(r => r.origin !== 'command')
        .map(r => describeOrigin(r.origin))
        .filter((v, i, a) => a.indexOf(v) === i)
        .join(
          '; ',
        )} (as recorded, unverified). With no interactive session to show you the plan, pass --trust-origin on the rerun line to repeat it anyway`,
    );

  // Today's template, per harness. The tier is compared with what the recorded run had — a mode that
  // has since been widened (readonly -> edit, edit -> danger) is never silently re-run at the wider tier.
  const recordedTier = (h: string): NormalizedPermission =>
    (h === record.harness ? record : siblings.find(r => r.harness === h))?.permission ?? record.permission;
  const targets = harnessNames.filter(h => h !== 'all');
  const tiers: string[] = [];
  const ceiling: Record<string, TierCeiling> = {};
  // typing the SAME value the record already has (once normalized) is not a choice — it skips nothing. Judged PER
  // HARNESS: a typed list (`--harness=claude,codex`) skips the tier check only for a harness that was never a
  // recorded member of this run / fan-out (a different harness is the human's choice); a member that WAS recorded
  // keeps the check, exactly as a bare `rerun --fanout` does. A typed mode that differs from the record's is a
  // choice for every harness.
  const recordedMembers = new Set([record, ...env.siblings].map(r => r.harness));
  const typedMode = overrides.mode !== undefined && overrides.mode !== record.mode;
  const typedChoice = (h: string): boolean => typedMode || (typedHarness !== undefined && !recordedMembers.has(h));
  for (const h of targets) {
    const now = env.modeTier(h, mode);
    if (now === null) {
      if (!fanoutSpec)
        return fail(
          `mode ${quoteValue(mode, 80)} is not available for ${h} now — it may have been removed, or be a project-local template in a project pi does not trust (/delegate status shows trust)`,
        );
      ceiling[h] = 'unavailable';
      continue;
    }
    ceiling[h] = now;
    const was = recordedTier(h);
    tiers.push(`${h}: ${now}${now === was ? '' : ` (recorded run: ${was})`}`);
    if (!typedChoice(h) && TIER_RANK[now] > TIER_RANK[was])
      return fail(
        `mode ${quoteValue(mode, 80)} on ${h} now runs at ${now} permission, but the recorded run used ${was} — the template has been widened since, so it is not re-run as a repeat. Start it with the normal command (/delegate ${h} ${displayText(mode, 40)} <prompt>) if you want the wider tier`,
      );
  }

  const task = input.task;
  const scope = overrides.scope ?? input.scope ?? undefined;
  const storedScope = overrides.scope === undefined && input.scope !== null;
  const pr = overrides.pr ?? input.pr ?? undefined;
  const storedAddDirs = overrides.addDirs === undefined && input.addDirs.length > 0 ? input.addDirs : [];
  const addDirs = overrides.addDirs ?? (input.addDirs.length > 0 ? input.addDirs : undefined);
  const model = overrides.model ?? input.model ?? undefined;
  const storedBudget = overrides.budget === undefined && input.budgetUsd !== null;
  const storedTimeout = overrides.timeoutSec === undefined && input.timeoutSec !== null;
  const budget = overrides.budget ?? input.budgetUsd ?? undefined;
  const timeoutSec = overrides.timeoutSec ?? input.timeoutSec ?? undefined;
  let sessionId = overrides.sessionId;
  if (flags.resumeOwn) {
    if (overrides.sessionId !== undefined)
      return fail('give either a bare --resume (the recorded session) or --resume=<id>, not both');
    if (!record.sessionId) return fail('--resume: this run has no recorded session id to resume');
    sessionId = record.sessionId;
  }

  // Stored values are untrusted: the same gates a typed command goes through, applied up front so a
  // bad record is a clear error rather than a failure deep in a run (delegate() re-validates too). The
  // exact text is what runs; anything refused here is a character that acts on a terminal or spoofs what
  // is displayed — everything else (ZWJ emoji, variation selectors, …) passes and is ESCAPED on display.
  if (!task.trim()) return fail('the stored task is empty');
  for (const [label, v, ws] of [
    ['task', task, true],
    ['scope', scope, true],
    ['model', model, false],
    ['pr', pr, false],
    ['sessionId', sessionId, false],
  ] as const) {
    const bad = v === undefined ? null : forbiddenCharacter(v, ws);
    if (bad !== null)
      return fail(
        `the stored ${label} contains a control or direction-changing character (${bad}) — refusing to rerun it`,
      );
  }
  for (const d of addDirs ?? []) {
    const bad = forbiddenCharacter(d, false);
    if (bad !== null)
      return fail(
        `a stored addDirs entry contains a control or direction-changing character (${bad}) — refusing to rerun it`,
      );
  }
  // A value a confirmation cannot show whole (too many characters OR too many lines — a dialog taller than
  // the screen scrolls its top away) is not run on the strength of a partial view.
  if (!flags.longTask) {
    const taskWhy = textTooLongReason(task, TASK_LIMITS, env.viewport);
    if (taskWhy)
      return fail(
        `the stored task is ${taskWhy}. Pass --long-task to repeat it anyway (the confirmation then shows only its head and tail, and says how many lines and characters were not shown)`,
      );
    const scopeWhy = storedScope && scope !== undefined ? textTooLongReason(scope, SCOPE_LIMITS, env.viewport) : null;
    if (scopeWhy)
      return fail(
        `the stored scope is ${scopeWhy}. Pass --long-task to repeat it anyway (the confirmation then shows only its head and tail, and says how many lines and characters were not shown)`,
      );
  }
  if (budget !== undefined && !(typeof budget === 'number' && Number.isFinite(budget) && budget > 0))
    return fail('the stored budget is not a positive number');
  if (timeoutSec !== undefined) {
    const te = callTimeoutError(timeoutSec);
    if (te) return fail(`stored ${te}`);
  }
  try {
    validateDelegateInputs({ sessionId, model, pr, addDirs, cwd: env.cwd });
  } catch (err) {
    return fail(
      `the stored record has an unusable value: ${err instanceof Error ? displayText(err.message, 300) : 'invalid'}`,
    );
  }

  if (record.permission === 'danger' && !overrides.allowDangerous)
    notices.push(
      'the original run used danger permission — that is never replayed: pass --allow-dangerous to repeat it (you will be asked to confirm)',
    );
  if (input.hadVerify && overrides.verify === undefined)
    notices.push(
      "the original run had a verify command — it is not replayed: pass --verify=<cmd> to run one (a template's own verify: still applies)",
    );
  if (record.fanoutId && !flags.fanout)
    notices.push(
      `this run was one member of fan-out ${record.fanoutId} — rerunning just it (--fanout reruns every member)`,
    );
  if (flags.fanout && otherDir.length > 0)
    notices.push(
      `fan-out members recorded in another working directory, not rerun: ${otherDir
        .slice(0, 8)
        .map(r => `${quoteValue(r.harness, 40)} (in ${quoteValue(r.cwd, 100)})`)
        .join(', ')}${otherDir.length > 8 ? `, … (${otherDir.length - 8} more)` : ''}`,
    );
  if (sessionId === undefined && record.sessionId)
    notices.push('starting a fresh session (pass --resume to continue the recorded one)');

  // The stored values are untrusted: the same size limits a model-set run is held to (a confirmation shows each
  // value whole), so a hand-edited record cannot bury what matters under a wall of directories.
  const storedFields = fieldRefusal({
    model: overrides.model === undefined ? model : undefined,
    pr: overrides.pr === undefined ? pr : undefined,
    sessionId: flags.resumeOwn ? sessionId : undefined,
    addDirs: storedAddDirs.length > 0 ? storedAddDirs : undefined,
  });
  if (storedFields) return fail(`the stored record is too big to confirm: ${storedFields}`);

  // The plan, laid out for the real terminal (confirm-layout.ts): the task / scope blocks FIRST, then the critical
  // section — what will run, who started it, the warning, today's tier and every setting — and the size summaries
  // LAST. A task / scope that does not fit is refused unless the human typed --long-task (then head + tail).
  const headline = [
    `Re-run ${record.runId}`,
    // every name was checked against the known harnesses (or is `all`) above, so it is plain text
    `harness: ${harnessNames.join(', ')}`,
    `mode: ${quoteFull(mode)} — today's template of that name, not a stored copy`,
    `permission tier now: ${tiers.length > 0 ? tiers.join('; ') : 'resolved per harness at run time'}`,
    `originally started by: ${started.length > 1 ? origins.map(o => describeOrigin(o === 'unknown' ? null : (o as 'tool' | 'command'))).join('; ') : describeOrigin(record.origin)} (as recorded in the sidecar, unverified)`,
  ];
  if (notCommand)
    headline.push(
      'WARNING: this was NOT typed by you as a /delegate command — the record says it was started by something else (or does not say). Check the task above before approving.',
    );
  if (sessionId === undefined) headline.push('session: fresh');
  headline.push(`directory: ${quoteFull(env.cwd)}`);
  const effectiveHarnesses = targets.filter(h => ceiling[h] !== 'unavailable');
  const laid = buildConfirmation({
    headline,
    steering: {
      task,
      scope,
      model,
      sessionId,
      pr,
      budgetUsd: budget,
      timeoutSec,
      addDirs,
      verify: overrides.verify,
      typed: { scope: overrides.scope !== undefined },
      effective: env.effective?.(effectiveHarnesses, mode, {
        model,
        budgetUsd: budget,
        budgetNarrowOnly: storedBudget,
        timeoutSec,
        timeoutMayRaise: !storedTimeout,
        verify: overrides.verify,
      }),
      notes: {
        budgetUsd: storedBudget ? ' (stored; can only lower a configured budget)' : undefined,
        timeoutSec: storedTimeout ? ' (stored; can only lower the configured timeout)' : undefined,
        addDirs: storedAddDirs.length > 0 ? ' (from the record)' : undefined,
      },
    },
    taskLabel: 'task',
    onOverflow: flags.longTask ? 'headtail' : 'refuse',
    viewport: env.viewport,
  });
  if (!laid.ok)
    return fail(
      laid.kind === 'blocks'
        ? `${laid.reason.replace(/ — too long for a person to review in the confirmation, so it is refused\. Shorten it$/, '')}. Pass --long-task to repeat it anyway (the confirmation then shows only its head and tail, and says how many rows, lines and characters were not shown)`
        : laid.reason,
    );
  summary.push(...laid.lines);

  const args: DelegateCommandArgs = { task, harness: harnessSpec, mode };
  if (scope !== undefined) args.scope = scope;
  if (pr !== undefined) args.pr = pr;
  if (addDirs !== undefined) args.addDirs = addDirs;
  if (model !== undefined) args.model = model;
  if (budget !== undefined) args.budget = budget;
  if (timeoutSec !== undefined) args.timeoutSec = timeoutSec;
  if (storedBudget) args.storedBudget = true;
  if (storedTimeout) args.storedTimeout = true;
  if (sessionId !== undefined) args.sessionId = sessionId;
  if (overrides.verify !== undefined) args.verify = overrides.verify;
  if (overrides.allowDangerous) args.allowDangerous = true;
  // the tier(s) shown above are the most the run may resolve to — see DelegateOptions.tierCeiling
  if (targets.length > 0) args.tierCeiling = ceiling;
  return { errors, notices, args, summary, storedAddDirs };
}
