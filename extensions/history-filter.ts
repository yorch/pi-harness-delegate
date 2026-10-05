/**
 * Pure `/delegate history` filter parsing + application — no I/O, no clock reads (`now` is passed
 * in), so every rule is unit-testable. An invalid filter value is an error (the caller prints it and
 * lists nothing); it is never silently ignored.
 */

import { newestFirst } from './run-record.ts';

/** One run in the history view: from its run-record sidecar when present, else parsed from the
 *  transcript header (legacy transcripts). `isError`/`runId` are `null` when unknowable. */
export interface HistoryEntry {
  file: string;
  mode: string;
  harness: string;
  cost: number | null;
  sessionId: string | null;
  /** File mtime, ms — the sort key. */
  mtime: number;
  /** `null` when a legacy transcript's header doesn't say. */
  isError: boolean | null;
  /** When the run started (record) or its file mtime (legacy), ms. */
  startedMs: number;
  runId: string | null;
  fanoutId: string | null;
  /** True when this entry came from a usable sidecar (so it can be rerun). */
  hasRecord: boolean;
  /** Why an existing-but-unusable sidecar was ignored (the entry then lists from its transcript
   *  header). Absent when there is no sidecar at all or it is fine. Record-derived: sanitize to show. */
  recordProblem?: string;
}

export interface HistoryFilter {
  harness?: string;
  mode?: string;
  failed?: boolean;
  ok?: boolean;
  /** Keep runs that started at or after this instant (ms). */
  sinceMs?: number;
  limit?: number;
  /** The original `--since=` text, for the header. */
  sinceText?: string;
}

export const HISTORY_FLAGS_HINT =
  '[harness] [--failed|--ok] [--since=<2h|3d|1w|YYYY-MM-DD>] [--limit=<n>] [--mode=<name>]';

const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
const MODE_RE = /^[A-Za-z0-9_.-]{1,64}$/;
export const HISTORY_MAX_LIMIT = 1000;

/** `--since=` value -> a cutoff instant (ms), or an error message. */
export function parseSince(value: string, now: number): { ms: number } | { error: string } {
  const bad = {
    error: `--since must be a duration like 90m, 2h, 3d, 1w, or a date like 2026-10-01 / 2026-10-01T09:30:00Z (got ${JSON.stringify(value.slice(0, 40))})`,
  };
  const dur = /^(\d{1,6})([smhdw])$/.exec(value);
  if (dur) {
    const n = Number(dur[1]);
    return n > 0 ? { ms: now - n * UNIT_MS[dur[2]] } : bad;
  }
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (day) {
    const [y, m, d] = [Number(day[1]), Number(day[2]), Number(day[3])];
    const date = new Date(y, m - 1, d);
    // reject rollovers like 2026-02-31
    return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d ? { ms: date.getTime() } : bad;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?$/.test(value)) {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? bad : { ms };
  }
  return bad;
}

/**
 * Parse the words after `history`/`logs`: an optional bare harness word, `--harness=`, `--failed`,
 * `--ok`, `--since=`, `--limit=`, `--mode=`. `resolveHarness` maps a name to its canonical form (or
 * `null` when it isn't a known harness). Every problem lands in `errors`; when there is any, the
 * caller must run/list nothing.
 */
export function parseHistoryArgs(
  raw: string,
  now: number,
  resolveHarness: (word: string) => string | null,
): { filter: HistoryFilter; errors: string[] } {
  const filter: HistoryFilter = {};
  const errors: string[] = [];
  const setHarness = (word: string) => {
    const h = resolveHarness(word);
    if (h === null) errors.push(`unknown harness ${JSON.stringify(word.slice(0, 40))}`);
    else filter.harness = h;
  };
  for (const token of raw.split(/\s+/).filter(Boolean)) {
    const m = /^--([a-zA-Z][a-zA-Z-]*)(?:=(.*))?$/.exec(token);
    if (!m) {
      if (filter.harness === undefined && !errors.some(e => e.startsWith('unknown harness'))) setHarness(token);
      else errors.push(`unexpected argument ${JSON.stringify(token.slice(0, 40))}`);
      continue;
    }
    const [, key, value] = m;
    switch (key) {
      case 'failed':
      case 'ok':
        if (value !== undefined) errors.push(`--${key} takes no value`);
        else filter[key] = true;
        break;
      case 'harness':
        if (!value) errors.push('--harness needs a value');
        else setHarness(value);
        break;
      case 'mode':
        if (!value || !MODE_RE.test(value))
          errors.push(`--mode must be a mode name (got ${JSON.stringify((value ?? '').slice(0, 40))})`);
        else filter.mode = value;
        break;
      case 'limit': {
        const n = value !== undefined && /^\d{1,5}$/.test(value) ? Number(value) : Number.NaN;
        if (Number.isInteger(n) && n >= 1 && n <= HISTORY_MAX_LIMIT) filter.limit = n;
        else
          errors.push(
            `--limit must be a whole number from 1 to ${HISTORY_MAX_LIMIT} (got ${JSON.stringify((value ?? '').slice(0, 20))})`,
          );
        break;
      }
      case 'since': {
        const r = parseSince(value ?? '', now);
        if ('error' in r) errors.push(r.error);
        else {
          filter.sinceMs = r.ms;
          filter.sinceText = value;
        }
        break;
      }
      default:
        errors.push(`unknown option --${key}`);
    }
  }
  if (filter.failed && filter.ok) errors.push('--failed and --ok are mutually exclusive');
  return { filter, errors };
}

/** Filter, newest-first, then cap. Entries of unknown status (`isError === null`) match neither `--failed` nor `--ok`. */
export function applyHistoryFilter(entries: readonly HistoryEntry[], f: HistoryFilter): HistoryEntry[] {
  const out = entries
    .filter(e => f.harness === undefined || e.harness === f.harness)
    .filter(e => f.mode === undefined || e.mode.toLowerCase() === f.mode.toLowerCase())
    .filter(e => !f.failed || e.isError === true)
    .filter(e => !f.ok || e.isError === false)
    .filter(e => f.sinceMs === undefined || e.startedMs >= f.sinceMs)
    .sort((a, b) => newestFirst({ mtimeMs: a.mtime, name: a.file }, { mtimeMs: b.mtime, name: b.file }));
  return f.limit !== undefined ? out.slice(0, f.limit) : out;
}

/** A short, human description of the active filters ('' when none) for the header. */
export function describeHistoryFilter(f: HistoryFilter): string {
  return [
    f.harness,
    f.mode ? `mode ${f.mode}` : null,
    f.failed ? 'failed' : null,
    f.ok ? 'ok' : null,
    f.sinceText ? `since ${f.sinceText}` : null,
    f.limit !== undefined ? `limit ${f.limit}` : null,
  ]
    .filter(Boolean)
    .join(', ');
}
