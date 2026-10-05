/**
 * Resume a whole fan-out by its fan-out id (`fan_<16 hex>`, shown in a fan-out report and stored in
 * every member's run record): each member continues ITS OWN recorded session on ITS OWN harness.
 *
 * Why this is safe to offer (it adds no capability a typed command or the tool didn't already have):
 * it can only continue sessions the user's own run records name — a session id is never taken from
 * the caller — and it hands the planned harness list to the *same* fan-out path as `/delegate all`
 * (detection filtering, `acquireSlot` queueing, the danger / addDirs confirms), so resuming never
 * grants more than a fresh run would. Records are untrusted stored data: each recorded session id is
 * re-validated with the same gate as a typed `--resume=`. A fan-out id is told apart from a plain
 * session id by its exact format *and* by lookup against the records — a well-formed id that matches
 * no record is an error, never silently treated as a session id.
 */

import { resolve } from 'node:path';
import type { RunRecord } from './run-record.ts';
import { displayText } from './run-record.ts';
import { sessionIdError } from './validate.ts';

export type FanoutResumePlan =
  | {
      ok: true;
      /** Harnesses to resume — only members with a usable recorded session id, in recorded order. */
      harnesses: string[];
      /** harness -> its own recorded session id. */
      sessions: Record<string, string>;
      /** Members of the fan-out with no recorded session id (reported, never silently dropped). */
      noSession: string[];
      /** The mode the fan-out ran (the default for the resume). */
      mode: string;
    }
  | { ok: false; error: string };

/**
 * Plan a fan-out resume from `records` (everything on disk). Pure. Only members recorded in `cwd`
 * count — a session belongs to the directory it ran in.
 */
export function planFanoutResume(fanoutId: string, records: readonly RunRecord[], cwd: string): FanoutResumePlan {
  const all = records.filter(r => r.fanoutId === fanoutId);
  if (all.length === 0) return { ok: false, error: `unknown fan-out id ${fanoutId} — no run record belongs to it` };
  const members = all.filter(r => resolve(r.cwd) === resolve(cwd));
  if (members.length === 0)
    return {
      ok: false,
      error: `fan-out ${fanoutId} ran in ${displayText(all[0].cwd, 120)}, not the current directory (${displayText(cwd, 120)}) — cd there to resume it`,
    };
  // one entry per harness: the most recent record of it
  const latest = new Map<string, RunRecord>();
  for (const r of [...members].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt)))
    latest.set(r.harness, r);
  const harnesses: string[] = [];
  const sessions: Record<string, string> = {};
  const noSession: string[] = [];
  for (const [harness, r] of latest) {
    if (r.sessionId === null || r.sessionId === '') {
      noSession.push(harness);
      continue;
    }
    const bad = sessionIdError(r.sessionId);
    if (bad)
      return {
        ok: false,
        error: `the recorded session id for ${displayText(harness, 24)} in fan-out ${fanoutId} is unusable (${displayText(bad, 160)}) — refusing to resume it`,
      };
    harnesses.push(harness);
    sessions[harness] = r.sessionId;
  }
  if (harnesses.length === 0)
    return {
      ok: false,
      error: `no member of fan-out ${fanoutId} recorded a session id, so there is nothing to resume`,
    };
  const mode = [...latest.values()][0].mode;
  return { ok: true, harnesses, sessions, noSession, mode };
}
