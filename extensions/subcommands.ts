/** `/delegate list|status|config|config init` subcommand UIs. Split out of index.ts with no behavior change. */

import { readdirSync } from 'node:fs';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Key, matchesKey, truncateToWidth } from '@earendil-works/pi-tui';
import { aggregateSpend, formatSpend } from './activity.ts';
import { activeCount } from './concurrency.ts';
import {
  buildConfigReport,
  describeConfigSource,
  getMaxConcurrent,
  outputsDir as getOutputsDir,
  legacyOutputsDir,
  loadConfigWithSource,
  nonDefaultConfig,
  writeDelegateConfig,
} from './config.ts';
import { isProjectTrusted } from './engine.ts';
import { ALIASES, detectAll, getHarness, HARNESS_NAMES, isKnownHarness } from './harnesses/registry.ts';
import { readAllHistory } from './history.ts';
import { collectModes, formatModeRow } from './modes.ts';
import { loadTemplates, projectTemplatePresence } from './templates.ts';
/**
 * `/delegate list [harness]` — the same read-only discovery data (`collectModes`) the model's
 * `delegate_modes` tool sees, one row per mode: per-harness tier, source tier, defaults, sanitized
 * description. Project-local templates only when the project is trusted, as for a run.
 */
export async function showModes(ctx: ExtensionContext, harnessFilter?: string): Promise<void> {
  const trusted = isProjectTrusted(ctx);
  const report = collectModes(ctx.cwd, trusted, harnessFilter ? [harnessFilter] : HARNESS_NAMES);
  const rows = report.modes.map(formatModeRow);
  if (report.omitted > 0) rows.push(`… +${report.omitted} more not shown`);
  if (!trusted && projectTemplatePresence(ctx.cwd, HARNESS_NAMES).dirs.length > 0)
    rows.push('(project untrusted — its project-local templates were not loaded; see /delegate status)');
  if (!ctx.hasUI) {
    process.stdout.write(`${rows.join('\n')}\n`);
    return;
  }
  await ctx.ui.custom((tui, theme, _kb, done) => {
    let offset = 0;
    const height = 12;
    return {
      render(width: number): string[] {
        const header = theme.fg(
          'accent',
          `delegate — modes${harnessFilter ? ` (${harnessFilter})` : ''} (↑↓ scroll · any key to close)`,
        );
        const visible = rows.slice(offset, offset + height);
        return [header, ...visible.map(l => theme.fg('muted', truncateToWidth(l, width)))];
      },
      handleInput(data: string): void {
        if (matchesKey(data, Key.up) && offset > 0) {
          offset--;
          tui.requestRender();
        } else if (matchesKey(data, Key.down) && offset < rows.length - 1) {
          offset++;
          tui.requestRender();
        } else {
          done(undefined);
        }
      },
      invalidate() {},
    };
  });
}

