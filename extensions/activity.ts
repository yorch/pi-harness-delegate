import { readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ActivityEvent } from './harnesses/types.ts';

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Make a template/mode name safe for use in a filename. */
export function safeSegmentName(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return safe.length > 0 ? safe : 'delegate';
}

export interface MetricsInput {
  numTurns: number | null;
  totalCostUsd: number | null;
  promptTokens: number;
  contextPercent: number | null;
  durationMs: number | null;
}

/** Compact run summary: `3 turn(s) · $0.54 · 62k tok · 6.2% ctx · 12s`. Unknown numTurns/cost render as `—`. */
export function formatMetrics(m: MetricsInput): string {
  const parts: Array<string | null> = [
    m.numTurns !== null ? `${m.numTurns} turn(s)` : '— turn(s)',
    m.totalCostUsd !== null ? `$${m.totalCostUsd.toFixed(3)}` : '$—',
    m.promptTokens > 0 ? `${Math.round(m.promptTokens / 1000)}k tok` : null,
    typeof m.contextPercent === 'number' ? `${m.contextPercent.toFixed(1)}% ctx` : null,
    typeof m.durationMs === 'number' && m.durationMs !== null ? `${(m.durationMs / 1000).toFixed(0)}s` : null,
  ];
  return parts.filter((p): p is string => Boolean(p)).join(' · ');
}

/** Parse the metadata header of a transcript file (without loading the whole body). `cost` is null when unknown. */
export function parseTranscriptMeta(head: string): {
  mode: string;
  cost: number | null;
  sessionId: string | null;
  harness: string | null;
} {
  let mode = 'delegate';
  let cost: number | null = null;
  let sessionId: string | null = null;
  let harness: string | null = null;
  const mm = /^# Delegated (?:Claude|Harness) run — (.+)$/m.exec(head);
  if (mm) mode = mm[1];
  // Also match new header: # Delegated <harness> run — <mode>
  const hm = /^# Delegated (\w+) run —/m.exec(head);
  if (hm) harness = hm[1].toLowerCase();
  const cm = /\bcost: \$([\d.]+)/.exec(head);
  if (cm) cost = Number(cm[1]);
  const sm = /\bsession: ([0-9a-f-]+)/.exec(head);
  if (sm) sessionId = sm[1];
  // harness explicit field
  const hfm = /^-\s*harness:\s*(\w+)/m.exec(head);
  if (hfm) harness = hfm[1];
  return { mode, cost, sessionId, harness };
}

/** One history entry's harness + cost, for spend aggregation. */
export interface SpendEntry {
  harness: string;
  cost: number | null;
}

/** Total cost, run count and unknown-cost run count — either per harness or overall. */
export interface HarnessSpend {
  totalCostUsd: number;
  runs: number;
  unknownRuns: number;
}

/** Roll up cost across history entries, per harness and overall. Runs with unknown cost are counted
 *  separately rather than silently treated as $0. Pure — testable without the TUI. */
export function aggregateSpend(entries: SpendEntry[]): {
  byHarness: Record<string, HarnessSpend>;
  total: HarnessSpend;
} {
  const byHarness: Record<string, HarnessSpend> = {};
  const total: HarnessSpend = { totalCostUsd: 0, runs: 0, unknownRuns: 0 };
  for (const e of entries) {
    if (!byHarness[e.harness]) byHarness[e.harness] = { totalCostUsd: 0, runs: 0, unknownRuns: 0 };
    const h = byHarness[e.harness];
    h.runs++;
    total.runs++;
    if (e.cost === null) {
      h.unknownRuns++;
      total.unknownRuns++;
    } else {
      h.totalCostUsd += e.cost;
      total.totalCostUsd += e.cost;
    }
  }
  return { byHarness, total };
}

/** Format a `HarnessSpend` as `$1.234 over 12 run(s) (3 unknown)`. */
export function formatSpend(s: HarnessSpend): string {
  const unknown = s.unknownRuns > 0 ? ` (${s.unknownRuns} unknown)` : '';
  return `$${s.totalCostUsd.toFixed(3)} over ${s.runs} run(s)${unknown}`;
}

