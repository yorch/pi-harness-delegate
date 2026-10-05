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
import type { HistoryEntry } from './history-filter.ts';
import { displayText, isRunId, type RunRecord, readRecordsIn, readRunRecord, recordPathFor } from './run-record.ts';
import { callTimeoutError } from './templates.ts';
import { validateDelegateInputs } from './validate.ts';

// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const BAD_TEXT_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** Every record on disk (all harness partitions + the legacy dir), newest first. Never throws. */
export function readAllRecords(): RunRecord[] {
  const out: RunRecord[] = [];
  for (const dir of [...HARNESS_NAMES.map(h => outputsDir(h)), legacyOutputsDir()])
    out.push(...readRecordsIn(dir).records);
  return out.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
}

export type RecordSelection = { ok: true; record: RunRecord } | { ok: false; error: string };

/**
 * Pick the record to rerun. `selector` is `undefined` (the most recent), a 1-based position in
 * `view` (the history listing the user last saw, or the unfiltered history), or a run id.
 */
export function selectRecord(selector: string | undefined, view: readonly HistoryEntry[]): RecordSelection {
  if (selector !== undefined && isRunId(selector)) {
    const rec = readAllRecords().find(r => r.runId === selector);
    return rec ? { ok: true, record: rec } : { ok: false, error: `no run record with id ${selector}` };
  }
  if (selector === undefined) {
    // no selector: the most recent *completed* run that has a record (a partial run is rerunnable only by id)
    const rec = readAllRecords().find(r => !r.partial);
    return rec ? { ok: true, record: rec } : { ok: false, error: 'no run records yet — nothing to rerun' };
  }
  if (!/^\d{1,4}$/.test(selector) || Number(selector) < 1)
    return {
      ok: false,
      error: `expected a position (1, 2, …) or a run id (run_…), got ${JSON.stringify(displayText(selector, 40))}`,
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
      error: `run #${n} (${displayText(entry.mode, 64)}) predates run records, so it cannot be rerun`,
    };
  const parsed = readRunRecord(recordPathFor(entry.file));
  return parsed.ok
    ? { ok: true, record: parsed.record }
    : { ok: false, error: `run #${n}'s record is unusable (${parsed.reason})` };
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
  /** Does `mode` resolve for `harness` right now (same trust gating as a real run)? */
  modeAvailable: (harness: string, mode: string) => boolean;
  /** Records sharing the selected one's fan-out id (when it has one). */
  siblings: readonly RunRecord[];
}

export interface RerunPlan {
  errors: string[];
  notices: string[];
  args?: DelegateCommandArgs;
}

/**
 * Turn a record + the human's command-line overrides into the `DelegateCommandArgs` of an ordinary
 * `/delegate` invocation. `overrides` is the parsed rest of the rerun command line (`--harness=`,
 * `--model=`, …); anything it sets wins over the record. Pure aside from the env callbacks.
 */
export function planRerun(
  record: RunRecord,
  overrides: DelegateCommandArgs,
  flags: RerunFlags,
  env: RerunEnv,
): RerunPlan {
  const errors: string[] = [];
  const notices: string[] = [];
  const fail = (msg: string): RerunPlan => ({ errors: [...errors, msg], notices });
  const input = record.input;

  if (overrides.errors?.length) return { errors: overrides.errors, notices };
  if (overrides.task) return fail('rerun takes no new prompt — use /delegate <prompt> to start a different run');

  if (input.taskTruncated)
    return fail('the stored task was truncated when the run was recorded, so it cannot be rerun faithfully');
  if (resolve(record.cwd) !== resolve(env.cwd)) {
    if (!flags.here)
      return fail(
        `this run was in ${displayText(record.cwd, 120)} but the current directory is ${displayText(env.cwd, 120)} — cd there, or pass --here to run it in the current directory`,
      );
    notices.push(
      `running in the current directory (${displayText(env.cwd, 120)}), not the original ${displayText(record.cwd, 120)}`,
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
    if (h !== 'all' && !env.isKnownHarness(h)) return fail(`unknown harness ${JSON.stringify(displayText(h, 40))}`);
  const mode = overrides.mode ?? record.mode;
  if (!fanoutSpec && harnessNames.length === 1 && !env.modeAvailable(harnessNames[0], mode))
    return fail(
      `mode ${JSON.stringify(displayText(mode, 64))} is not available for ${harnessNames[0]} now — it may have been removed, or be a project-local template in a project pi does not trust (/delegate status shows trust)`,
    );

  const task = input.task;
  const scope = overrides.scope ?? input.scope ?? undefined;
  const pr = overrides.pr ?? input.pr ?? undefined;
  const addDirs = overrides.addDirs ?? (input.addDirs.length > 0 ? input.addDirs : undefined);
  const model = overrides.model ?? input.model ?? undefined;
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
  if (BAD_TEXT_RE.test(task) || (scope !== undefined && BAD_TEXT_RE.test(scope)))
    return fail('the stored task/scope contains control characters — refusing to rerun it');
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

  const args: DelegateCommandArgs = { task, harness: harnessSpec, mode };
  if (scope !== undefined) args.scope = scope;
  if (pr !== undefined) args.pr = pr;
  if (addDirs !== undefined) args.addDirs = addDirs;
  if (model !== undefined) args.model = model;
  if (budget !== undefined) args.budget = budget;
  if (timeoutSec !== undefined) args.timeoutSec = timeoutSec;
  if (sessionId !== undefined) args.sessionId = sessionId;
  if (overrides.verify !== undefined) args.verify = overrides.verify;
  if (overrides.allowDangerous) args.allowDangerous = true;
  return { errors, notices, args };
}
