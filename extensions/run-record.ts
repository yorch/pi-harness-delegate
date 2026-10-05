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
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { HARNESS_NAMES } from './harnesses/registry.ts';
import type { StreamedUsage } from './harnesses/types.ts';
import { ensurePrivateDir } from './private-dir.ts';
import { newestFirst } from './recency.ts';
import { sanitizeTemplateText } from './sanitize.ts';

export const RUN_RECORD_VERSION = 1;

/** Stored text caps — a record can't grow without bound (and a rerun refuses a truncated task). */
export const RECORD_LIMITS = { task: 20_000, scope: 4_000, field: 200, path: 4_096, addDirs: 32 } as const;

/** A sidecar bigger than this is never read (and the writer shrinks a record to fit) — a hostile or
 *  runaway file can't make a listing/rerun read megabytes, and a FIFO/device can't be slurped. */
export const RECORD_MAX_BYTES = 64 * 1024;
/** At most this many transcripts (newest first) have their sidecar read per outputs directory. */
export const MAX_SIDECARS_SCANNED = 2000;
/** A mode name as `/delegate history --mode=` and a template `name:` accept it. */
export const MODE_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

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

export type RunOrigin = 'tool' | 'command';

export interface RunRecordInput {
  task: string;
  /** The task text was cut at `RECORD_LIMITS.task` — such a record is not rerunnable. */
  taskTruncated: boolean;
  scope: string | null;
  /** The scope text was cut at `RECORD_LIMITS.scope` — not rerunnable either: a cut `src/foo/bar.ts`
   *  would silently WIDEN the restriction to `src/foo`. Optional on disk (absent = false). */
  scopeTruncated: boolean;
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
  /**
   * Who started the run: the `delegate` tool (the model), or a `/delegate` command (a person). `null` =
   * unknown (a record written before this field existed, or one that does not say). Optional on disk.
   * A hint for the human who is asked to repeat the run — the sidecar is untrusted, so it is never a
   * proof, only something to SHOW (and, headless, to require `--trust-origin` for when it isn't `command`).
   */
  origin: RunOrigin | null;
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
  origin?: RunOrigin | null;
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
    origin: s.origin ?? null,
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
      scopeTruncated: Boolean(s.scope && s.scope.length > RECORD_LIMITS.scope),
      pr: s.pr ?? null,
      addDirs: (s.addDirs ?? []).slice(0, RECORD_LIMITS.addDirs),
      model: s.requestedModel ?? null,
      budgetUsd: s.budgetUsd ?? null,
      timeoutSec: s.timeoutSec ?? null,
      hadVerify: s.hadVerify,
    },
  };
}

/** Serialize `record`, shrinking the stored task/scope (and flagging them truncated, so a rerun
 *  refuses them) until it fits `RECORD_MAX_BYTES` — a record the reader would refuse is useless. */
function serializeWithinCap(record: RunRecord): string {
  let r = record;
  for (let i = 0; i < 12; i++) {
    const text = `${JSON.stringify(r, null, 2)}\n`;
    if (Buffer.byteLength(text, 'utf8') <= RECORD_MAX_BYTES) return text;
    const t = r.input.task;
    const sc = r.input.scope;
    r = {
      ...r,
      input: {
        ...r.input,
        task: t.length > 0 ? t.slice(0, Math.floor(t.length / 2)) : t,
        taskTruncated: r.input.taskTruncated || t.length > 0,
        scope: sc ? sc.slice(0, Math.floor(sc.length / 2)) : sc,
        scopeTruncated: r.input.scopeTruncated || Boolean(sc),
      },
    };
  }
  throw new Error('run record too large');
}

/**
 * Write the sidecar next to its transcript (`0600`) and return its path. Atomic and symlink-safe: the
 * bytes go to a fresh, uniquely named temp file created with `O_EXCL` (`'wx'`, never follows a
 * pre-existing link) and are then `rename`d over the final name — `rename` replaces a pre-existing
 * symlink (or file) at that name instead of writing through it. The directory is (re)asserted `0700` (never
 * through a symlinked directory — see `ensurePrivateDir`).
 * Throws on I/O failure (the caller treats a record as best-effort).
 */