export async function showStatus(ctx: ExtensionContext, harnessFilter?: string): Promise<void> {
  const { config: cfg, source } = loadConfigWithSource();
  const detection = await detectAll();
  const trusted = isProjectTrusted(ctx);
  const allHarnesses = harnessFilter ? [harnessFilter].filter(h => isKnownHarness(h)) : HARNESS_NAMES;
  const lines: string[] = [];
  lines.push(`delegate — status${harnessFilter ? ` (${harnessFilter})` : ''}`);
  lines.push(...describeConfigSource(source));
  lines.push(`defaultHarness: ${cfg.defaultHarness} · defaultMode: ${cfg.defaultMode} · model: ${cfg.model ?? '—'}`);
  lines.push(
    `maxConcurrent: ${typeof cfg.maxConcurrent === 'number' ? cfg.maxConcurrent : JSON.stringify(cfg.maxConcurrent)} · maxTranscripts: ${cfg.maxTranscripts}`,
  );
  lines.push(
    trusted
      ? 'project trust: trusted — project-local templates (.pi/delegate/templates/) are loaded'
      : "project trust: untrusted — project-local templates skipped (trust this project via pi's trust prompt, or set defaultProjectTrust, to load them)",
  );
  lines.push('');
  lines.push('harness              binary   ok  version              outputs  templates  active');
  lines.push('─'.repeat(78));
  for (const h of harnessFilter ? allHarnesses : HARNESS_NAMES) {
    const det = detection[h] ?? { ok: false };
    const harness = getHarness(h);
    const bin = harness?.binary ?? h;
    const ver = det.version ? det.version.slice(0, 18) : det.hint ? '—' : '—';
    const ok = det.ok ? '✓' : '✗';
    let outputs = 0;
    try {
      outputs = readdirSync(getOutputsDir(h)).filter(f => f.endsWith('.md')).length;
    } catch {}
    let templates = 0;
    try {
      templates = loadTemplates(ctx.cwd, h, trusted).size;
    } catch {}
    // cross-process count via the file registry, combined with the in-process counter as a fallback
    const active = activeCount(h);
    const cap = getMaxConcurrent(cfg, h);
    const activeCol = `${active}/${cap > 0 ? cap : '∞'}`;
    const hint = !det.ok && det.hint ? `  ← ${det.hint}` : '';
    lines.push(
      `${h.padEnd(20)} ${bin.padEnd(8)} ${ok.padEnd(3)} ${ver.padEnd(20)} ${String(outputs).padEnd(8)} ${String(templates).padEnd(10)} ${activeCol}${hint}`,
    );
  }
  const historyEntries = harnessFilter ? readAllHistory().filter(e => e.harness === harnessFilter) : readAllHistory();
  const spend = aggregateSpend(historyEntries.map(e => ({ harness: e.harness, cost: e.cost })));
  lines.push('');
  lines.push('spend:');
  for (const h of harnessFilter ? allHarnesses : HARNESS_NAMES) {
    const s = spend.byHarness[h];
    lines.push(`  ${h}: ${s ? formatSpend(s) : '$0.000 over 0 run(s)'}`);
  }
  if (!harnessFilter) lines.push(`  total: ${formatSpend(spend.total)}`);
  if (!harnessFilter) {
    const globalCap = getMaxConcurrent(cfg);
    lines.push('');
    lines.push(
      `global active: ${activeCount()}/${globalCap > 0 ? globalCap : '∞'} · aliases: ${
        Object.entries(ALIASES)
          .map(([k, v]) => `${k}→${v}`)
          .join(', ') || '—'
      }`,
    );
    lines.push(`outputs dir: ${getOutputsDir()} (plus ${legacyOutputsDir()} legacy)`);
  }
  if (!ctx.hasUI) {
    process.stdout.write(`${lines.join('\n')}\n`);
    return;
  }
  await ctx.ui.custom((tui, theme, _kb, done) => {
    let offset = 0;
    const height = 14;
    return {
      render(width: number): string[] {
        const header = theme.fg(
          'accent',
          `delegate status${harnessFilter ? ` — ${harnessFilter}` : ''} (↑↓ scroll · any key to close)`,
        );
        const visible = lines.slice(offset, offset + height);
        return [header, ...visible.map(l => theme.fg('muted', truncateToWidth(l, width)))];
      },
      handleInput(data: string): void {
        if (matchesKey(data, Key.up) && offset > 0) {
          offset--;
          tui.requestRender();
        } else if (matchesKey(data, Key.down) && offset < lines.length - 1) {
          offset++;
          tui.requestRender();
        } else done(undefined);
      },
      invalidate() {},
    };
  });
}

/**
 * `/delegate config` — the discoverability gap `/delegate status`'s provenance line only hints at:
 * shows exactly what was read from `settings.json` (or why it wasn't) plus the effective config
 * with defaults filled in, formatted as a paste-ready JSON block under the `delegate` key. Print-
 * only — writing is a separate, explicit action (`/delegate config init`, below), never triggered
 * from this default view.
 */
export async function showConfig(ctx: ExtensionContext): Promise<void> {
  const result = loadConfigWithSource();
  const lines = ['delegate — config', '', ...buildConfigReport(result)];
  if (!ctx.hasUI) {
    process.stdout.write(`${lines.join('\n')}\n`);
    return;
  }
  await ctx.ui.custom((tui, theme, _kb, done) => {
    let offset = 0;
    const height = 20;
    return {
      render(width: number): string[] {
        const header = theme.fg('accent', `delegate config — ${result.source.file} (↑↓ scroll · any key to close)`);
        const visible = lines.slice(offset, offset + height);
        return [header, ...visible.map(l => theme.fg('muted', truncateToWidth(l, width)))];
      },
      handleInput(data: string): void {
        if (matchesKey(data, Key.up) && offset > 0) {
          offset--;
          tui.requestRender();
        } else if (matchesKey(data, Key.down) && offset < lines.length - 1) {
          offset++;
          tui.requestRender();
        } else done(undefined);
      },
      invalidate() {},
    };
  });
}

/**
 * `/delegate config init` — the one place this extension ever writes to `settings.json`, and only
 * because a human explicitly typed this subcommand. Writes the current effective config (defaults
 * merged with whatever was already on disk, minus anything still at its default — pinning defaults would
 * stop later releases' default changes reaching the user) into the `delegate` key via `writeDelegateConfig()`
 * (read-modify-write, atomic, refuses on an unparseable file rather than clobbering it). This is
 * also the practical fix for the legacy-`claudeDelegate`-only gap `describeConfigSource` warns
 * about: writing an explicit `delegate` key (with the correctly-resolved values already folded
 * in — the legacy migration already ran before this point) makes it win from then on, without
 * this command ever touching or deleting the old `claudeDelegate` key itself.
 */
export async function initConfig(ctx: ExtensionContext): Promise<void> {
  const result = loadConfigWithSource();
  const write = writeDelegateConfig(nonDefaultConfig(result.config));
  const msg = write.ok ? `✓ ${write.message}` : `✗ ${write.message}`;
  if (!ctx.hasUI) process.stdout.write(`${msg}\n`);
  else ctx.ui.notify?.(msg, write.ok ? 'info' : 'warning');
}
