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
import { HARNESS_NAMES } from './harnesses/registry.ts';
import type { NormalizedPermission } from './harnesses/types.ts';
import type { HistoryEntry } from './history-filter.ts';
import {
  displayText,
  isRunId,
  type LocatedRecord,
  loadRecordForTranscript,
  newestFirst,
  type RunRecord,
  readRecordsIn,
  type SkippedRecord,
} from './run-record.ts';
import { INVISIBLE_OR_CONTROL_RE } from './sanitize.ts';
import { callTimeoutError, quoteValue } from './templates.ts';
import { validateDelegateInputs } from './validate.ts';

// One non-global copy of the shared invisible/control set (the exported one carries the `g` flag, whose
// `lastIndex` makes `.test` stateful). Covers C0/C1 controls (incl. `\r`), bidi, zero-width, tag characters.
const NON_PRINTABLE_RE = new RegExp(INVISIBLE_OR_CONTROL_RE.source, 'u');

/** True when `text` holds a control / invisible / bidi character. Free text (task, scope) may keep newlines and tabs. */
export function hasUnsafeChars(text: string, allowNewlines: boolean): boolean {
  return NON_PRINTABLE_RE.test(allowNewlines ? text.replace(/[\n\t]/g, '') : text);
}

/**
 * Every usable record on disk — all harness partitions plus the legacy dir — newest transcript first
 * (the very ordering `/delegate history` lists, `newestFirst`). Only records with a sibling transcript
 * in their own harness's directory count (`readRecordsIn`); unusable ones come back in `skipped`.
 * Never throws.
 */
export function readAllRecordsDetailed(): { records: LocatedRecord[]; skipped: SkippedRecord[] } {
  const records: LocatedRecord[] = [];
  const skipped: SkippedRecord[] = [];
  const dirs: [string, string][] = [...HARNESS_NAMES.map(h => [outputsDir(h), h] as [string, string])];
  dirs.push([legacyOutputsDir(), 'claude']);
  for (const [dir, harness] of dirs) {
    const r = readRecordsIn(dir, harness);
    records.push(...r.records);
    skipped.push(...r.skipped);
  }
  records.sort((a, b) =>
    newestFirst({ mtimeMs: a.mtimeMs, name: a.transcript }, { mtimeMs: b.mtimeMs, name: b.transcript }),
  );
  return { records, skipped };
}

/** Every usable record (see `readAllRecordsDetailed`), newest transcript first. */
export function readAllRecords(): RunRecord[] {
  return readAllRecordsDetailed().records.map(l => l.record);
}

export type RecordSelection = { ok: true; record: RunRecord } | { ok: false; error: string };

/** " (N record file(s) were ignored: <reason>)" for an error message, or '' when none were. */
function ignoredNote(skipped: readonly SkippedRecord[]): string {
  if (skipped.length === 0) return '';
  return ` (${skipped.length} record file(s) were ignored as unusable, e.g. ${quoteValue(displayText(skipped[0].reason, 100), 140)})`;
}

/**
 * Pick the record to rerun. `selector` is `undefined` (the newest completed run with a record — by
 * transcript mtime, the order history lists), a 1-based position in `view` (the history listing the user
 * last saw, or the unfiltered history), or a run id.
 */
