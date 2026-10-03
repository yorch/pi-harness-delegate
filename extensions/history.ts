/** `/delegate history` — transcript discovery, listing, and the scrollable viewer. Split out of index.ts. */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Key, matchesKey, type SelectItem, SelectList, truncateToWidth } from '@earendil-works/pi-tui';
import { parseTranscriptMeta } from './activity.ts';
import { outputsDir as getOutputsDir, legacyOutputsDir } from './config.ts';
import { formatCost } from './engine.ts';
import { HARNESS_NAMES } from './harnesses/registry.ts';
export interface HistoryEntry {
  file: string;
  mode: string;
  harness: string;
  cost: number | null;
  sessionId: string | null;
  mtime: number;
}

export function readHistory(dir: string, harness: string): HistoryEntry[] {
  try {
    return readdirSync(dir)
      .filter(f => f.endsWith('.md') && !f.includes('-partial'))
      .map(f => {
        const file = join(dir, f);
        let mode = 'delegate';
        let cost: number | null = null;
        let sessionId: string | null = null;
        try {
          const meta = parseTranscriptMeta(readFileSync(file, 'utf8').slice(0, 2000));
          mode = meta.mode;
          cost = meta.cost;
          sessionId = meta.sessionId;
        } catch (_e) {
          void _e;
        }
        return {
          file,
          mode,
          harness,
          cost,
          sessionId,
          mtime: statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0,
        };
      })
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
  // also legacy dir for migration display
  try {
    const legacy = readdirSync(legacyOutputsDir()).filter(f => f.endsWith('.md') && !f.includes('-partial'));
    for (const f of legacy) {
      const file = join(legacyOutputsDir(), f);
      let mode = 'delegate';
      let cost: number | null = null;
      let sessionId: string | null = null;
      try {
        const meta = parseTranscriptMeta(readFileSync(file, 'utf8').slice(0, 2000));
        mode = meta.mode;
        cost = meta.cost;
        sessionId = meta.sessionId;
      } catch (_e) {
        void _e;
      }
      entries.push({
        file,
        mode,
        harness: 'claude',
        cost,
        sessionId,
        mtime: statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0,
      });
    }
  } catch (_e) {
    void _e;
  }
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

export async function showHistory(ctx: ExtensionContext, harnessFilter?: string): Promise<void> {
  const entries = harnessFilter ? readAllHistory().filter(e => e.harness === harnessFilter) : readAllHistory();
  if (entries.length === 0) {
    const msg = harnessFilter
      ? `No transcripts yet for ${harnessFilter} — run /delegate ${harnessFilter} <mode> <prompt> first`
      : 'No transcripts yet — run /delegate <harness> <mode> <prompt> first';
    if (!ctx.hasUI) process.stdout.write(`${msg}\n`);
    else ctx.ui.notify?.(msg, 'info');
    return;
  }
  if (!ctx.hasUI) {
    if (harnessFilter) process.stdout.write(`delegate — history (${harnessFilter})\n`);
    for (const e of entries)
      process.stdout.write(`${e.harness} ${e.mode} · ${formatCost(e.cost)} · ${e.sessionId ?? '-'}\n`);
    return;
  }
  const entry = await ctx.ui.custom((tui, theme, _kb, done) => {
    const items: SelectItem[] = entries.map(e => ({
      value: e.file,
      label: `${e.harness} ${e.mode} · ${formatCost(e.cost)} · ${new Date(e.mtime).toISOString().slice(0, 16)}`,
      description: e.sessionId ? `session ${e.sessionId.slice(0, 8)}…` : undefined,
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
        return harnessFilter ? [theme.fg('accent', `delegate — history (${harnessFilter})`), ...rows] : rows;
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
