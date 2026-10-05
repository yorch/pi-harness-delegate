/** `/delegate history` — transcript discovery, listing, and the scrollable viewer. Split out of index.ts. */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Key, matchesKey, type SelectItem, SelectList, truncateToWidth } from '@earendil-works/pi-tui';
import { parseTranscriptIsError, parseTranscriptMeta } from './activity.ts';
import { outputsDir as getOutputsDir, legacyOutputsDir } from './config.ts';
import { formatCost } from './engine.ts';
import { HARNESS_NAMES } from './harnesses/registry.ts';
import { applyHistoryFilter, describeHistoryFilter, type HistoryEntry, type HistoryFilter } from './history-filter.ts';
import { displayText, loadRecordForTranscript, MAX_SIDECARS_SCANNED, newestFirst } from './run-record.ts';

export type { HistoryEntry };

/** One history entry for a transcript: its run-record sidecar when there is one (and it is trusted —
 *  `loadRecordForTranscript`: same-directory harness, matching transcript name, regular files), else
 *  the transcript header — so a legacy transcript with no sidecar, or an unusable sidecar, still lists
 *  (the latter carrying `recordProblem`, which the listing reports). */
function entryFor(file: string, harness: string): HistoryEntry {
  const mtime = statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0;
  const loaded = loadRecordForTranscript(file, harness);
  if (loaded.ok) {
    const r = loaded.record;
    return {
      file,
      mode: r.mode,
      harness,
      cost: r.totalCostUsd,
      sessionId: r.sessionId,
      mtime,
      isError: r.isError,
      startedMs: Date.parse(r.startedAt) || mtime,
      runId: r.runId,
      fanoutId: r.fanoutId,
      hasRecord: true,
    };
  }
  const recordProblem = loaded.hasSidecar ? loaded.reason : undefined;
  let mode = 'delegate';
  let cost: number | null = null;
  let sessionId: string | null = null;
  let isError: boolean | null = null;
  try {
    const head = readFileSync(file, 'utf8').slice(0, 2000);
    const meta = parseTranscriptMeta(head);
    mode = meta.mode;
    cost = meta.cost;
    sessionId = meta.sessionId;
    isError = parseTranscriptIsError(head);
  } catch (_e) {
    void _e;
  }
  return {
    file,
    mode,
    harness,
    cost,
    sessionId,
    mtime,
    isError,
    startedMs: mtime,
    runId: null,
    fanoutId: null,
    hasRecord: false,
    ...(recordProblem !== undefined ? { recordProblem } : {}),
  };
}

const byNewest = (a: HistoryEntry, b: HistoryEntry): number =>
  newestFirst({ mtimeMs: a.mtime, name: a.file }, { mtimeMs: b.mtime, name: b.file });

export function readHistory(dir: string, harness: string): HistoryEntry[] {
  try {
    return readdirSync(dir)
      .filter(f => f.endsWith('.md') && !f.includes('-partial'))
      .map(f => ({ f, mtime: statSync(join(dir, f), { throwIfNoEntry: false })?.mtimeMs ?? 0 }))
      .sort((a, b) => newestFirst({ mtimeMs: a.mtime, name: a.f }, { mtimeMs: b.mtime, name: b.f }))
      .slice(0, MAX_SIDECARS_SCANNED) // bounded: never read thousands of sidecars for one listing
      .map(({ f }) => entryFor(join(dir, f), harness))
      .sort(byNewest);
  } catch {
    return [];
  }
}

export function readAllHistory(): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  // new partitioned dir
  for (const h of HARNESS_NAMES) {
    entries.push(...readHistory(getOutputsDir(h), h));
  }
  // also legacy dir for migration display (legacy transcripts predate sidecars, but entryFor handles either)
  entries.push(...readHistory(legacyOutputsDir(), 'claude'));
  return entries.sort(byNewest);
}

export async function viewTranscript(ctx: ExtensionContext, entry: HistoryEntry): Promise<void> {
  if (!ctx.hasUI) {
    process.stdout.write(readFileSync(entry.file, 'utf8'));
    return;
  }
  await ctx.ui.custom((tui, theme, _kb, done) => {
    const lines = readFileSync(entry.file, 'utf8').split('\n');
    let offset = 0;
    const height = 12;
    return {
      render(width: number): string[] {
        const resume = entry.sessionId ? ` · r resume` : '';
        const header = theme.fg('accent', `${basename(entry.file)} (↑↓ scroll${resume} · esc close)`);
        const visible = lines.slice(offset, offset + height);
        return [header, ...visible.map(l => theme.fg('muted', truncateToWidth(l, width)))];
      },
      handleInput(data: string): void {
        if (matchesKey(data, Key.down) && offset < lines.length - 1) {
          offset++;
          tui.requestRender();
        } else if (matchesKey(data, Key.up) && offset > 0) {
          offset--;
          tui.requestRender();
        } else if (matchesKey(data, Key.escape)) {
          done(undefined);
        } else if (entry.sessionId && data === 'r') {
          ctx.ui.notify?.(`resume with: /delegate --resume=${entry.sessionId} <prompt>`, 'info');
        }
      },
      invalidate() {},
    };
  });
}

