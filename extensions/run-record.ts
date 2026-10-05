/**
 * Run records — the machine-readable JSON sidecar written next to every transcript
 * (`<transcript basename>.json`, `0600`). It is the foundation for history filters, `/delegate rerun`
 * and fan-out resume.
 *
 * Trust model: a record is **stored data, therefore untrusted on read** (a hand-edited or hostile
 * file must not be able to inject argv, widen permissions or smuggle terminal escapes). This module
 * only checks *shape* (types, lengths); anything that later reaches argv still goes through
 * `validateDelegateInputs`, and anything echoed to a terminal through `displayText`. A record never
 * stores the `verify` command text (only `hadVerify`), `allowDangerous`, env vars or secrets.
 */

import { randomBytes } from 'node:crypto';
import { chmodSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StreamedUsage } from './harnesses/types.ts';
import { sanitizeTemplateText } from './sanitize.ts';

export const RUN_RECORD_VERSION = 1;

/** Stored text caps — a record can't grow without bound (and a rerun refuses a truncated task). */
export const RECORD_LIMITS = { task: 20_000, scope: 4_000, field: 200, path: 4_096, addDirs: 32 } as const;

const RUN_ID_RE = /^run_[0-9a-f]{16}$/;
const FANOUT_ID_RE = /^fan_[0-9a-f]{16}$/;

/** A fresh run id: `run_` + 16 hex (URL-safe, never starts with `-`). */
export function newRunId(): string {
  return `run_${randomBytes(8).toString('hex')}`;
}

/** A fresh fan-out id: `fan_` + 16 hex. */
export function newFanoutId(): string {
  return `fan_${randomBytes(8).toString('hex')}`;
}

export function isRunId(s: string): boolean {
  return RUN_ID_RE.test(s);
}

/** True only for the exact fan-out id format — lookup against records decides whether it is real. */
export function isFanoutId(s: string): boolean {
  return FANOUT_ID_RE.test(s);
}

export interface RunRecordInput {
  task: string;
  /** The task text was cut at `RECORD_LIMITS.task` — such a record is not rerunnable. */
  taskTruncated: boolean;
  scope: string | null;
  pr: string | null;
  /** The call-level `addDirs` (not the template's), as given. */
  addDirs: string[];
  /** Explicitly requested model (not the resolved/actual one, which is `RunRecord.model`). */
  model: string | null;
  budgetUsd: number | null;
  timeoutSec: number | null;
  /** Whether a verify command was in play. The command text itself is never stored. */
  hadVerify: boolean;
}

export interface RunRecord {
  version: 1;
  runId: string;
  fanoutId: string | null;
  harness: string;
  mode: string;
  /** Resolved permission tier the run actually used (`danger` also when escalated). */
  permission: 'readonly' | 'edit' | 'danger';
  nativePermission: string | null;
  nativeClass: 'none' | 'safe' | 'danger' | 'unlisted';
  /** The model the harness actually ran, when known. */
  model: string | null;
  sessionId: string | null;
  resumed: boolean;
  startedAt: string;
  endedAt: string;
  durationMs: number | null;
  isError: boolean;
  /** A partial transcript of a run that threw after producing output. */
  partial: boolean;
  stopReason: string | null;
  budget: { limitUsd: number; enforcement: 'native' | 'host' | 'unenforced'; exceeded: boolean } | null;
  timeoutMs: number | null;
  /** `null` = unmeasured, never a fake 0. */
  numTurns: number | null;
  totalCostUsd: number | null;
  usage: StreamedUsage | null;
  /** Transcript file name only (same directory as the record). */
  transcript: string;
  cwd: string;
  input: RunRecordInput;
}