export function writeRunRecord(transcriptFile: string, record: RunRecord): string {
  const file = recordPathFor(transcriptFile);
  const dir = dirname(file);
  ensurePrivateDir(dir);
  const text = serializeWithinCap(record);
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(tmp, 'wx', 0o600);
    writeSync(fd, text);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, file);
  } catch (err) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      // never created, or already renamed
    }
    throw err;
  }
  try {
    chmodSync(file, 0o600);
  } catch {
    // best-effort
  }
  return file;
}

/** A failed parse may still say which fan-out the file claims (`fanoutId` peeked, shape-checked) so a
 *  resume can LIST an unreadable member instead of silently losing it. Nothing else is taken from it. */
export type ParsedRecord = { ok: true; record: RunRecord } | { ok: false; reason: string; fanoutId?: string };

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
  const peeked = typeof raw.fanoutId === 'string' && FANOUT_ID_RE.test(raw.fanoutId) ? raw.fanoutId : undefined;
  const bad = (field: string): ParsedRecord => ({
    ok: false,
    reason: `invalid field "${field}"`,
    ...(peeked ? { fanoutId: peeked } : {}),
  });
  const F = RECORD_LIMITS.field;
  if (typeof raw.runId !== 'string' || !RUN_ID_RE.test(raw.runId)) return bad('runId');
  if (raw.fanoutId !== null && !(typeof raw.fanoutId === 'string' && FANOUT_ID_RE.test(raw.fanoutId)))
    return bad('fanoutId');
  // optional (older records lack it): absent/null = unknown
  if (raw.origin !== undefined && raw.origin !== null && raw.origin !== 'tool' && raw.origin !== 'command')
    return bad('origin');
  // exactly one canonical harness name — never a comma list, `all`, an alias or a case variant: what a
  // record names is what a rerun launches, so it must be the thing the listing shows.
  if (typeof raw.harness !== 'string' || !(HARNESS_NAMES as readonly string[]).includes(raw.harness))
    return bad('harness');
  if (typeof raw.mode !== 'string' || !MODE_NAME_RE.test(raw.mode)) return bad('mode');
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
  // optional (older records lack it) — absent means "not truncated"
  if (i.scopeTruncated !== undefined && typeof i.scopeTruncated !== 'boolean') return bad('input.scopeTruncated');
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
    origin: (raw.origin ?? null) as RunOrigin | null,
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
      scopeTruncated: i.scopeTruncated === true,
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

/**
 * Read + parse one sidecar file; never throws. Only a regular file qualifies (`lstat`, so a symlink
 * is refused rather than followed), no bigger than `RECORD_MAX_BYTES`, opened non-blocking and
 * `fstat`ed again after the open — a FIFO/device named `x.json` can neither hang a rerun nor be read.
 */
export function readRunRecord(file: string): ParsedRecord {
  let fd: number | undefined;
  try {
    const st = lstatSync(file);
    if (!st.isFile()) return { ok: false, reason: 'not a regular file' };
    if (st.size > RECORD_MAX_BYTES) return { ok: false, reason: 'too large' };
    fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
    const fst = fstatSync(fd);
    if (!fst.isFile()) return { ok: false, reason: 'not a regular file' };
    if (fst.size > RECORD_MAX_BYTES) return { ok: false, reason: 'too large' };
    const buf = Buffer.alloc(RECORD_MAX_BYTES + 1);
    let n = 0;
    for (;;) {
      const got = readSync(fd, buf, n, buf.length - n, null);
      if (got === 0) break;
      n += got;
      if (n > RECORD_MAX_BYTES) return { ok: false, reason: 'too large' };
    }
    return parseRunRecord(buf.subarray(0, n).toString('utf8'));
  } catch {
    return { ok: false, reason: 'unreadable' };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
    }
  }
}

/** A record's text made safe to print: ANSI/control/invisible characters stripped, one line, capped. */
export function displayText(text: string, max = 80): string {
  return sanitizeTemplateText(text, max);
}

/** A record sitting next to a real transcript, in the outputs directory of its own harness. */
export interface LocatedRecord {
  record: RunRecord;
  /** Absolute path of the sibling transcript (`.md`). */
  transcript: string;
  /** The transcript's mtime — the one ordering key history and rerun share. */
  mtimeMs: number;
}