export function selectRecord(selector: string | undefined, view: readonly HistoryEntry[]): RecordSelection {
  if (selector !== undefined && isRunId(selector)) {
    const { records, skipped } = readAllRecordsDetailed();
    const hits = records.filter(r => r.record.runId === selector);
    if (hits.length > 1)
      return { ok: false, error: `run id ${selector} is ambiguous — ${hits.length} records claim it` };
    return hits[0]
      ? { ok: true, record: hits[0].record }
      : { ok: false, error: `no run record with id ${selector}${ignoredNote(skipped)}` };
  }
  if (selector === undefined) {
    // no selector: the newest *completed* run that has a record (a partial run is rerunnable only by id)
    const { records, skipped } = readAllRecordsDetailed();
    const rec = records.find(r => !r.record.partial);
    return rec
      ? { ok: true, record: rec.record }
      : { ok: false, error: `no run records yet — nothing to rerun${ignoredNote(skipped)}` };
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
}

export interface RerunEnv {
  cwd: string;
  isKnownHarness: (name: string) => boolean;
  /**
   * The tier `mode` would run at on `harness` TODAY (the engine's own classification —
   * `effectiveTemplateTier`), or `null` when it does not resolve now (removed, or a project-local
   * template in a project pi does not trust).
   */
  modeTier: (harness: string, mode: string) => NormalizedPermission | null;
  /** Records sharing the selected one's fan-out id (when it has one), newest first. */
  siblings: readonly RunRecord[];
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

const TIER_RANK: Record<NormalizedPermission, number> = { readonly: 0, edit: 1, danger: 2 };

/**
 * Turn a record + the human's command-line overrides into the `DelegateCommandArgs` of an ordinary
 * `/delegate` invocation. `overrides` is the parsed rest of the rerun command line (`--harness=`,
 * `--model=`, …); anything it sets wins over the record. Pure aside from the env callbacks.
 *
 * A rerun uses TODAY's template for the mode, never a stored copy: if that template's tier is WIDER
 * than the recorded run's, it is refused (the human can start the run with the normal command).
 * Stored values are untrusted: a stored `timeoutSec`/budget may only narrow what is configured
 * (`storedTimeout`/`storedBudget`), stored `addDirs` are returned in `storedAddDirs` for the caller to
 * gate like model-set ones; only values typed on the rerun line carry human trust.
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

  const harness = overrides.harness ?? record.harness;
  const fanoutSpec = flags.fanout || (overrides.harness?.includes(',') ?? false) || overrides.harness === 'all';
  let harnessSpec = harness;
  if (flags.fanout) {
    if (!record.fanoutId) return fail('--fanout: this run was not part of a fan-out');
    if (overrides.harness === undefined) {
      const members = [...new Set([record, ...env.siblings].map(r => r.harness))];
      harnessSpec = members.join(',');
    }
  }
  const harnessNames = harnessSpec.split(',').filter(Boolean);
  for (const h of harnessNames)
    if (h !== 'all' && !env.isKnownHarness(h)) return fail(`unknown harness ${quoteValue(h, 80)}`);
  const mode = overrides.mode ?? record.mode;

  // Today's template, per harness. The tier is compared with what the recorded run had — a mode that
  // has since been widened (readonly -> edit, edit -> danger) is never silently re-run at the wider tier.
  const recordedTier = (h: string): NormalizedPermission =>
    (h === record.harness ? record : env.siblings.find(r => r.harness === h))?.permission ?? record.permission;
  const targets = harnessNames.filter(h => h !== 'all');
  const tiers: string[] = [];
  const typedTarget = overrides.mode !== undefined || overrides.harness !== undefined;
  for (const h of targets) {
    const now = env.modeTier(h, mode);
    if (now === null) {
      if (!fanoutSpec)
        return fail(
          `mode ${quoteValue(mode, 80)} is not available for ${h} now — it may have been removed, or be a project-local template in a project pi does not trust (/delegate status shows trust)`,
        );
      continue;
    }
    const was = recordedTier(h);
    tiers.push(`${h}: ${now}${now === was ? '' : ` (recorded run: ${was})`}`);
    if (!typedTarget && TIER_RANK[now] > TIER_RANK[was])
      return fail(
        `mode ${quoteValue(mode, 80)} on ${h} now runs at ${now} permission, but the recorded run used ${was} — the template has been widened since, so it is not re-run as a repeat. Start it with the normal command (/delegate ${h} ${displayText(mode, 40)} <prompt>) if you want the wider tier`,
      );
  }

  const task = input.task;
  const scope = overrides.scope ?? input.scope ?? undefined;
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
  // bad record is a clear error rather than a failure deep in a run (delegate() re-validates too).
  if (!task.trim()) return fail('the stored task is empty');
  if (hasUnsafeChars(task, true) || (scope !== undefined && hasUnsafeChars(scope, true)))
    return fail('the stored task/scope contains control or invisible characters — refusing to rerun it');
  for (const [label, v] of [
    ['model', model],
    ['pr', pr],
    ['sessionId', sessionId],
  ] as const)
    if (v !== undefined && hasUnsafeChars(v, false))
      return fail(`the stored ${label} contains control or invisible characters — refusing to rerun it`);
  if (addDirs?.some(d => hasUnsafeChars(d, false)))
    return fail('a stored addDirs entry contains control or invisible characters — refusing to rerun it');
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
  if (sessionId === undefined && record.sessionId)
    notices.push('starting a fresh session (pass --resume to continue the recorded one)');

  summary.push(
    `Re-run ${record.runId}`,
    // every name was checked against the known harnesses (or is `all`) above, so it is plain text
    `harness: ${harnessNames.join(', ')}`,
    `mode: ${quoteValue(mode, 80)} — today's template of that name, not a stored copy`,
    `permission tier now: ${tiers.length > 0 ? tiers.join('; ') : 'resolved per harness at run time'}`,
    `task: ${quoteValue(displayText(task, 300), 320)}`,
  );
  if (scope !== undefined) summary.push(`scope: ${quoteValue(displayText(scope, 200), 220)}`);
  if (pr !== undefined) summary.push(`pr: ${quoteValue(pr, 120)}`);
  if (addDirs !== undefined)
    summary.push(
      `addDirs: ${addDirs.map(d => quoteValue(d, 200)).join(', ')}${storedAddDirs.length > 0 ? ' (from the record)' : ''}`,
    );
  if (model !== undefined) summary.push(`model: ${quoteValue(model, 120)}`);
  if (budget !== undefined)
    summary.push(`budget: $${budget}${storedBudget ? ' (stored; can only lower a configured budget)' : ''}`);
  if (timeoutSec !== undefined)
    summary.push(`timeout: ${timeoutSec}s${storedTimeout ? ' (stored; can only lower the configured timeout)' : ''}`);
  summary.push(sessionId === undefined ? 'session: fresh' : `session: resumes ${quoteValue(sessionId, 140)}`);
  summary.push(`directory: ${quoteValue(env.cwd, 200)}`);

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
  return { errors, notices, args, summary, storedAddDirs };
}