/** Build the markdown report content injected into the session on the next turn. */
export function buildReportContent(opts: {
  harness?: string;
  mode: string;
  metrics: string;
  body: string;
  file?: string;
  sessionId?: string;
}): string {
  const harness = opts.harness ?? 'claude';
  const header = `## ${harness} ${opts.mode} (${opts.metrics})`;
  const foot: string[] = [];
  if (opts.file) foot.push(`transcript: ${opts.file}`);
  if (opts.sessionId)
    foot.push(
      `resume: \`/delegate --harness=${opts.harness} --resume=${opts.sessionId} <prompt>\` (or /${opts.harness} --resume=${opts.sessionId})`,
    );
  return [header, '', opts.body, foot.length > 0 ? `\n_${foot.join(' · ')}_` : ''].join('\n');
}

/** Legacy wrapper for compat */
export function buildClaudeReportContent(opts: {
  mode: string;
  metrics: string;
  body: string;
  file?: string;
  sessionId?: string;
}): string {
  return buildReportContent({ harness: 'claude', ...opts });
}

/** Delete oldest transcript files beyond `maxCount` (0 = keep everything). */
export function pruneOutputs(dir: string, maxCount: number): void {
  if (maxCount <= 0) return;
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return;
  }
  const byMtime = files
    .filter(f => f.endsWith('.md'))
    .map(f => ({ f, mtime: statSync(join(dir, f), { throwIfNoEntry: false })?.mtimeMs ?? 0 }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const { f } of byMtime.slice(maxCount)) {
    try {
      rmSync(join(dir, f));
    } catch {
      // best-effort
    }
  }
}

/** Human-readable one-liner for a tool call (uses Claude's `description` when present). */
export function formatToolUse(name: string, input: Record<string, unknown>): string {
  if (typeof input.description === 'string' && input.description) {
    return `${name}: ${truncate(input.description, 90)}`;
  }
  if (typeof input.command === 'string') return `${name}: ${truncate(input.command.split('\n')[0], 90)}`;
  if (typeof input.file_path === 'string') return `${name}: ${input.file_path}`;
  if (typeof input.pattern === 'string') return `${name}: ${input.pattern}`;
  if (typeof input.url === 'string') return `${name}: ${input.url}`;
  const first = Object.values(input).find((v): v is string => typeof v === 'string' && v.length > 0);
  return first ? `${name}: ${truncate(first, 90)}` : name;
}

/**
 * Tracks pending `tool_input` array indices by id, so a later `tool_result` can be matched to
 * the row it actually belongs to instead of always landing on the last row.
 *
 * A harness emits N `tool_input` events followed by N `tool_result` events for a parallel
 * tool-call batch, so "attach the result to the last entry" stamps every mark on the last row.
 * Harnesses that don't carry an id fall back to that last-entry behavior via `resolve`.
 * Shared by the transcript log builder and the live-feed builders (which also splice old
 * entries off the front — `shift` keeps pending indices correct after that).
 */
export class ToolCallIndex {
  private pending = new Map<string, number>();

  set(id: string | undefined, index: number): void {
    if (id) this.pending.set(id, index);
  }

  /** Index to mark, or -1 when an id was given but has no matching pending entry (don't mis-attribute). */
  resolve(id: string | undefined, fallbackIndex: number): number {
    if (id === undefined) return fallbackIndex;
    const idx = this.pending.get(id);
    if (idx === undefined) return -1;
    this.pending.delete(id);
    return idx;
  }

  /** Adjust pending indices after removing `count` entries from the front of the backing array. */
  shift(count: number): void {
    for (const [id, idx] of this.pending) {
      const next = idx - count;
      if (next < 0) this.pending.delete(id);
      else this.pending.set(id, next);
    }
  }
}

/** Compact per-line activity log for the transcript (tool_input + results only). */
export function collectActivityLog(events: ActivityEvent[]): string[] {
  const log: string[] = [];
  const index = new ToolCallIndex();
  for (const ev of events) {
    if (ev.kind === 'tool_input') {
      log.push(`▶ ${formatToolUse(ev.name, ev.input)}`);
      index.set(ev.id, log.length - 1);
    } else if (ev.kind === 'tool_result') {
      const idx = index.resolve(ev.id, log.length - 1);
      if (idx >= 0 && log[idx].startsWith('▶')) {
        log[idx] += ev.isError ? '  ✗ error' : '  ✓';
      }
    }
  }
  return log;
}