export type RecordLoad =
  | { ok: true; record: RunRecord }
  | { ok: false; reason: string; hasSidecar: boolean; fanoutId?: string };

/**
 * Load the sidecar of `transcriptPath`, which lives in the outputs directory of `dirHarness`. A
 * record is trusted to describe a run only when ALL hold: the transcript is a regular file, the
 * sidecar parses, its `harness` equals the directory's harness (a hand-edited `claude` sidecar that
 * says `codex` is refused — the listing shows the directory, a rerun would launch the record), and
 * its `transcript` names this very file (a copied/planted sidecar is refused).
 */
export function loadRecordForTranscript(transcriptPath: string, dirHarness: string): RecordLoad {
  try {
    if (!lstatSync(transcriptPath).isFile())
      return { ok: false, reason: 'transcript is not a regular file', hasSidecar: false };
  } catch {
    return { ok: false, reason: 'transcript is missing', hasSidecar: false };
  }
  const sidecar = recordPathFor(transcriptPath);
  try {
    lstatSync(sidecar);
  } catch {
    return { ok: false, reason: 'no run record', hasSidecar: false };
  }
  const parsed = readRunRecord(sidecar);
  if (!parsed.ok)
    return {
      ok: false,
      reason: parsed.reason,
      hasSidecar: true,
      ...(parsed.fanoutId ? { fanoutId: parsed.fanoutId } : {}),
    };
  const r = parsed.record;
  if (r.harness !== dirHarness)
    return {
      ok: false,
      reason: `record says harness ${JSON.stringify(displayText(r.harness, 24))} but it is in the ${dirHarness} outputs directory`,
      hasSidecar: true,
      ...(r.fanoutId ? { fanoutId: r.fanoutId } : {}),
    };
  if (r.transcript !== transcriptPath.split(/[\\/]/).pop())
    return {
      ok: false,
      reason: 'record names a different transcript',
      hasSidecar: true,
      ...(r.fanoutId ? { fanoutId: r.fanoutId } : {}),
    };
  return { ok: true, record: r };
}

// The one ordering history, rerun, resume and pruning share (recency.ts): newest transcript mtime first,
// future-dated files last.
export { newestFirst };

export interface SkippedRecord {
  file: string;
  reason: string;
  /** The fan-out the unusable file claims to belong to (shape-checked), when it said. */
  fanoutId?: string;
  /** The harness whose outputs directory it sits in (trusted: a location, not the file's own claim). */
  harness?: string;
}

/**
 * Every usable record in `dir` (the outputs directory of `dirHarness`), newest transcript first. Only
 * records with a sibling transcript are considered (a stray `.json` alone is never selectable); at
 * most `MAX_SIDECARS_SCANNED` transcripts are looked at. A transcript whose sidecar exists but is
 * unusable is reported in `skipped` with the reason — never silently dropped. A transcript with no
 * sidecar at all (legacy) is simply not a record.
 */
export function readRecordsIn(
  dir: string,
  dirHarness: string,
): { records: LocatedRecord[]; skipped: SkippedRecord[]; truncated: boolean } {
  const records: LocatedRecord[] = [];
  const skipped: SkippedRecord[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter(f => f.endsWith('.md'));
  } catch {
    return { records, skipped, truncated: false };
  }
  const stamped: { name: string; mtimeMs: number }[] = [];
  for (const name of names) {
    try {
      const st = lstatSync(join(dir, name));
      if (st.isFile()) stamped.push({ name, mtimeMs: st.mtimeMs });
    } catch {
      // vanished
    }
  }
  stamped.sort(newestFirst);
  for (const { name, mtimeMs } of stamped.slice(0, MAX_SIDECARS_SCANNED)) {
    const transcript = join(dir, name);
    const loaded = loadRecordForTranscript(transcript, dirHarness);
    if (loaded.ok) records.push({ record: loaded.record, transcript, mtimeMs });
    else if (loaded.hasSidecar)
      skipped.push({
        file: name,
        reason: loaded.reason,
        harness: dirHarness,
        ...(loaded.fanoutId ? { fanoutId: loaded.fanoutId } : {}),
      });
  }
  return { records, skipped, truncated: stamped.length > MAX_SIDECARS_SCANNED };
}
