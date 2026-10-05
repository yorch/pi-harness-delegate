/**
 * Resume a whole fan-out by its fan-out id (`fan_<16 hex>`, shown in a fan-out report and stored in
 * every member's run record): each member continues ITS OWN recorded session on ITS OWN harness.
 *
 * What this does and does not add. It can only continue sessions the user's own run records name — a
 * session id is never taken from the caller — and it hands the planned harness list to the *same*
 * fan-out path as `/delegate all` (detection filtering, `acquireSlot` queueing, the danger / addDirs
 * confirms). It is NOT "no more than a fresh run": the follow-up prompt runs in a session that already
 * holds context and tool history, on every member, at the tier its mode has today. So, like a rerun:
 *
 * - records are untrusted stored data: ALL members sharing the fan-out id must agree on the mode and on
 *   the recorded permission tier (one forged member must not decide them for the rest), and two records
 *   of one harness naming different sessions are refused as ambiguous;
 * - today's tier of the mode, per member, must not be WIDER than that member's recorded tier (unless a
 *   human typed a different `--mode=`);
 * - a UI session is always shown the plan (`formatFanoutResumePlan`) and asked to confirm — the command
 *   path and the tool path alike; the tool path additionally REQUIRES a UI (index.ts);
 * - the tier shown is handed to every member's run as a ceiling (`tierCeiling`), so a template swapped
 *   after the confirmation cannot run wider.
 *
 * A fan-out id is told apart from a plain session id by its exact format *and* by lookup against the
 * records — a well-formed id that matches no record is an error, never silently treated as a session id.
 */

import { resolve } from 'node:path';
import { ALIASES, HARNESS_NAMES } from './harnesses/registry.ts';
import { type NormalizedPermission, TIER_RANK, type TierCeiling } from './harnesses/types.ts';
import type { RunRecord, SkippedRecord } from './run-record.ts';
import { displayText } from './run-record.ts';
import { quoteFull, quoteValue } from './templates.ts';
import { type RunSteering, safeName, sessionIdError, steeringFieldLines, steeringTextBlocks } from './validate.ts';

export type FanoutResumePlan =
  | {
      ok: true;
      /** Harnesses to resume — only members with a usable recorded session id, in registry order. */
      harnesses: string[];
      /** harness -> its own recorded session id. Keys are exactly the canonical names in `harnesses`. */
      sessions: Record<string, string>;
      /** Members of the fan-out with no recorded session id (reported, never silently dropped). */
      noSession: string[];
      /** Members of the fan-out recorded in another working directory — reported, never silently excluded. */
      otherCwd: string[];
      /** Members whose run record exists but could not be read (reported, never silently dropped). */
      unreadable: string[];
      /** The mode the resume runs: the fan-out's recorded one unless `opts.mode` named another. */
      mode: string;
      /** Every member launched, with what the human is shown for it. */
      members: ResumeMember[];
      /** Per launched harness, the template tier shown in the plan — the run may not exceed it. */
      tierCeiling: Record<string, TierCeiling>;
    }
  | { ok: false; error: string };

/** One member of a resume plan, as shown to the human. */
export interface ResumeMember {
  harness: string;
  sessionId: string;
  runId: string;
  origin: RunRecord['origin'];
  /** The tier its own record says it ran at. */
  recordedTier: NormalizedPermission;
  /** The tier `mode` would run at on this harness today (`null` = it does not resolve now). */
  nowTier: NormalizedPermission | null;
}

