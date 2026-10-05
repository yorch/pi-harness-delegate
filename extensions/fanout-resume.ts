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
import { ALIASES, HARNESS_NAMES } from './harnesses/registry.ts';
import type { RunRecord, SkippedRecord } from './run-record.ts';
import { displayText } from './run-record.ts';
import { quoteValue } from './templates.ts';
import { safeName, sessionIdError } from './validate.ts';

export type FanoutResumePlan =
  | {
      ok: true;
      /** Harnesses to resume — only members with a usable recorded session id, in registry order. */
      harnesses: string[];
      /** harness -> its own recorded session id. Keys are exactly the canonical names in `harnesses`. */
      sessions: Record<string, string>;
      /** Members of the fan-out with no recorded session id (reported, never silently dropped). */
      noSession: string[];
      /** Members whose run record exists but could not be read (reported, never silently dropped). */
      unreadable: string[];
      /** The mode the fan-out ran (the default for the resume). */
      mode: string;
    }
  | { ok: false; error: string };

/** A harness name as the engine knows it (`Claude` / `omp` are NOT silently the same as `claude` /
 *  `amp` for a session lookup unless they map to one canonical name), or `null` when it isn't one. */
function canonicalHarness(name: string): string | null {
  const lower = name.trim().toLowerCase();
  const canon = (ALIASES as Record<string, string>)[lower] ?? lower;
  return (HARNESS_NAMES as readonly string[]).includes(canon) ? canon : null;
}

/**
 * Plan a fan-out resume from `records` — everything usable on disk, **newest first** (the order
 * `readAllRecords` returns, by transcript mtime; a record's own `startedAt` is never trusted for
 * ordering). `unreadable` are the sidecars that could not be used; those naming this fan-out are
 * listed in the plan rather than vanishing. Pure. Only members recorded in `cwd` count — a session
 * belongs to the directory it ran in. Harness names are canonicalized, so the `sessions` map is always
 * keyed by the very names the fan-out path launches.
 */
export function planFanoutResume(
  fanoutId: string,
  records: readonly RunRecord[],
  cwd: string,
  unreadable: readonly SkippedRecord[] = [],
): FanoutResumePlan {
  const lost = [
    ...new Set(
      unreadable
        .filter(u => u.fanoutId === fanoutId)
        .map(u => (u.harness ? (canonicalHarness(u.harness) ?? u.harness) : 'unknown harness')),
    ),
  ];
  const all = records.filter(r => r.fanoutId === fanoutId);
  if (all.length === 0)
    return {
      ok: false,
      error:
        lost.length > 0
          ? `fan-out ${fanoutId} has no usable run record — unreadable record(s) for: ${lost.map(safeName).join(', ')}`
          : `unknown fan-out id ${fanoutId} — no run record belongs to it`,
    };
  const members = all.filter(r => resolve(r.cwd) === resolve(cwd));
  if (members.length === 0)
    return {
      ok: false,
      error: `fan-out ${fanoutId} ran in ${quoteValue(all[0].cwd, 160)}, not the current directory (${quoteValue(cwd, 160)}) — cd there to resume it`,
    };
  // one entry per canonical harness: the NEWEST record of it (input is newest first)
  const latest = new Map<string, RunRecord>();
  for (const r of members) {
    const h = canonicalHarness(r.harness);
    if (h === null)
      return {
        ok: false,
        error: `fan-out ${fanoutId} has a record naming harness ${quoteValue(r.harness, 60)}, which is not a known harness — refusing to resume it`,
      };
    if (!latest.has(h)) latest.set(h, r);
  }
  // a deterministic order (the registry's), not the order the members happened to finish in
  const ordered = [...latest].sort(
    ([a], [b]) => (HARNESS_NAMES as readonly string[]).indexOf(a) - (HARNESS_NAMES as readonly string[]).indexOf(b),
  );
  const harnesses: string[] = [];
  const sessions: Record<string, string> = {};
  const noSession: string[] = [];
  for (const [harness, r] of ordered) {
    if (r.sessionId === null || r.sessionId === '') {
      noSession.push(harness);
      continue;
    }
    const bad = sessionIdError(r.sessionId);
    if (bad)
      return {
        ok: false,
        error: `the recorded session id for ${harness} in fan-out ${fanoutId} is unusable (${displayText(bad, 160)}) — refusing to resume it`,
      };
    harnesses.push(harness);
    sessions[harness] = r.sessionId;
  }
  if (harnesses.length === 0)
    return {
      ok: false,
      error: `no member of fan-out ${fanoutId} recorded a session id, so there is nothing to resume`,
    };
  // every launched harness has its own session — a missing mapping must never mean "start fresh"
  for (const h of harnesses)
    if (!Object.hasOwn(sessions, h))
      return { ok: false, error: `internal: no recorded session for ${h} — refusing to start a fresh one` };
  const first = latest.values().next().value as RunRecord;
  return { ok: true, harnesses, sessions, noSession, unreadable: lost, mode: first.mode };
}
