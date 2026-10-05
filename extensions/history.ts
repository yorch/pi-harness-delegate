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
import { displayText, readRunRecord, recordPathFor } from './run-record.ts';

export type { HistoryEntry };

/** One history entry for a transcript: its run-record sidecar when there is one (and it parses), else
 *  the transcript header — so a legacy transcript with no sidecar, or a corrupt sidecar, still lists. */
function entryFor(file: string, harness: string): HistoryEntry {
  const mtime = statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0;
  const parsed = readRunRecord(recordPathFor(file));
  if (parsed.ok) {
    const r = parsed.record;
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
  };
}

export function readHistory(dir: string, harness: string): HistoryEntry[] {
  try {
    return readdirSync(dir)
      .filter(f => f.endsWith('.md') && !f.includes('-partial'))
      .map(f => entryFor(join(dir, f), harness))
      .sort((a, b) => b.mtime - a.mtime);
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
  return entries.sort((a, b) => b.mtime - a.mtime);
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

export async function showHistory(ctx: ExtensionContext, filter: HistoryFilter = {}): Promise<void> {
  const entries = applyHistoryFilter(readAllHistory(), filter);
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
    return;
  }
  const entry = await ctx.ui.custom((tui, theme, _kb, done) => {
    const items: SelectItem[] = entries.map(e => ({
      value: e.file,
      label: `${displayText(e.harness, 24)} ${displayText(e.mode, 64)} · ${e.isError ? 'failed · ' : ''}${formatCost(e.cost)} · ${new Date(e.mtime).toISOString().slice(0, 16)}`,
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