export interface FanoutResumeEnv {
  /** The tier `mode` would run at on `harness` today (the engine's own classification), `null` when it does not resolve. */
  modeTier: (harness: string, mode: string) => NormalizedPermission | null;
  /** A mode named by the caller instead of the recorded one. */
  mode?: string;
  /** `mode` was typed by a person on the command line (it is then their choice, so the widened-tier
   *  comparison is skipped). A model-set mode (the tool's `mode` param) is NOT — it is compared like the recorded one. */
  modeTypedByHuman?: boolean;
}

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
  env: FanoutResumeEnv,
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
  const otherCwd = all
    .filter(r => resolve(r.cwd) !== resolve(cwd))
    .map(r => `${safeName(canonicalHarness(r.harness) ?? r.harness)} (in ${quoteValue(r.cwd, 100)})`);
  if (members.length === 0)
    return {
      ok: false,
      error: `fan-out ${fanoutId} ran in ${quoteValue(all[0].cwd, 160)}, not the current directory (${quoteValue(cwd, 160)}) — cd there to resume it`,
    };
  // Every member must agree on the mode and the recorded tier: a single forged (or odd) record must not
  // decide them for the others.
  const distinct = [...new Map(members.map(r => [`${r.mode}\u0000${r.permission}`, r])).values()];
  if (distinct.length > 1)
    return {
      ok: false,
      error: `the records of fan-out ${fanoutId} disagree on the mode / permission tier, so it is not resumed: ${members
        .slice(0, 8)
        .map(r => `${safeName(r.harness)} → mode ${quoteFull(r.mode)}, ${r.permission}`)
        .join('; ')}${members.length > 8 ? `; … (${members.length - 8} more records)` : ''}`,
    };
  const recordedMode = members[0].mode;
  const recordedTier = members[0].permission;
  // one entry per canonical harness (input is newest first); two records naming different sessions are ambiguous
  const latest = new Map<string, RunRecord>();
  for (const r of members) {
    const h = canonicalHarness(r.harness);
    if (h === null)
      return {
        ok: false,
        error: `fan-out ${fanoutId} has a record naming harness ${quoteValue(r.harness, 60)}, which is not a known harness — refusing to resume it`,
      };
    const prior = latest.get(h);
    if (!prior) latest.set(h, r);
    else if (prior.sessionId && r.sessionId && prior.sessionId !== r.sessionId)
      return {
        ok: false,
        error: `two run records of ${h} in fan-out ${fanoutId} name different sessions (${quoteFull(prior.sessionId)}, ${quoteFull(r.sessionId)}), so which one to resume is ambiguous — refusing`,
      };
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
  // Today's tier per member, from the mode that will actually run.
  const mode = env.mode ?? recordedMode;
  // a human-typed mode that DIFFERS from the recorded one is their choice and skips the comparison; a typed mode
  // equal to the recorded one is no choice at all, so the check still applies
  const checkTier = !(env.mode !== undefined && env.modeTypedByHuman === true && env.mode !== recordedMode);
  const resumed: ResumeMember[] = [];
  const tierCeiling: Record<string, TierCeiling> = {};
  for (const h of harnesses) {
    const r = latest.get(h) as RunRecord;
    const nowTier = env.modeTier(h, mode);
    tierCeiling[h] = nowTier ?? 'unavailable';
    if (checkTier && nowTier !== null && TIER_RANK[nowTier] > TIER_RANK[recordedTier])
      return {
        ok: false,
        error: `mode ${quoteFull(mode)} on ${h} now runs at ${nowTier} permission, but this member of fan-out ${fanoutId} ran at ${recordedTier} — the template has been widened since, so it is not resumed as a continuation. Start it with the normal command if you want the wider tier`,
      };
    resumed.push({
      harness: h,
      sessionId: r.sessionId as string,
      runId: r.runId,
      origin: r.origin,
      recordedTier: r.permission,
      nowTier,
    });
  }
  return { ok: true, harnesses, sessions, noSession, otherCwd, unreadable: lost, mode, members: resumed, tierCeiling };
}

const ORIGIN_WORDS = {
  command: 'a /delegate command',
  tool: 'the delegate tool (the model)',
  unknown: 'unknown (a legacy record, or one that does not say)',
} as const;

/**
 * What a person is shown before a fan-out resume (both the command and the tool path): every member's
 * harness, its session id (<= 128 characters, shown whole, escaped), the tier its mode has today next to
 * the recorded one, who started it, and the follow-up task in full. Pure; every string is escaped.
 */
export function formatFanoutResumePlan(
  fanoutId: string,
  plan: Extract<FanoutResumePlan, { ok: true }>,
  task: string | undefined,
  source: 'command' | 'tool',
  extras: Omit<RunSteering, 'task' | 'harnesses' | 'mode' | 'sessions' | 'sessionId'> = {},
): string {
  const lines = [
    `Resume fan-out ${fanoutId}: every member continues its own recorded session on its own harness.`,
    `mode: ${quoteFull(plan.mode)}`,
    'members:',
    ...plan.members.map(
      m =>
        `  ${m.harness} — session ${quoteFull(m.sessionId)} · tier now ${m.nowTier ?? 'unavailable (mode does not resolve)'}${m.nowTier === m.recordedTier ? '' : ` (recorded: ${m.recordedTier})`} · started by ${ORIGIN_WORDS[m.origin ?? 'unknown']}`,
    ),
  ];
  if (plan.noSession.length > 0)
    lines.push(`not resumed (no recorded session id): ${plan.noSession.map(safeName).join(', ')}`);
  if (plan.otherCwd.length > 0)
    lines.push(`not resumed (recorded in another working directory): ${plan.otherCwd.join(', ')}`);
  if (plan.unreadable.length > 0)
    lines.push(`not resumed (unreadable run record): ${plan.unreadable.map(safeName).join(', ')}`);
  if (source === 'tool')
    lines.push(
      'WARNING: this was requested by the delegate tool (the model), not typed by you. Check the follow-up task below before approving.',
    );
  else if (plan.members.some(m => m.origin !== 'command'))
    lines.push(
      'WARNING: at least one member was NOT recorded as started by a /delegate command (the record says the tool, or nothing).',
    );
  lines.push(...steeringFieldLines(extras));
  if (task === undefined || task === '') {
    lines.push("follow-up task: (the mode's default)");
    if (extras.scope !== undefined) lines.push(...steeringTextBlocks({ scope: extras.scope }));
  } else lines.push(...steeringTextBlocks({ scope: extras.scope, task }, 'follow-up task'));
  return lines.join('\n');
}