/** Cap `s` at `max` UTF-16 units. */
function cap(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

/** The sidecar path for a transcript path (`x.md` -> `x.json`). */
export function recordPathFor(transcriptFile: string): string {
  return `${transcriptFile.replace(/\.md$/, '')}.json`;
}

/** Fields a caller supplies; `buildRunRecord` caps and normalizes them. */
export interface RunRecordSource {
  runId: string;
  fanoutId?: string | null;
  harness: string;
  mode: string;
  permission: RunRecord['permission'];
  nativePermission?: string | null;
  nativeClass: RunRecord['nativeClass'];
  model: string | null;
  sessionId: string | null;
  resumed: boolean;
  startedAtMs: number;
  endedAtMs: number;
  durationMs: number | null;
  isError: boolean;
  partial?: boolean;
  stopReason: string | null;
  budget?: { limitUsd: number; enforcement: 'native' | 'host' | 'unenforced'; exceeded: boolean } | null;
  timeoutMs: number | null;
  numTurns: number | null;
  totalCostUsd: number | null;
  usage: StreamedUsage | null;
  transcriptFile: string;
  cwd: string;
  task: string;
  scope?: string | null;
  pr?: string | null;
  addDirs?: string[];
  requestedModel?: string | null;
  budgetUsd?: number | null;
  timeoutSec?: number | null;
  hadVerify: boolean;
}

export function buildRunRecord(s: RunRecordSource): RunRecord {
  const base = s.transcriptFile.split(/[\\/]/).pop() ?? s.transcriptFile;
  return {
    version: 1,
    runId: s.runId,
    fanoutId: s.fanoutId ?? null,
    harness: s.harness,
    mode: s.mode,
    permission: s.permission,
    nativePermission: s.nativePermission ?? null,
    nativeClass: s.nativeClass,
    model: s.model,
    sessionId: s.sessionId,
    resumed: s.resumed,
    startedAt: new Date(s.startedAtMs).toISOString(),
    endedAt: new Date(s.endedAtMs).toISOString(),
    durationMs: s.durationMs,
    isError: s.isError,
    partial: s.partial === true,
    stopReason: s.stopReason,
    budget: s.budget ?? null,
    timeoutMs: s.timeoutMs,
    numTurns: s.numTurns,
    totalCostUsd: s.totalCostUsd,
    usage: s.usage,
    transcript: base,
    cwd: s.cwd,
    input: {
      task: cap(s.task, RECORD_LIMITS.task),
      taskTruncated: s.task.length > RECORD_LIMITS.task,
      scope: s.scope ? cap(s.scope, RECORD_LIMITS.scope) : null,
      pr: s.pr ?? null,
      addDirs: (s.addDirs ?? []).slice(0, RECORD_LIMITS.addDirs),
      model: s.requestedModel ?? null,
      budgetUsd: s.budgetUsd ?? null,
      timeoutSec: s.timeoutSec ?? null,
      hadVerify: s.hadVerify,
    },
  };
}

/** Write the sidecar next to its transcript (`0600`). Returns its path. Throws on I/O failure. */
export function writeRunRecord(transcriptFile: string, record: RunRecord): string {
  const file = recordPathFor(transcriptFile);
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // best-effort
  }
  return file;
}

export type ParsedRecord = { ok: true; record: RunRecord } | { ok: false; reason: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const strOrNull = (v: unknown, max: number): boolean => v === null || isStr(v, max);
const numOrNull = (v: unknown): boolean => v === null || (typeof v === 'number' && Number.isFinite(v));
const isIso = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v));

/**
 * Tolerant, strict-on-shape parser. Never throws: a garbled file, an unknown `version` or any
 * wrongly-typed/oversized field yields `{ok:false, reason}` so the caller can skip it. Values are
 * *not* trusted afterwards — see the module comment.
 */