/** One row of the listing. Everything that came from a (possibly hand-edited) record is sanitized. */
export function historyLine(e: HistoryEntry): string {
  const status = e.isError === null ? '?' : e.isError ? 'failed' : 'ok';
  return `${displayText(e.harness, 24)} ${displayText(e.mode, 64)} · ${status} · ${formatCost(e.cost)} · ${e.sessionId ? displayText(e.sessionId, 40) : '-'}${e.runId ? ` · ${e.runId}` : ''}`;
}

/** The listing the user last saw this session — what a numeric `/delegate rerun <n>` indexes into. */
let lastView: HistoryEntry[] | null = null;

/** The last shown history view, or the full unfiltered history when none has been shown yet. */
export function currentHistoryView(): HistoryEntry[] {
  return lastView ?? applyHistoryFilter(readAllHistory(), {});
}

/** One line naming how many run records were ignored and why (sanitized), or '' when none were. */
export function describeIgnoredRecords(all: readonly HistoryEntry[]): string {
  const bad = all.filter(e => e.recordProblem !== undefined);
  if (bad.length === 0) return '';
  const reasons = [...new Set(bad.map(e => displayText(e.recordProblem ?? '', 100)))].slice(0, 3).join('; ');
  return `${bad.length} run record(s) ignored (listed from the transcript header, not rerunnable): ${reasons}`;
}

export async function showHistory(ctx: ExtensionContext, filter: HistoryFilter = {}): Promise<void> {
  const everything = readAllHistory();
  const ignored = describeIgnoredRecords(everything);
  const entries = applyHistoryFilter(everything, filter);
  lastView = entries;
  const filterLabel = describeHistoryFilter(filter);
  if (entries.length === 0) {
    const msg = filterLabel
      ? `No transcripts match (${filterLabel}) — loosen the filters, or run /delegate <harness> <mode> <prompt> first`
      : 'No transcripts yet — run /delegate <harness> <mode> <prompt> first';
    if (!ctx.hasUI) process.stdout.write(`${msg}\n`);
    else ctx.ui.notify?.(msg, 'info');
    return;
  }
  if (!ctx.hasUI) {
    if (filterLabel) process.stdout.write(`delegate — history (${filterLabel})\n`);
    entries.forEach((e, i) => {
      process.stdout.write(`${i + 1}. ${historyLine(e)}\n`);
    });
    if (ignored) process.stdout.write(`${ignored}\n`);
    return;
  }
  if (ignored) ctx.ui.notify?.(ignored, 'warning');
  const entry = await ctx.ui.custom((tui, theme, _kb, done) => {
    const items: SelectItem[] = entries.map((e, i) => ({
      value: e.file,
      // numbered exactly like the headless listing: `/delegate rerun <n>` indexes this same view
      label: `${i + 1}. ${displayText(e.harness, 24)} ${displayText(e.mode, 64)} · ${e.isError ? 'failed · ' : ''}${formatCost(e.cost)} · ${new Date(e.mtime).toISOString().slice(0, 16)}`,
      description:
        [e.sessionId ? `session ${displayText(e.sessionId, 8)}…` : '', e.runId ?? ''].filter(Boolean).join(' · ') ||
        undefined,
    }));
    const list = new SelectList(items, Math.min(items.length, 10), {
      selectedPrefix: (s: string) => theme.fg('accent', s),
      selectedText: (s: string) => theme.fg('accent', s),
      description: (s: string) => theme.fg('dim', s),
      scrollInfo: (s: string) => theme.fg('dim', s),
      noMatch: (s: string) => theme.fg('warning', s),
    });
    list.onSelect = item => done(item.value);
    list.onCancel = () => done(undefined);
    return {
      render: (w: number) => {
        const rows = list.render(w);
        return filterLabel ? [theme.fg('accent', `delegate — history (${filterLabel})`), ...rows] : rows;
      },
      invalidate: () => list.invalidate(),
      handleInput: (data: string) => {
        list.handleInput(data);
        tui.requestRender();
      },
    };
  });
  if (entry) {
    const chosen = entries.find(e => e.file === entry);
    if (chosen) await viewTranscript(ctx, chosen);
  }
}