/** Full transcript written to the outputs dir: metadata + activity + output. */
export function buildTranscript(
  opts: {
    harness?: string;
    mode: string;
    permission?: string;
    permissionMode?: string;
    nativePermission?: string;
    model: string | null;
    cwd: string;
    sessionId: string | null;
    resumed: boolean;
    numTurns: number | null;
    totalCostUsd: number | null;
    isError: boolean;
    stopReason: string | null;
    durationMs: number | null;
    usage: {
      inputTokens: number;
      outputTokens: number;
      cacheCreationInputTokens: number;
      cacheReadInputTokens: number;
    } | null;
    contextPercent: number | null;
    contextWindow: number | null;
    activityLog: string[];
    output: string;
  } & Record<string, unknown>,
): string {
  const harness = (opts.harness as string | undefined) ?? 'claude';
  const permissionRaw =
    (opts.permission as string | undefined) ?? (opts.permissionMode as string | undefined) ?? 'edit';
  let permission = permissionRaw;
  let nativePermission = opts.nativePermission as string | undefined;
  // map legacy permissionMode to normalized if needed
  if ((opts as Record<string, unknown>).permissionMode && !opts.permission) {
    const pm = (opts as Record<string, unknown>).permissionMode as string;
    if (pm === 'plan') {
      permission = 'readonly';
      nativePermission = pm;
    } else if (pm === 'bypassPermissions') {
      permission = 'danger';
      nativePermission = pm;
    } else {
      permission = 'edit';
      nativePermission = pm;
    }
  }
  const u = opts.usage;
  const tokens = u
    ? [
        `input ${u.inputTokens}`,
        `output ${u.outputTokens}`,
        `cache+${u.cacheCreationInputTokens}`,
        `cache ${u.cacheReadInputTokens}`,
      ].join(' · ')
    : null;
  const context =
    opts.contextPercent !== null && opts.contextWindow
      ? `${opts.contextPercent.toFixed(1)}% of ${opts.contextWindow.toLocaleString()} window`
      : null;
  const duration = opts.durationMs !== null ? `${(opts.durationMs / 1000).toFixed(1)}s` : null;
  const permLine = nativePermission
    ? `- permission: ${permission} (${nativePermission})`
    : `- permission: ${permission}`;

  return [
    `# Delegated ${harness.charAt(0).toUpperCase() + harness.slice(1)} run — ${opts.mode}`,
    '',
    `- harness: ${harness}`,
    `- mode: ${opts.mode}`,
    permLine,
    `- model: ${opts.model ?? 'default'}`,
    `- cwd: ${opts.cwd}`,
    `- session: ${opts.sessionId ?? 'n/a'}${opts.resumed ? ' (resumed)' : ''}`,
    `- turns: ${opts.numTurns ?? 'n/a'} · cost: ${opts.totalCostUsd !== null ? `$${opts.totalCostUsd.toFixed(4)}` : 'n/a'} · isError: ${opts.isError}`,
    `- tokens: ${tokens ?? 'n/a'}`,
    `- context: ${context ?? 'n/a'}`,
    `- duration: ${duration ?? 'n/a'}`,
    `- stop reason: ${opts.stopReason ?? 'n/a'}`,
    '',
    '## Activity',
    opts.activityLog.length > 0 ? opts.activityLog.join('\n') : '(no tool activity)',
    '',
    '## Output',
    opts.output || '(empty)',
    '',
  ].join('\n');
}

/** Legacy wrapper */
export function buildClaudeTranscript(opts: {
  mode: string;
  permissionMode: string;
  model: string | null;
  cwd: string;
  sessionId: string | null;
  resumed: boolean;
  numTurns: number;
  totalCostUsd: number;
  isError: boolean;
  stopReason: string | null;
  durationMs: number | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
  } | null;
  contextPercent: number | null;
  contextWindow: number | null;
  activityLog: string[];
  output: string;
}): string {
  return buildTranscript({
    harness: 'claude',
    mode: opts.mode,
    permission:
      opts.permissionMode === 'plan' ? 'readonly' : opts.permissionMode === 'bypassPermissions' ? 'danger' : 'edit',
    nativePermission: opts.permissionMode,
    model: opts.model,
    cwd: opts.cwd,
    sessionId: opts.sessionId,
    resumed: opts.resumed,
    numTurns: opts.numTurns,
    totalCostUsd: opts.totalCostUsd,
    isError: opts.isError,
    stopReason: opts.stopReason,
    durationMs: opts.durationMs,
    usage: opts.usage,
    contextPercent: opts.contextPercent,
    contextWindow: opts.contextWindow,
    activityLog: opts.activityLog,
    output: opts.output,
  });
}