export function parseRunRecord(text: string): ParsedRecord {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'not valid JSON' };
  }
  if (!isObj(raw)) return { ok: false, reason: 'not a JSON object' };
  if (raw.version !== RUN_RECORD_VERSION)
    return { ok: false, reason: `unsupported record version ${JSON.stringify(String(raw.version).slice(0, 20))}` };
  const bad = (field: string): ParsedRecord => ({ ok: false, reason: `invalid field "${field}"` });
  const F = RECORD_LIMITS.field;
  if (typeof raw.runId !== 'string' || !RUN_ID_RE.test(raw.runId)) return bad('runId');
  if (raw.fanoutId !== null && !(typeof raw.fanoutId === 'string' && FANOUT_ID_RE.test(raw.fanoutId)))
    return bad('fanoutId');
  if (!isStr(raw.harness, F) || !raw.harness) return bad('harness');
  if (!isStr(raw.mode, F) || !raw.mode) return bad('mode');
  if (raw.permission !== 'readonly' && raw.permission !== 'edit' && raw.permission !== 'danger')
    return bad('permission');
  if (!strOrNull(raw.nativePermission, F)) return bad('nativePermission');
  if (!['none', 'safe', 'danger', 'unlisted'].includes(raw.nativeClass as string)) return bad('nativeClass');
  if (!strOrNull(raw.model, F)) return bad('model');
  if (!strOrNull(raw.sessionId, 256)) return bad('sessionId');
  if (typeof raw.resumed !== 'boolean') return bad('resumed');
  if (!isIso(raw.startedAt)) return bad('startedAt');
  if (!isIso(raw.endedAt)) return bad('endedAt');
  if (!numOrNull(raw.durationMs)) return bad('durationMs');
  if (typeof raw.isError !== 'boolean') return bad('isError');
  if (typeof raw.partial !== 'boolean') return bad('partial');
  if (!strOrNull(raw.stopReason, F)) return bad('stopReason');
  if (raw.budget !== null) {
    const b = raw.budget;
    if (
      !isObj(b) ||
      typeof b.limitUsd !== 'number' ||
      !Number.isFinite(b.limitUsd) ||
      !['native', 'host', 'unenforced'].includes(b.enforcement as string) ||
      typeof b.exceeded !== 'boolean'
    )
      return bad('budget');
  }
  if (!numOrNull(raw.timeoutMs)) return bad('timeoutMs');
  if (!numOrNull(raw.numTurns)) return bad('numTurns');
  if (!numOrNull(raw.totalCostUsd)) return bad('totalCostUsd');
  if (raw.usage !== null) {
    const u = raw.usage;
    if (
      !isObj(u) ||
      ![u.inputTokens, u.outputTokens, u.cacheCreationInputTokens, u.cacheReadInputTokens].every(
        n => typeof n === 'number' && Number.isFinite(n),
      )
    )
      return bad('usage');
  }
  if (!isStr(raw.transcript, F) || !raw.transcript || /[\\/]/.test(raw.transcript)) return bad('transcript');
  if (!isStr(raw.cwd, RECORD_LIMITS.path)) return bad('cwd');
  const i = raw.input;
  if (!isObj(i)) return bad('input');
  if (!isStr(i.task, RECORD_LIMITS.task)) return bad('input.task');
  if (typeof i.taskTruncated !== 'boolean') return bad('input.taskTruncated');
  if (!strOrNull(i.scope, RECORD_LIMITS.scope)) return bad('input.scope');
  if (!strOrNull(i.pr, 1_000)) return bad('input.pr');
  if (
    !Array.isArray(i.addDirs) ||
    i.addDirs.length > RECORD_LIMITS.addDirs ||
    !i.addDirs.every(d => isStr(d, RECORD_LIMITS.path))
  )
    return bad('input.addDirs');
  if (!strOrNull(i.model, F)) return bad('input.model');
  if (!numOrNull(i.budgetUsd)) return bad('input.budgetUsd');
  if (!numOrNull(i.timeoutSec)) return bad('input.timeoutSec');
  if (typeof i.hadVerify !== 'boolean') return bad('input.hadVerify');
  // Rebuild from the validated fields only — unknown extra keys in a (possibly hand-edited) file are dropped.
  const record: RunRecord = {
    version: 1,
    runId: raw.runId,
    fanoutId: raw.fanoutId as string | null,
    harness: raw.harness,
    mode: raw.mode,
    permission: raw.permission,
    nativePermission: raw.nativePermission as string | null,
    nativeClass: raw.nativeClass as RunRecord['nativeClass'],
    model: raw.model as string | null,
    sessionId: raw.sessionId as string | null,
    resumed: raw.resumed,
    startedAt: raw.startedAt,
    endedAt: raw.endedAt,
    durationMs: raw.durationMs as number | null,
    isError: raw.isError,
    partial: raw.partial,
    stopReason: raw.stopReason as string | null,
    budget:
      raw.budget === null
        ? null
        : {
            limitUsd: (raw.budget as { limitUsd: number }).limitUsd,
            enforcement: (raw.budget as { enforcement: 'native' | 'host' | 'unenforced' }).enforcement,
            exceeded: (raw.budget as { exceeded: boolean }).exceeded,
          },
    timeoutMs: raw.timeoutMs as number | null,
    numTurns: raw.numTurns as number | null,
    totalCostUsd: raw.totalCostUsd as number | null,
    usage:
      raw.usage === null
        ? null
        : {
            inputTokens: (raw.usage as StreamedUsage).inputTokens,
            outputTokens: (raw.usage as StreamedUsage).outputTokens,
            cacheCreationInputTokens: (raw.usage as StreamedUsage).cacheCreationInputTokens,
            cacheReadInputTokens: (raw.usage as StreamedUsage).cacheReadInputTokens,
          },
    transcript: raw.transcript,
    cwd: raw.cwd,
    input: {
      task: i.task,
      taskTruncated: i.taskTruncated,
      scope: i.scope as string | null,
      pr: i.pr as string | null,
      addDirs: i.addDirs as string[],
      model: i.model as string | null,
      budgetUsd: i.budgetUsd as number | null,
      timeoutSec: i.timeoutSec as number | null,
      hadVerify: i.hadVerify,
    },
  };
  return { ok: true, record };
}

/** Read + parse one sidecar file; never throws. */
export function readRunRecord(file: string): ParsedRecord {
  try {
    return parseRunRecord(readFileSync(file, 'utf8'));
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
}

/** A record's text made safe to print: ANSI/control/invisible characters stripped, one line, capped. */
export function displayText(text: string, max = 80): string {
  return sanitizeTemplateText(text, max);
}

/** Every record found directly in `dir` (skipping — with a reason — anything unparseable). */
export function readRecordsIn(dir: string): { records: RunRecord[]; skipped: { file: string; reason: string }[] } {
  const records: RunRecord[] = [];
  const skipped: { file: string; reason: string }[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter(f => f.endsWith('.json'));
  } catch {
    return { records, skipped };
  }
  for (const f of names) {
    const parsed = readRunRecord(join(dir, f));
    if (parsed.ok) records.push(parsed.record);
    else skipped.push({ file: f, reason: parsed.reason });
  }
  return { records, skipped };
}
