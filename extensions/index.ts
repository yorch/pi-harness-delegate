/**
 * pi-harness-delegate — delegate work to any harness from the pi coding agent.
 *
 * Registers:
 *   - `delegate` tool (primary) + `claude_delegate` alias
 *   - `/delegate` command (primary) + `/claude`, `/codex`, `/opencode`, `/amp`, `/omp`, `/devin` aliases
 *
 * Templates ship in ../templates/shared + ../templates/<harness>; users add custom ones in
 *   ~/.pi/agent/delegate/templates/<harness>/  (global)
 *   .pi/delegate/templates/<harness>/          (project)
 * Legacy: ~/.pi/agent/claude-delegate/templates/, .pi/claude-delegate/templates/
 *
 * Config in ~/.pi/agent/settings.json: { delegate: { defaultHarness, defaultMode, ... } }
 * Legacy: { claudeDelegate: {...} } is auto-migrated.
 */

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { type ExtensionAPI, type ExtensionContext, getMarkdownTheme } from '@earendil-works/pi-coding-agent';
import {
  Container,
  Key,
  Markdown,
  matchesKey,
  type OverlayHandle,
  type SelectItem,
  SelectList,
  Text,
  truncateToWidth,
} from '@earendil-works/pi-tui';
import { Type } from 'typebox';
import { acpView, runAcpHarness } from './acp-runner.ts';
import {
  aggregateSpend,
  buildFanoutReport,
  buildReportContent,
  buildTranscript,
  buildVerifyResult,
  collectActivityLog,
  type FanoutRunSummary,
  formatMetrics,
  formatSpend,
  formatToolUse,
  orderFanoutResults,
  parseTranscriptMeta,
  pruneOutputs,
  resolveVerifyPlan,
  safeSegmentName,
  skipVerifyResult,
  ToolCallIndex,
  type VerifyResult,
} from './activity.ts';
import {
  isFanoutSpec,
  parseDelegateCommand,
  resolveDefaults,
  resolveHarnessFilter,
  resolveHarnessList,
} from './command.ts';
import { acquireSlot, activeCount } from './concurrency.ts';
import {
  buildConfigReport,
  type DelegateConfig,
  describeConfigSource,
  getMaxConcurrent,
  outputsDir as getOutputsDir,
  legacyOutputsDir,
  loadConfig,
  loadConfigWithSource,
  resolveModelForHarness,
  resolveTransport,
  writeDelegateConfig,
} from './config.ts';
import {
  ALIASES,
  detectAll,
  getHarness,
  HARNESS_NAMES,
  isKnownHarness,
  isNativeDangerPermission,
  resolveHarnessName,
} from './harnesses/registry.ts';
import type { ActivityEvent, NormalizedPermission } from './harnesses/types.ts';
import { delegationHint, stripMarker } from './hint.ts';
import { NotifyBatcher } from './notify.ts';
import { type FeedEntry, progressWindow } from './progress.ts';
import { formatFanoutChip, multiProgressWindow, type RunRow } from './progress-multi.ts';
import { runHarness } from './runner.ts';
import { type DelegateTemplate, loadTemplates, resolveNativePermission } from './templates.ts';
import { mapClaudeUsage } from './usage.ts';

/** Render a possibly-unknown cost — `null` means the harness didn't report one, not a measured $0. */
function formatCost(cost: number | null): string {
  return cost !== null ? `$${cost.toFixed(3)}` : '$—';
}

interface DelegateOptions {
  harness?: string;
  task: string;
  mode?: string;
  scope?: string;
  model?: string;
  maxBudgetUsd?: number;
  allowDangerous?: boolean;
  sessionId?: string;
  pr?: string;
  /**
   * Host-run verification command override — takes precedence over the template's `verify`
   * frontmatter. Internal engine option only, not exposed on the `delegate` tool's schema — see
   * the trust-model note on `runVerify` below for why.
   */
  verify?: string;
  onStream?: (text: string) => void;
  onActivity?: (ev: ActivityEvent) => void;
  signal?: AbortSignal;
  /** Queue for a concurrency slot instead of failing fast when at capacity — fan-out only, see
   *  `acquireSlot` in concurrency.ts. Single-harness runs leave this false (the default). */
  waitForSlot?: boolean;
  /** Called once this run has acquired its concurrency slot and is about to actually start —
   *  fan-out uses it to flip a row from "queued" to "running". */
  onAcquired?: () => void;
}

/** Verify commands run on the host after the harness exits — bounded independent of harness timeoutMs. */
const VERIFY_TIMEOUT_MS = 5 * 60_000;
/** How long the fan-out overlay lingers on the finished board after the last run resolves, so a
 *  user who looked away still catches the final state instead of it clearing instantly. */
const FANOUT_LINGER_MS = 3000;

/**
 * Run a verify command in-process on the host (never delegated to the harness). Report-only —
 * callers must not let this flip a run's `isError`.
 *
 * Trust model: a verify command can only come from two places — on-disk template frontmatter
 * (project-local templates are already behind `isTrusted()`) or a human typing `/delegate
 * --verify=<cmd>` at the CLI. It is deliberately **not** a `delegate` tool parameter: a tool
 * param is set by the model, whose context includes repo content and delegated-harness output —
 * both attacker-influenceable, so a model-settable `verify` would be a prompt-injection ->
 * arbitrary-host-command path (e.g. injected text in a reviewed file steering the parent agent
 * into `delegate({verify: "curl ... | sh"})`). A model that wants verification selects a
 * template that declares one instead.
 *
 * `resolveVerifyPlan` additionally never lets a verify command run on a `readonly` permission —
 * `readonly` guarantees no execution/modification, and a verify command riding along on one
 * would silently break that guarantee (a permission-tier bypass), independent of how trusted its
 * source is. See the matching Conventions entry in AGENTS.md.
 *
 * Runs via `sh -c` (not a fixed binary+argv) so compound commands like `bun test && bun run
 * lint` work — safe only because of the source/permission restrictions above, not because the
 * command itself is sanitized.
 */
async function runVerify(pi: ExtensionAPI, cwd: string, command: string): Promise<VerifyResult> {
  try {
    const res = await pi.exec('sh', ['-c', command], { cwd, timeout: VERIFY_TIMEOUT_MS });
    return buildVerifyResult(command, res.code, `${res.stdout}${res.stderr}`);
  } catch (err) {
    return buildVerifyResult(command, 1, err instanceof Error ? err.message : String(err));
  }
}

async function closeWhenMounted(getClose: () => (() => void) | null, capMs: number): Promise<void> {
  const close = getClose();
  if (close) {
    close();
    return;
  }
  await new Promise<void>(resolve => {
    const start = Date.now();
    const timer = setInterval(() => {
      const fn = getClose();
      if (fn || Date.now() - start > capMs) {
        clearInterval(timer);
        fn?.();
        resolve();
      }
    }, 20);
  });
}

function outputsDirFor(harness: string): string {
  return getOutputsDir(harness);
}

function formatTemplateRow(t: DelegateTemplate): string {
  const parts = [
    t.name,
    `[${t.permission}]`,
    t.model ? `model=${t.model}` : '',
    t.defaultTask ? '↳ default task' : '',
    t.harness ? `(${t.harness})` : '',
  ];
  return `${parts.filter(Boolean).join('  ')}  —  ${t.description}`;
}

async function showModes(ctx: ExtensionContext, harnessFilter?: string): Promise<void> {
  const all = new Map<string, DelegateTemplate>();
  // collect from all harnesses if no filter
  if (harnessFilter) {
    for (const [k, v] of loadTemplates(ctx.cwd, harnessFilter)) all.set(k, v);
  } else {
    for (const h of [...HARNESS_NAMES, 'shared']) {
      for (const [k, v] of loadTemplates(ctx.cwd, h)) if (!all.has(k)) all.set(k, v);
    }
    // also load without harness param
    for (const [k, v] of loadTemplates(ctx.cwd)) if (!all.has(k)) all.set(k, v);
  }
  const rows = [...all.values()].map(formatTemplateRow);
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

interface HistoryEntry {
  file: string;
  mode: string;
  harness: string;
  cost: number | null;
  sessionId: string | null;
  mtime: number;
}

function readHistory(dir: string, harness: string): HistoryEntry[] {
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

function readAllHistory(): HistoryEntry[] {
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

async function viewTranscript(ctx: ExtensionContext, entry: HistoryEntry): Promise<void> {
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

function saveOutput(harness: string, mode: string, text: string): string {
  const dir = outputsDirFor(harness);
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(dir, `${stamp}-${safeSegmentName(mode)}.md`);
  writeFileSync(file, text, 'utf8');
  return file;
}

async function showHistory(ctx: ExtensionContext, harnessFilter?: string): Promise<void> {
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

async function showStatus(ctx: ExtensionContext, harnessFilter?: string): Promise<void> {
  const { config: cfg, source } = loadConfigWithSource();
  const detection = await detectAll();
  const allHarnesses = harnessFilter ? [harnessFilter].filter(h => isKnownHarness(h)) : HARNESS_NAMES;
  const lines: string[] = [];
  lines.push(`delegate — status${harnessFilter ? ` (${harnessFilter})` : ''}`);
  lines.push(...describeConfigSource(source));
  lines.push(`defaultHarness: ${cfg.defaultHarness} · defaultMode: ${cfg.defaultMode} · model: ${cfg.model ?? '—'}`);
  lines.push(
    `maxConcurrent: ${typeof cfg.maxConcurrent === 'number' ? cfg.maxConcurrent : JSON.stringify(cfg.maxConcurrent)} · maxTranscripts: ${cfg.maxTranscripts}`,
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
      templates = loadTemplates(ctx.cwd, h).size;
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
async function showConfig(ctx: ExtensionContext): Promise<void> {
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
 * merged with whatever was already on disk) into the `delegate` key via `writeDelegateConfig()`
 * (read-modify-write, atomic, refuses on an unparseable file rather than clobbering it). This is
 * also the practical fix for the legacy-`claudeDelegate`-only gap `describeConfigSource` warns
 * about: writing an explicit `delegate` key (with the correctly-resolved values already folded
 * in — the legacy migration already ran before this point) makes it win from then on, without
 * this command ever touching or deleting the old `claudeDelegate` key itself.
 */
async function initConfig(ctx: ExtensionContext): Promise<void> {
  const result = loadConfigWithSource();
  const write = writeDelegateConfig(result.config);
  const msg = write.ok ? `✓ ${write.message}` : `✗ ${write.message}`;
  if (!ctx.hasUI) process.stdout.write(`${msg}\n`);
  else ctx.ui.notify?.(msg, write.ok ? 'info' : 'warning');
}

function buildPrompt(
  template: DelegateTemplate,
  task: string,
  scopeText: string | null,
  cwd: string,
  harness: string,
): string {
  let prompt = [
    `You are being delegated a subtask by the pi coding agent.`,
    `Working directory: ${cwd}`,
    `Harness: ${harness}`,
    `Mode: ${template.name}`,
    ``,
    template.prompt,
  ].join('\n');
  prompt += `\n\n# Task\n${task}`;
  if (scopeText) prompt += `\n\n# Scope\n${scopeText}`;
  if (template.skill) prompt += `\n\nUse the "${template.skill}" skill.`;
  return prompt;
}

async function delegate(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  opts: DelegateOptions,
): Promise<{
  content: string;
  details: Record<string, unknown>;
  result: import('./harnesses/types.ts').StreamedResult & { streamedText: string; harness: string };
  activityLog: string[];
  verify?: VerifyResult;
}> {
  const config = loadConfig();
  const harnessName = opts.harness ?? config.defaultHarness ?? 'claude';
  const harness = getHarness(harnessName);
  if (!harness)
    throw new Error(
      `unknown harness "${harnessName}". Available: ${HARNESS_NAMES.join(', ')} (aliases: ${Object.keys(ALIASES).join(', ')})`,
    );
  const templates = loadTemplates(ctx.cwd, harnessName);
  const mode = opts.mode || config.defaultMode;
  const template = templates.get(mode);
  if (!template)
    throw new Error(
      `unknown delegate mode "${mode}" for harness "${harnessName}". Available: ${[...templates.keys()].sort().join(', ')}`,
    );
  const task = opts.task || template.defaultTask;
  if (!task) throw new Error(`delegate mode "${mode}" requires a task`);

  // Fail-fast, before acquireSlot()/spawn — configuring e.g. transport:'acp' for a harness with no
  // ACP surface (or 'stdout' for an ACP-only one) should error immediately with a clear message,
  // not spawn the process and surface a cryptic native failure. See config.ts's resolveTransport.
  const transport = resolveTransport(config, harnessName, harness);

  // concurrency guard — see concurrency.ts. Single runs (waitForSlot unset) fail fast at capacity,
  // exactly as before; fan-out passes waitForSlot:true to queue instead.
  const release = await acquireSlot({
    harness: harnessName,
    mode,
    config,
    wait: opts.waitForSlot ?? false,
    signal: opts.signal,
  });
  opts.onAcquired?.();

  let scopeText: string | null = opts.scope ?? null;
  if (opts.scope === 'diff') {
    const diff = await pi.exec('git', ['diff', 'HEAD'], { cwd: ctx.cwd });
    scopeText = diff.stdout
      ? `Current git diff (working tree vs HEAD):\n${diff.stdout}`
      : 'No git diff vs HEAD (working tree clean).';
  } else if (opts.scope === 'pr' || opts.pr) {
    const target = opts.pr ?? '';
    const pr = await pi.exec('gh', target ? ['pr', 'diff', target] : ['pr', 'diff'], { cwd: ctx.cwd });
    scopeText = pr.stdout
      ? `Pull request diff (${target || 'current branch'}):\n${pr.stdout}`
      : `Could not resolve the PR diff${pr.stderr ? ` — ${pr.stderr.trim().slice(0, 300)}` : ''}.`;
  }

  // permission: normalized, danger requires explicit per-call allowDangerous:true
  let permission: NormalizedPermission = template.permission;
  const nativePerm = template.nativePermission;
  const isNativeDanger = isNativeDangerPermission(harness, nativePerm);
  if (template.permission === 'danger' || isNativeDanger) {
    if (opts.allowDangerous !== true) {
      throw new Error(
        `template "${mode}" requires danger permission — pass allowDangerous:true to run it (never a default)`,
      );
    }
    permission = 'danger';
  } else if (opts.allowDangerous === true) {
    // explicit per-call escalation for any template
    permission = 'danger';
  }
  const permissionForDisplay = nativePerm ?? permission;
  // Dropped when an explicit escalation moved us off the template's own tier — see
  // resolveNativePermission(). Applies to both transports.
  const nativePermissionForRun = resolveNativePermission(template.permission, permission, nativePerm);

  const model = resolveModelForHarness(config, harnessName, opts.model, template.model);
  const prompt = buildPrompt(template, task, scopeText, ctx.cwd, harnessName);

  const activityEvents: ActivityEvent[] = [];
  let streamedFull = '';
  let result: import('./runner.ts').HarnessResult;
  try {
    const baseRunOpts = {
      harness,
      prompt,
      cwd: ctx.cwd,
      permission,
      model,
      maxBudgetUsd:
        opts.maxBudgetUsd ??
        template.maxBudgetUsd ??
        config.maxBudgetUsd ??
        config.harnesses[harnessName]?.maxBudgetUsd,
      signal: opts.signal,
      timeoutMs: config.harnesses[harnessName]?.timeoutMs ?? config.timeoutMs,
      resumeSessionId: opts.sessionId,
      onStream: (t: string) => {
        streamedFull += t;
        opts.onStream?.(t);
      },
      onActivity: (ev: ActivityEvent) => {
        activityEvents.push(ev);
        opts.onActivity?.(ev);
      },
      nativePermission: nativePermissionForRun,
    };
    result =
      transport === 'acp'
        ? await runAcpHarness({ ...baseRunOpts, harness: acpView(harness) })
        : await runHarness(baseRunOpts);
  } catch (err) {
    release();
    if (streamedFull.length > 0) {
      try {
        saveOutput(
          harnessName,
          `${mode}-partial`,
          buildTranscript({
            harness: harnessName,
            mode: `${mode} (partial)`,
            permission: permission,
            nativePermission: nativePerm ?? undefined,
            model: model ?? null,
            cwd: ctx.cwd,
            sessionId: null,
            resumed: Boolean(opts.sessionId),
            numTurns: null,
            totalCostUsd: null,
            isError: true,
            stopReason: null,
            durationMs: null,
            usage: null,
            contextPercent: null,
            contextWindow: null,
            activityLog: collectActivityLog(activityEvents),
            output: streamedFull,
          }),
        );
      } catch (_e) {
        void _e;
      }
    }
    throw err;
  }
  release();

  if (result.isError && !result.result && !result.streamedText)
    throw new Error(`${harnessName} reported an error and produced no output`);

  const actualModel = result.model ?? model ?? null;
  const promptTokens =
    result.usage === null
      ? null
      : result.usage.inputTokens + result.usage.cacheCreationInputTokens + result.usage.cacheReadInputTokens;
  const contextPercent =
    promptTokens !== null && result.contextWindow ? (promptTokens / result.contextWindow) * 100 : null;

  // Host-run post-hoc verification — report-only evidence, never flips `result.isError`. Never
  // actually executes on a readonly permission (permission-tier bypass) — recorded as skipped
  // instead of silently dropped. See the trust-model note on runVerify().
  const verifyPlan = resolveVerifyPlan(opts.verify, template.verify, permission);
  const verify = verifyPlan
    ? verifyPlan.skip
      ? skipVerifyResult(verifyPlan.command, 'readonly run')
      : await runVerify(pi, ctx.cwd, verifyPlan.command)
    : undefined;

  const file = saveOutput(
    harnessName,
    mode,
    buildTranscript({
      harness: harnessName,
      mode: mode,
      permission: permission,
      nativePermission: nativePerm ?? undefined,
      model: actualModel,
      cwd: ctx.cwd,
      sessionId: result.sessionId,
      resumed: Boolean(opts.sessionId),
      numTurns: result.numTurns,
      totalCostUsd: result.totalCostUsd,
      isError: result.isError,
      stopReason: result.stopReason,
      durationMs: result.durationMs,
      usage: result.usage,
      contextPercent,
      contextWindow: result.contextWindow,
      activityLog: collectActivityLog(activityEvents),
      output: result.result || result.streamedText,
      verify,
    }),
  );
  pruneOutputs(outputsDirFor(harnessName), config.maxTranscripts);
  // also prune legacy if claude
  if (harnessName === 'claude') pruneOutputs(legacyOutputsDir(), config.maxTranscripts);

  return {
    content: result.result || result.streamedText || '(empty result)',
    details: {
      harness: harnessName,
      mode,
      permission,
      nativePermission: nativePerm ?? null,
      permissionMode: String(permissionForDisplay),
      model: actualModel,
      numTurns: result.numTurns,
      totalCostUsd: result.totalCostUsd,
      sessionId: result.sessionId,
      stopReason: result.stopReason,
      permissionDenials: result.permissionDenials,
      isError: result.isError,
      resumed: Boolean(opts.sessionId),
      file,
      durationMs: result.durationMs,
      ttftMs: result.ttftMs,
      contextWindow: result.contextWindow,
      contextPercent,
      promptTokens,
      usage: result.usage,
      verify,
    },
    result,
    activityLog: collectActivityLog(activityEvents),
    verify,
  };
}

function summarize(content: string, max = 30_000): { text: string; truncated: boolean } {
  if (content.length <= max) return { text: content, truncated: false };
  return { text: `${content.slice(0, max)}\n…[truncated — full output saved to file]`, truncated: true };
}

interface PendingReport {
  content: string;
  details: Record<string, unknown>;
}
let pendingReport: PendingReport | null = null;
function injectReport(
  _ctx: ExtensionContext,
  opts: {
    harness: string;
    mode: string;
    metrics: string;
    body: string;
    file?: string;
    sessionId?: string;
    verify?: VerifyResult;
  },
): void {
  pendingReport = {
    content: buildReportContent({
      harness: opts.harness,
      mode: opts.mode,
      metrics: opts.metrics,
      body: opts.body,
      file: opts.file,
      sessionId: opts.sessionId,
      verify: opts.verify,
    }),
    details: {
      harness: opts.harness,
      mode: opts.mode,
      file: opts.file,
      sessionId: opts.sessionId,
      metrics: opts.metrics,
    },
  };
}

interface ToolProgressUpdate {
  content: { type: string; text: string }[];
  details: { progress: number };
}

/**
 * `delegate` tool params. Deliberately has no `verify` field — a tool param is model-controlled,
 * and the model's context (repo content, delegated-harness output) is attacker-influenceable, so
 * a model-settable verify command would be a prompt-injection -> arbitrary-host-command path.
 * Verify only comes from on-disk template frontmatter or a human-typed `/delegate --verify=`.
 */
interface DelegateToolParams {
  harness?: string;
  task: string;
  mode?: string;
  scope?: string;
  model?: string;
  maxBudgetUsd?: number;
  allowDangerous?: boolean;
  sessionId?: string;
  pr?: string;
}

/** One `delegate()` call with the tool's live-feed progress reporting (`onUpdate`). Shared by the
 *  single-harness tool path and the fan-out loop — `labelPrefix` tags fan-out feed lines by harness. */
async function runDelegateForTool(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  config: DelegateConfig,
  callOpts: DelegateOptions,
  signal: AbortSignal | undefined,
  onUpdate: ((u: ToolProgressUpdate) => void) | undefined,
  labelPrefix: string,
): Promise<Awaited<ReturnType<typeof delegate>>> {
  const feed: string[] = [];
  const feedIndex = new ToolCallIndex();
  let liveTail = '';
  let thinkingChars = 0;
  let lastPushAt = 0;
  const THROTTLE_MS = 250;
  const pushFeed = () => {
    const now = Date.now();
    if (now - lastPushAt < THROTTLE_MS) return;
    lastPushAt = now;
    const lines: string[] = [...feed.slice(-6)];
    if (thinkingChars > 0)
      lines.push(config.inspectThinking ? `💭 thinking… (${thinkingChars} chars)` : '💭 thinking…');
    if (liveTail) lines.push(`✍ ${liveTail}`);
    if (lines.length === 0) return;
    onUpdate?.({
      content: [{ type: 'text', text: lines.map(l => `${labelPrefix}${l}`).join('\n') }],
      details: { progress: 0.5 },
    });
  };
  return delegate(pi, ctx, {
    ...callOpts,
    signal,
    onStream: t => {
      liveTail = (liveTail + t).slice(-400);
      pushFeed();
    },
    onActivity: ev => {
      if (ev.kind === 'tool_input') {
        feed.push(`▶ ${formatToolUse(ev.name, ev.input)}`);
        feedIndex.set(ev.id, feed.length - 1);
        if (feed.length > 40) {
          const removed = feed.length - 40;
          feed.splice(0, removed);
          feedIndex.shift(removed);
        }
      } else if (ev.kind === 'tool_result') {
        const idx = feedIndex.resolve(ev.id, feed.length - 1);
        if (idx >= 0 && feed[idx]?.startsWith('▶')) feed[idx] += ev.isError ? ' ✗' : ' ✓';
      } else if (ev.kind === 'thinking') thinkingChars += ev.chars;
      pushFeed();
    },
  });
}

/** `delegate({harness:"all"|"a,b"})` — resolve the requested harnesses to detected installs, run the
 *  existing `delegate()` engine concurrently across all of them (bounded by `maxConcurrent` via
 *  `acquireSlot({wait:true})` — see concurrency.ts), and mechanically synthesize one comparison
 *  report ordered by the resolved harness list regardless of completion order. No second model call. */
async function runFanoutTool(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  config: DelegateConfig,
  params: DelegateToolParams,
  signal: AbortSignal | undefined,
  onUpdate: ((u: ToolProgressUpdate) => void) | undefined,
): Promise<{ content: { type: string; text: string }[]; details: Record<string, unknown>; usage?: unknown }> {
  const detection = await detectAll();
  const { resolved, unknown, skipped } = resolveHarnessList(params.harness ?? 'all', {
    knownHarnesses: HARNESS_NAMES,
    aliasOf: resolveHarnessName,
    isKnown: isKnownHarness,
    detection,
  });
  if (resolved.length === 0) {
    throw new Error(
      `no harness available to fan out to (unknown: ${unknown.join(', ') || '—'}; not installed: ${skipped.join(', ') || '—'})`,
    );
  }

  const mode = params.mode ?? config.defaultMode;

  type TaskResult = FanoutRunSummary & {
    usage?: import('./harnesses/types.ts').StreamedUsage | null;
  };
  const tasks = resolved.map(async (h): Promise<TaskResult> => {
    onUpdate?.({ content: [{ type: 'text', text: `[${h}] queued…` }], details: { progress: 0.5 } });
    try {
      const run = await runDelegateForTool(
        pi,
        ctx,
        config,
        {
          harness: h,
          task: params.task,
          mode: params.mode,
          scope: params.scope,
          model: params.model,
          maxBudgetUsd: params.maxBudgetUsd,
          allowDangerous: params.allowDangerous === true,
          sessionId: params.sessionId,
          pr: params.pr,
          // no verify: intentionally not model-settable — see DelegateToolParams
          waitForSlot: true,
          onAcquired: () =>
            onUpdate?.({ content: [{ type: 'text', text: `[${h}] running…` }], details: { progress: 0.5 } }),
        },
        signal,
        onUpdate,
        `[${h}] `,
      );
      const summary = summarize(run.content);
      return {
        harness: h,
        ok: !run.result.isError,
        metrics: formatMetrics({
          numTurns: run.result.numTurns,
          totalCostUsd: run.result.totalCostUsd,
          promptTokens: 0,
          contextPercent: typeof run.details.contextPercent === 'number' ? run.details.contextPercent : null,
          durationMs: run.result.durationMs,
        }),
        cost: run.result.totalCostUsd,
        body: summary.text,
        file: (run.details.file as string) ?? undefined,
        sessionId: (run.details.sessionId as string) ?? undefined,
        verify: run.verify,
        usage: run.result.usage,
      };
    } catch (err) {
      return { harness: h, ok: false, cost: null, error: err instanceof Error ? err.message : String(err) };
    }
  });

  const settled = await Promise.all(tasks);
  const runs = orderFanoutResults(resolved, settled);

  let sumInput = 0;
  let sumOutput = 0;
  let sumCacheCreate = 0;
  let sumCacheRead = 0;
  let sumCost = 0;
  let anyCostKnown = false;
  for (const r of runs) {
    if (r.usage) {
      sumInput += r.usage.inputTokens;
      sumOutput += r.usage.outputTokens;
      sumCacheCreate += r.usage.cacheCreationInputTokens;
      sumCacheRead += r.usage.cacheReadInputTokens;
    }
    if (r.cost !== null) {
      sumCost += r.cost;
      anyCostKnown = true;
    }
  }

  const report = buildFanoutReport({ runs, skipped, unknown });
  const okCount = runs.filter(r => r.ok).length;
  const head = `## delegate all — ${mode} (${okCount}/${runs.length} ok)`;
  const usage = mapClaudeUsage({
    inputTokens: sumInput,
    outputTokens: sumOutput,
    cacheCreationInputTokens: sumCacheCreate,
    cacheReadInputTokens: sumCacheRead,
    totalCostUsd: anyCostKnown ? sumCost : null,
  });
  return {
    content: [{ type: 'text', text: `${head}\n\n${report}` }],
    details: { fanout: true, harness: 'all', mode, harnesses: resolved, skipped, unknown, runs },
    usage,
  };
}

export default function (pi: ExtensionAPI) {
  let activeRunId = 0;
  let activeOverlay: { show(): void; focus(): void; runId: number } | null = null;

  // ── Tools ────────────────────────────────────────────────────────────────
  const delegateToolDef = {
    name: 'delegate',
    label: 'Delegate',
    description:
      'Delegate a task to any harness (claude, codex, opencode, amp, devin) running headless in the repo and return its streamed report (cost, token usage, context %, session id). harness selects the backend (default from config, fallback claude) — pass "all" or a comma list (e.g. "claude,codex") to fan out the same task to several harnesses and get back one comparison report. mode selects a template: review, plan, implement, security-audit, docs, general, or custom — some templates run a host-side check (e.g. "bun test") after the harness exits and report pass/fail as separate evidence; that is configured on the template, not a parameter here. scope restricts work: diff for current git diff, pr for PR diff, path list, or whole repo. sessionId continues a prior session.',
    promptSnippet: 'Delegate a subtask to a harness and return its report',
    promptGuidelines: [
      'delegate runs a harness headless in the working directory and returns a streamed report with cost, token usage, and a session id for follow-ups.',
      'Pass harness (claude|codex|opencode|amp|devin) + focused task string + intent and constraints. Use scope: diff for current git diff, pr for PR diff, path list, or omit for whole repo.',
      'mode selects the template and its permission level: review/plan/security-audit are readonly; implement/docs/general are edit. Custom template names also work. Some templates verify their own work (e.g. running tests) automatically after the harness finishes — that is not something you configure here.',
      'harness: "all" or a comma list (e.g. "codex,opencode") fans the same task out to each detected harness and returns one synthesized comparison report — costs multiply, so only use it when the user actually wants a multi-harness comparison.',
      'sessionId resumes a previous delegated session instead of starting fresh.',
      'Do not set allowDangerous unless the user explicitly asks for unrestricted access (danger permission).',
    ],
    parameters: Type.Object({
      harness: Type.Optional(
        Type.String({
          description:
            'Harness to use: claude, codex, opencode, amp (aliases: omp), devin. "all" or a comma list (e.g. "claude,codex") fans out to each detected harness. Defaults to config defaultHarness.',
        }),
      ),
      task: Type.String({ description: 'The task/intent to delegate. Be specific.' }),
      mode: Type.Optional(
        Type.String({
          description:
            'Template/mode to run: review, plan, implement, security-audit, docs, general, or custom. Defaults to config defaultMode.',
        }),
      ),
      scope: Type.Optional(
        Type.String({
          description:
            'Restrict the work: diff (git diff), pr (PR diff), comma/space-separated path list, or omit for whole repo.',
        }),
      ),
      model: Type.Optional(
        Type.String({ description: 'Model (e.g. sonnet, opus, gpt-5). Defaults to template/config.' }),
      ),
      maxBudgetUsd: Type.Optional(Type.Number({ description: 'Hard spend cap in USD for the run.' })),
      sessionId: Type.Optional(
        Type.String({
          description: 'Resume an existing delegated session (pass its session id from a previous run details).',
        }),
      ),
      allowDangerous: Type.Optional(
        Type.Boolean({
          description: 'Escalate to danger permission (unrestricted). Only with explicit user approval.',
        }),
      ),
      pr: Type.Optional(Type.String({ description: 'GitHub PR number/URL (alternative to scope pr).' })),
      // Deliberately no `verify` param — see the trust-model comment on DelegateToolParams/runVerify.
    }),
    async execute(
      _toolCallId: string,
      params: DelegateToolParams,
      signal: AbortSignal | undefined,
      onUpdate: ((u: ToolProgressUpdate) => void) | undefined,
      ctx: ExtensionContext,
    ) {
      const config = loadConfig();
      if (params.harness && isFanoutSpec(params.harness)) {
        return runFanoutTool(pi, ctx, config, params, signal, onUpdate);
      }
      const { content, details, result } = await runDelegateForTool(
        pi,
        ctx,
        config,
        {
          harness: params.harness,
          task: params.task,
          mode: params.mode,
          scope: params.scope,
          model: params.model,
          maxBudgetUsd: params.maxBudgetUsd,
          allowDangerous: params.allowDangerous === true, // invariant: never inherit from config.allowDangerous — danger requires explicit per-call approval
          sessionId: params.sessionId,
          pr: params.pr,
          // no verify: intentionally not model-settable — see DelegateToolParams
        },
        signal,
        onUpdate,
        '',
      );
      const summary = summarize(content);
      const resumed = details.resumed ? ' · resumed' : '';
      const head = result.isError
        ? `⚠ ${details.harness} reported an error`
        : `${details.harness} ${details.mode} (${result.numTurns ?? '—'} turn(s), ${formatCost(result.totalCostUsd)})${resumed}`;
      const body = result.isError ? `\n${summary.text}` : `\n\n${summary.text}`;
      const footer = summary.truncated ? `\nFull output: ${details.file}` : `\nTranscript: ${details.file}`;
      (details as Record<string, unknown>).markdown = summary.text;
      return {
        content: [{ type: 'text', text: `${head}${body}${footer}` }],
        details,
        usage: result.usage ? mapClaudeUsage({ ...result.usage, totalCostUsd: result.totalCostUsd }) : undefined,
      };
    },
    renderCall(args: unknown, theme: { fg: (c: string, s: string) => string; bg: (c: string, s: string) => string }) {
      const params = args as { harness?: string; mode?: string; task?: string };
      const harness = params.harness ?? 'delegate';
      const mode = params.mode ?? 'general';
      const task = params.task ?? '';
      const taskStr = task ? ` — ${task.length > 60 ? `${task.slice(0, 59)}…` : task}` : '';
      return new Text(theme.fg('accent', `${harness} ${mode}`) + theme.fg('dim', taskStr), 1, 1, s =>
        theme.bg('toolPendingBg', s),
      );
    },
    renderResult(
      result: { content?: { type: string; text: string }[]; details?: Record<string, unknown> },
      options: { isPartial: boolean },
      theme: { fg: (c: string, s: string) => string; bg: (c: string, s: string) => string },
    ) {
      if (options.isPartial) {
        const text = (result.content ?? [])
          .filter(c => c.type === 'text')
          .map(c => c.text)
          .join('\n');
        return new Text(text, 1, 1, s => theme.bg('toolPendingBg', s));
      }
      const details = (result.details ?? {}) as Record<string, unknown>;
      const harness = typeof details.harness === 'string' ? details.harness : 'delegate';
      const mode = typeof details.mode === 'string' ? details.mode : 'delegate';
      const cost = typeof details.totalCostUsd === 'number' ? details.totalCostUsd : null;
      const turns = typeof details.numTurns === 'number' ? details.numTurns : null;
      const isError = details.isError === true;
      const resumed = details.resumed === true;
      const file = typeof details.file === 'string' ? details.file : null;
      const sessionId = typeof details.sessionId === 'string' ? details.sessionId : null;
      const container = new Container();
      container.addChild(
        new Text(
          theme.fg(isError ? 'error' : 'accent', `${harness} ${mode}`) +
            theme.fg('dim', ` · ${turns ?? '—'} turn(s) · `) +
            theme.fg('warning', formatCost(cost)) +
            (resumed ? theme.fg('dim', ' · resumed') : ''),
          1,
          1,
        ),
      );
      const md = typeof details.markdown === 'string' && details.markdown ? details.markdown : null;
      if (md) container.addChild(new Markdown(md, 1, 1, getMarkdownTheme()));
      else {
        const text = (result.content ?? [])
          .filter(c => c.type === 'text')
          .map(c => c.text)
          .join('\n');
        container.addChild(new Text(text, 1, 1));
      }
      const foot: string[] = [];
      if (file) foot.push(`Transcript: ${file}`);
      if (sessionId) foot.push(`Resume: /delegate --resume=${sessionId} <prompt>`);
      if (foot.length > 0) container.addChild(new Text(theme.fg('dim', foot.join('   ')), 1, 1));
      return container;
    },
  };

  // SAFETY: delegateToolDef satisfies registerTool params via TypeBox, widened for alias registration
  pi.registerTool(delegateToolDef as unknown as Parameters<typeof pi.registerTool>[0]); // SAFETY: delegateToolDef satisfies registerTool params

  // deprecated alias
  pi.registerTool({
    name: 'claude_delegate',
    label: 'Claude Delegate (deprecated)',
    description:
      'Deprecated alias for delegate{harness:claude}. Use delegate tool with harness:claude instead. ' +
      (delegateToolDef as { description: string }).description,
    promptSnippet: 'Delegate a subtask to Claude Code (deprecated alias)',
    // SAFETY: delegateToolDef promptGuidelines is string[] from literal, safe to spread
    promptGuidelines: [...(delegateToolDef as unknown as { promptGuidelines: string[] }).promptGuidelines], // SAFETY: promptGuidelines is string[]
    parameters: (delegateToolDef as { parameters: unknown }).parameters as never,
    async execute(
      toolCallId: string,
      params: DelegateToolParams,
      signal: AbortSignal | undefined,
      onUpdate: never,
      ctx: ExtensionContext,
    ) {
      return (
        // SAFETY: deprecated alias delegates to primary tool, shape identical
        (
          delegateToolDef as unknown as {
            // SAFETY: alias shape identical
            execute: (a: string, b: unknown, c: unknown, d: unknown, e: unknown) => Promise<unknown>;
          }
        ).execute(toolCallId, { ...params, harness: 'claude' }, signal, onUpdate, ctx)
      );
    },
    // SAFETY: delegateToolDef renderCall matches expected signature
    renderCall: (delegateToolDef as unknown as { renderCall: (a: unknown, b: unknown) => unknown }).renderCall, // SAFETY: matches signature
    // SAFETY: delegateToolDef renderResult matches expected signature
    renderResult: (delegateToolDef as unknown as { renderResult: (a: unknown, b: unknown, c: unknown) => unknown }) // SAFETY: matches signature
      .renderResult,
    // SAFETY: final alias tool matches registerTool overload
  } as unknown as Parameters<typeof pi.registerTool>[0]); // SAFETY: alias tool matches overload

  // ── Commands ─────────────────────────────────────────────────────────────

  /** One `delegate()` call with the command's progress-window UI (spinner, cancel, minimize).
   *  Shared by the single-harness `/delegate` path and the fan-out loop, one call per harness. */
  const runOneDelegation = async (
    ctx: ExtensionContext,
    opts: {
      harnessName: string;
      mode?: string;
      task: string;
      scope?: string;
      model?: string;
      budget?: number;
      sessionId?: string;
      pr?: string;
      verify?: string;
      template?: DelegateTemplate;
      isDanger: boolean;
    },
  ): Promise<{
    result: Awaited<ReturnType<typeof delegate>> | null;
    error: Error | null;
    cancelled: boolean;
  }> => {
    const { harnessName, mode, task, scope, model, budget, sessionId, pr, verify, template, isDanger } = opts;
    const modeForDisplay = mode ?? 'general';

    const feed: FeedEntry[] = [];
    const feedIndex = new ToolCallIndex();
    let thinkingChars = 0;
    let liveTail = '';
    let requestRender: (() => void) | null = null;
    const getEntries = (): FeedEntry[] => {
      const entries = [...feed.slice(-12)];
      if (thinkingChars > 0) entries.push({ kind: 'thinking', text: '💭 thinking…' });
      if (liveTail) entries.push({ kind: 'text', text: liveTail.slice(-200) });
      return entries;
    };
    let chipActivity = '';
    let chipActivityId: string | undefined;
    let chipLastPush = 0;
    const pushChip = () => {
      if (!ctx.hasUI) return;
      const now = Date.now();
      if (now - chipLastPush < 500) return;
      chipLastPush = now;
      const theme = ctx.ui.theme;
      const activity = chipActivity ? ` ${chipActivity}` : theme.fg('dim', ' running…');
      ctx.ui.setStatus(
        'delegate',
        theme.fg('accent', '●') + theme.fg('dim', ` ${harnessName} ${modeForDisplay}`) + activity,
      );
    };
    const onActivity = (ev: ActivityEvent) => {
      if (ev.kind === 'tool_input') {
        chipActivity = `▶ ${formatToolUse(ev.name, ev.input)}`;
        chipActivityId = ev.id;
        feed.push({ kind: 'tool', text: formatToolUse(ev.name, ev.input), id: ev.id });
        feedIndex.set(ev.id, feed.length - 1);
        if (feed.length > 40) {
          const removed = feed.length - 40;
          feed.splice(0, removed);
          feedIndex.shift(removed);
        }
      } else if (ev.kind === 'tool_result') {
        // only stamp the chip when the result belongs to the tool it's currently showing
        if (chipActivity.startsWith('▶') && (ev.id === undefined || ev.id === chipActivityId))
          chipActivity += ev.isError ? ' ✗' : ' ✓';
        const idx = feedIndex.resolve(ev.id, feed.length - 1);
        if (idx >= 0 && feed[idx]?.kind === 'tool') feed[idx] = { ...feed[idx], ok: !ev.isError };
      } else if (ev.kind === 'thinking') {
        chipActivity = '💭 thinking…';
        chipActivityId = undefined;
        thinkingChars += ev.chars;
      }
      pushChip();
      requestRender?.();
    };
    const ac = new AbortController();
    let cancelled = false;
    const runState: { error: Error | null } = { error: null };
    const runId = ++activeRunId;
    const clearActive = () => {
      if (activeOverlay?.runId === runId) activeOverlay = null;
    };
    const run = delegate(pi, ctx, {
      harness: harnessName,
      task,
      mode,
      scope,
      model,
      maxBudgetUsd: budget,
      sessionId,
      pr,
      verify,
      signal: ac.signal,
      onStream: t => {
        liveTail = (liveTail + t).slice(-400);
        requestRender?.();
      },
      onActivity,
    }).catch((err: unknown) => {
      runState.error = err instanceof Error ? err : new Error(String(err));
      return null;
    });

    let closeWindow: (() => void) | null = null;
    let result: Awaited<ReturnType<typeof delegate>> | null = null;
    if (ctx.hasUI) {
      let overlayHandle: OverlayHandle | null = null;
      const uiPromise = ctx.ui
        .custom(
          (tui, theme, _kb, done) => {
            requestRender = () => tui.requestRender();
            closeWindow = () => done(undefined);
            return progressWindow(tui, theme, {
              mode: `${harnessName} ${modeForDisplay}`,
              model: model ?? template?.model ?? loadConfig().harnesses[harnessName]?.model ?? loadConfig().model,
              startedAt: Date.now(),
              getEntries,
              dangerous: isDanger,
              onCancel: () => {
                cancelled = true;
                ac.abort();
              },
              onMinimize: () => {
                overlayHandle?.setHidden(true);
                overlayHandle?.unfocus();
              },
            });
          },
          {
            overlay: true,
            overlayOptions: { width: '70%', maxHeight: '60%', anchor: 'top-center' },
            onHandle: h => {
              overlayHandle = h;
              activeOverlay = { show: () => h.setHidden(false), focus: () => h.focus(), runId };
              h.focus();
            },
          },
        )
        .catch(() => {});
      result = await run;
      await closeWhenMounted(() => closeWindow, 2000);
      await uiPromise;
    } else {
      result = await run;
    }
    clearActive();
    if (ctx.hasUI) ctx.ui.setStatus('delegate', undefined);
    const failed = cancelled || !result;
    return { result: failed ? null : result, error: runState.error, cancelled };
  };

  interface FanoutSpec {
    harnessName: string;
    task: string;
    scope?: string;
    model?: string;
    budget?: number;
    sessionId?: string;
    pr?: string;
    verify?: string;
    isDanger: boolean;
  }
  interface FanoutOutcome {
    harnessName: string;
    result: Awaited<ReturnType<typeof delegate>> | null;
    error: Error | null;
    cancelled: boolean;
  }

  /** Run `delegate()` concurrently across every spec in one multi-run overlay — the fan-out
   *  counterpart to `runOneDelegation`. Concurrency is bounded by `maxConcurrent`: every run passes
   *  `waitForSlot:true`, so `acquireSlot` (concurrency.ts) queues the ones that don't fit instead of
   *  failing them, and a fan-out never exceeds the configured cap just because it's a fan-out.
   *  Double-ESC cancel aborts every in-flight (and still-queued) run via one shared AbortController. */
  const runFanoutConcurrent = async (ctx: ExtensionContext, mode: string | undefined, specs: FanoutSpec[]) => {
    const ac = new AbortController();
    let cancelledAll = false;
    const runId = ++activeRunId;
    const clearActive = () => {
      if (activeOverlay?.runId === runId) activeOverlay = null;
    };
    const modeForDisplay = mode ?? 'general';
    const anyDanger = specs.some(s => s.isDanger);
    const overallStart = Date.now();
    const rows: RunRow[] = specs.map(s => ({
      harness: s.harnessName,
      startedAt: null,
      status: 'queued',
      activity: '',
      costUsd: null,
    }));
    let requestRender: (() => void) | null = null;

    let chipLastPush = 0;
    const pushChip = () => {
      if (!ctx.hasUI) return;
      const now = Date.now();
      if (now - chipLastPush < 500) return;
      chipLastPush = now;
      const theme = ctx.ui.theme;
      ctx.ui.setStatus(
        'delegate',
        theme.fg('accent', '●') + theme.fg('dim', ` ${formatFanoutChip(rows, now - overallStart)}`),
      );
    };

    const runOne = async (spec: FanoutSpec, idx: number): Promise<FanoutOutcome> => {
      const setRow = (patch: Partial<RunRow>) => {
        rows[idx] = { ...rows[idx], ...patch };
        requestRender?.();
        pushChip();
      };
      let liveTail = '';
      const onActivity = (ev: ActivityEvent) => {
        if (ev.kind === 'tool_input') setRow({ activity: `▶ ${formatToolUse(ev.name, ev.input)}` });
        else if (ev.kind === 'tool_result')
          setRow({
            activity: rows[idx].activity ? `${rows[idx].activity}${ev.isError ? ' ✗' : ' ✓'}` : rows[idx].activity,
          });
        else if (ev.kind === 'thinking') setRow({ activity: '💭 thinking…' });
      };
      const runState: { error: Error | null } = { error: null };
      const run = delegate(pi, ctx, {
        harness: spec.harnessName,
        task: spec.task,
        mode,
        scope: spec.scope,
        model: spec.model,
        maxBudgetUsd: spec.budget,
        sessionId: spec.sessionId,
        pr: spec.pr,
        verify: spec.verify,
        signal: ac.signal,
        waitForSlot: true,
        onAcquired: () => setRow({ status: 'running', startedAt: Date.now() }),
        onStream: t => {
          liveTail = (liveTail + t).slice(-200);
          setRow({ activity: `✍ ${liveTail}` });
        },
        onActivity,
      }).catch((err: unknown) => {
        runState.error = err instanceof Error ? err : new Error(String(err));
        return null;
      });
      const result = await run;
      const failed = cancelledAll || !result;
      // On failure keep context on the row: the reason if we have one, else whatever the run was
      // last doing. Blanking it here would drop the only on-screen hint at *why* it failed.
      const reason = runState.error ? runState.error.message.split('\n')[0].slice(0, 60) : '';
      setRow({
        status: failed ? 'failed' : 'done',
        activity: failed ? reason || rows[idx].activity : '',
        costUsd: !failed && result ? result.result.totalCostUsd : null,
      });
      return {
        harnessName: spec.harnessName,
        result: failed ? null : result,
        error: runState.error,
        cancelled: cancelledAll,
      };
    };

    const allSettled = Promise.all(specs.map((spec, idx) => runOne(spec, idx)));

    let closeWindow: (() => void) | null = null;
    let outcomes: FanoutOutcome[];
    if (ctx.hasUI) {
      let overlayHandle: OverlayHandle | null = null;
      let resolveDismiss = (): void => {};
      const dismissed = new Promise<void>(resolve => {
        resolveDismiss = () => resolve();
      });
      const uiPromise = ctx.ui
        .custom(
          (tui, theme, _kb, done) => {
            requestRender = () => tui.requestRender();
            closeWindow = () => done(undefined);
            return multiProgressWindow(tui, theme, {
              mode: modeForDisplay,
              startedAt: overallStart,
              getRows: () => rows,
              dangerous: anyDanger,
              onCancel: () => {
                cancelledAll = true;
                ac.abort();
              },
              onMinimize: () => {
                overlayHandle?.setHidden(true);
                overlayHandle?.unfocus();
              },
              onDismiss: () => resolveDismiss(),
            });
          },
          {
            overlay: true,
            overlayOptions: { width: '70%', maxHeight: '60%', anchor: 'top-center' },
            onHandle: h => {
              overlayHandle = h;
              activeOverlay = { show: () => h.setHidden(false), focus: () => h.focus(), runId };
              h.focus();
            },
          },
        )
        .catch(() => {});
      outcomes = await allSettled;
      // Cancelling already means "I'm done watching" — skip the linger so the overlay closes
      // right away instead of sitting on a cancelled board for FANOUT_LINGER_MS.
      if (cancelledAll) resolveDismiss();
      // Tear the overlay down after a short linger (or immediately on Esc/m/cancel) — in the
      // background, so this doesn't delay the outcomes we're about to return (and thus the
      // injected report). `activeOverlay` stays valid for `/delegate watch` until this settles.
      void (async () => {
        const timer = setTimeout(() => resolveDismiss(), FANOUT_LINGER_MS);
        timer.unref?.();
        await dismissed;
        clearTimeout(timer);
        await closeWhenMounted(() => closeWindow, 2000);
        await uiPromise;
        clearActive();
        ctx.ui.setStatus('delegate', undefined);
      })();
    } else {
      outcomes = await allSettled;
      clearActive();
    }
    return outcomes;
  };

  /** `/delegate all …` / `/delegate a,b …` — resolve to detected harnesses, run `delegate()`
   *  concurrently across all of them in one multi-run overlay (see `runFanoutConcurrent`), batch
   *  success notifications, and inject one synthesized comparison report ordered by the resolved
   *  harness list regardless of completion order. */
  const runFanoutCommand = async (ctx: ExtensionContext, parsed: ReturnType<typeof parseDelegateCommand>) => {
    const harnessSpec = parsed.harness as string;
    const detection = await detectAll();
    const { resolved, unknown, skipped } = resolveHarnessList(harnessSpec, {
      knownHarnesses: HARNESS_NAMES,
      aliasOf: resolveHarnessName,
      isKnown: isKnownHarness,
      detection,
    });
    if (resolved.length === 0) {
      const msg = `no harness available to fan out to (unknown: ${unknown.join(', ') || '—'}; not installed: ${skipped.join(', ') || '—'})`;
      if (ctx.hasUI) ctx.ui.notify(msg, 'error');
      else process.stderr.write(`${msg}\n`);
      return;
    }

    const modeForReport = parsed.mode ?? loadConfig().defaultMode;
    const batcher = new NotifyBatcher((text, level) => {
      if (ctx.hasUI) ctx.ui.notify(text, level);
      else process.stdout.write(`${text}\n`);
    });

    // Resolve each harness's task/scope/danger flag up front — cheap and synchronous — so a
    // harness that can't even start (e.g. mode needs a prompt) fails immediately instead of
    // occupying a concurrency slot.
    const specs: FanoutSpec[] = [];
    const immediateFailures: FanoutRunSummary[] = [];
    for (const h of resolved) {
      const templates = loadTemplates(ctx.cwd, h);
      const resolvedTaskScope = resolveDefaults(parsed, templates);
      const template = parsed.mode ? templates.get(parsed.mode) : undefined;
      if (!resolvedTaskScope) {
        const message = `mode "${parsed.mode ?? 'general'}" needs a prompt`;
        immediateFailures.push({ harness: h, ok: false, cost: null, error: message });
        batcher.failure(`${h}: ${message}`);
        continue;
      }
      const isDanger =
        template?.permission === 'danger' ||
        (template?.nativePermission
          ? ['bypassPermissions', 'danger-full-access', 'danger'].includes(template.nativePermission)
          : false);
      specs.push({
        harnessName: h,
        task: resolvedTaskScope.task,
        scope: resolvedTaskScope.scope,
        model: parsed.model,
        budget: parsed.budget,
        sessionId: parsed.sessionId,
        pr: parsed.pr,
        verify: parsed.verify,
        isDanger,
      });
    }

    const outcomes = specs.length > 0 ? await runFanoutConcurrent(ctx, parsed.mode, specs) : [];
    const completed: FanoutRunSummary[] = outcomes.map(outcome => {
      if (outcome.cancelled || !outcome.result) {
        const message = outcome.error ? outcome.error.message : outcome.cancelled ? 'cancelled' : 'delegation failed';
        batcher.failure(`${outcome.harnessName}: ${outcome.cancelled ? 'cancelled' : 'failed'} — ${message}`);
        return { harness: outcome.harnessName, ok: false, cost: null, error: message };
      }
      const { content, details, result, verify } = outcome.result;
      const summary = summarize(content);
      const metrics = formatMetrics({
        numTurns: result.numTurns,
        totalCostUsd: result.totalCostUsd,
        promptTokens: 0,
        contextPercent: typeof details.contextPercent === 'number' ? details.contextPercent : null,
        durationMs: typeof details.durationMs === 'number' ? details.durationMs : null,
      });
      batcher.success(`${outcome.harnessName} ${parsed.mode ?? 'general'} — ${metrics}`);
      return {
        harness: outcome.harnessName,
        ok: !result.isError,
        metrics,
        cost: result.totalCostUsd,
        body: summary.text,
        file: (details.file as string) ?? undefined,
        sessionId: (details.sessionId as string) ?? undefined,
        verify,
      };
    });

    const runs = orderFanoutResults(resolved, [...immediateFailures, ...completed]);
    const okCount = runs.filter(r => r.ok).length;
    const report = buildFanoutReport({ runs, skipped, unknown });
    injectReport(ctx, {
      harness: 'all',
      mode: modeForReport,
      metrics: `${okCount}/${runs.length} ok`,
      body: report,
    });
    batcher.flush();
  };

  const makeHandler = (forcedHarness?: string) => async (args: string, ctx: ExtensionContext) => {
    const sub = args.trim();
    const subLower = sub.toLowerCase();
    // status / health / doctor — harness health check
    if (subLower === 'status' || subLower === 'health' || subLower === 'doctor' || subLower === 'check') {
      await showStatus(ctx, forcedHarness);
      return;
    }
    if (
      subLower.startsWith('status ') ||
      subLower.startsWith('health ') ||
      subLower.startsWith('doctor ') ||
      subLower.startsWith('check ')
    ) {
      const maybeH = sub.split(/\s+/)[1]?.toLowerCase();
      const flagMatch = sub.match(/--harness=([^\s]+)/);
      const h =
        forcedHarness ??
        (flagMatch ? flagMatch[1].toLowerCase() : maybeH && isKnownHarness(maybeH) ? maybeH : undefined);
      await showStatus(ctx, h);
      return;
    }
    if (subLower === 'config init') {
      await initConfig(ctx);
      return;
    }
    if (subLower === 'config') {
      await showConfig(ctx);
      return;
    }
    // extract --harness flag for list/history subcommands
    const harnessFlag = sub.match(/--harness=([^\s]+)/)?.[1];
    if (sub === 'watch' || sub === 'show') {
      if (activeOverlay) {
        activeOverlay.show();
        activeOverlay.focus();
      } else {
        ctx.ui.notify?.('No active delegate run to show — start one with /delegate <harness> <mode> <prompt>', 'info');
      }
      return;
    }
    // Shared by list/history: resolve their (optional) harness filter to a canonical name via the
    // same alias/case rules (`omp` -> `amp`, any case), and reject a word that matches nothing —
    // rather than each falling back to silently showing an unfiltered or empty result.
    const filterHarness = (bareWord: string | undefined): string | undefined | 'unknown' => {
      if (forcedHarness) return forcedHarness;
      const resolution = resolveHarnessFilter(harnessFlag ?? bareWord, {
        isKnown: isKnownHarness,
        aliasOf: resolveHarnessName,
      });
      if (resolution.kind === 'unknown') {
        const msg = `unknown harness "${resolution.requested}". Available: ${HARNESS_NAMES.join(', ')} (aliases: ${Object.keys(ALIASES).join(', ')})`;
        if (!ctx.hasUI) process.stdout.write(`${msg}\n`);
        else ctx.ui.notify?.(msg, 'warning');
        return 'unknown';
      }
      return resolution.kind === 'known' ? resolution.harness : undefined;
    };
    if (sub === 'list' || subLower.startsWith('list ')) {
      const h = filterHarness(subLower.startsWith('list ') ? sub.split(/\s+/)[1] : undefined);
      if (h === 'unknown') return;
      await showModes(ctx, h);
      return;
    }
    if (sub === 'history' || sub === 'logs' || subLower.startsWith('history ') || subLower.startsWith('logs ')) {
      const h = filterHarness(
        subLower.startsWith('history ') || subLower.startsWith('logs ') ? sub.split(/\s+/)[1] : undefined,
      );
      if (h === 'unknown') return;
      await showHistory(ctx, h);
      return;
    }

    // combine forced harness + args for parsing
    const rawForParse = forcedHarness ? `${forcedHarness} ${args}`.trim() : args;
    // gather known modes across all harnesses for parsing
    const allModes = new Set<string>();
    for (const h of HARNESS_NAMES) for (const k of loadTemplates(ctx.cwd, h).keys()) allModes.add(k);
    for (const k of loadTemplates(ctx.cwd).keys()) allModes.add(k);
    const knownHarnessesSet = new Set([...HARNESS_NAMES, ...Object.keys(ALIASES)]);
    const parsed = parseDelegateCommand(rawForParse, allModes, knownHarnessesSet);
    // if forcedHarness provided, it wins
    if (forcedHarness) parsed.harness = forcedHarness;

    // fan-out: harness field is `all` or a comma list — resolve to detected harnesses and run
    // the engine once per harness instead of the single-harness flow below.
    if (parsed.harness && isFanoutSpec(parsed.harness)) {
      await runFanoutCommand(ctx, parsed);
      return;
    }

    const harnessName = parsed.harness ?? loadConfig().defaultHarness ?? 'claude';
    const templates = loadTemplates(ctx.cwd, harnessName);
    const resolved = resolveDefaults(parsed, templates);
    const template = parsed.mode ? templates.get(parsed.mode) : undefined;
    const isDanger =
      template?.permission === 'danger' ||
      (template?.nativePermission
        ? ['bypassPermissions', 'danger-full-access', 'danger'].includes(template.nativePermission)
        : false);

    if (!resolved) {
      if (parsed.mode)
        ctx.ui.notify?.(
          `/delegate ${parsed.mode} <what to do> — give a prompt for the "${parsed.mode}" mode`,
          'warning',
        );
      else
        ctx.ui.notify?.(
          'Usage: /delegate [--harness=claude|codex|opencode|amp|devin|all] [--mode=…] [--model=…] [--scope=…] [--verify=…] <prompt>',
          'warning',
        );
      return;
    }

    const outcome = await runOneDelegation(ctx, {
      harnessName,
      mode: parsed.mode,
      task: resolved.task,
      scope: resolved.scope,
      model: parsed.model,
      budget: parsed.budget,
      sessionId: parsed.sessionId,
      pr: parsed.pr,
      verify: parsed.verify,
      template,
      isDanger,
    });
    if (outcome.cancelled || !outcome.result) {
      const message = outcome.error ? outcome.error.message : outcome.cancelled ? 'cancelled' : 'delegation failed';
      if (ctx.hasUI)
        ctx.ui.notify(
          `delegate ${outcome.cancelled ? 'cancelled' : 'failed'}: ${message}`,
          outcome.cancelled ? 'warning' : 'error',
        );
      else process.stderr.write(`${message}\n`);
      return;
    }
    const { content, details, verify } = outcome.result;
    const summary = summarize(content);
    const file = (details.file as string) ?? null;
    const sessionId = (details.sessionId as string) ?? null;
    const resumeHint = sessionId ? ` · resume: /delegate --resume=${sessionId} <prompt>` : '';
    const usage = details.usage as
      | {
          inputTokens?: number;
          outputTokens?: number;
          cacheCreationInputTokens?: number;
          cacheReadInputTokens?: number;
        }
      | undefined;
    const promptTokens = usage
      ? (usage.inputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0) + (usage.cacheReadInputTokens ?? 0)
      : 0;
    const metrics = formatMetrics({
      numTurns: typeof details.numTurns === 'number' ? details.numTurns : null,
      totalCostUsd: typeof details.totalCostUsd === 'number' ? details.totalCostUsd : null,
      promptTokens,
      contextPercent: typeof details.contextPercent === 'number' ? (details.contextPercent as number) : null,
      durationMs:
        typeof details.durationMs === 'number' && details.durationMs !== null ? (details.durationMs as number) : null,
    });
    injectReport(ctx, {
      harness: details.harness as string,
      mode: details.mode as string,
      metrics,
      body: summary.text,
      file: file ?? undefined,
      sessionId: sessionId ?? undefined,
      verify,
    });
    if (ctx.hasUI) {
      ctx.ui.setStatus('delegate', undefined);
      ctx.ui.notify(`${details.harness} ${details.mode} done — ${metrics}${resumeHint} · transcript: ${file}`, 'info');
    } else process.stdout.write(`${summary.text}\n`);
  };

  pi.registerCommand('delegate', {
    description:
      'Delegate a task to any harness. Usage: /delegate [--harness=claude|codex|opencode|amp|devin|all] [--mode=review|plan|implement|security-audit|docs|general] [--model=...] [--scope=diff|pr|paths] [--verify=<cmd>] [--resume=<id>] <prompt> — or use harness as first word: /delegate codex review <prompt>. harness=all or a comma list (e.g. claude,codex) fans out to every detected harness and returns one comparison report.',
    handler: makeHandler(),
  });
  pi.registerCommand('claude', {
    description: 'Alias for /delegate --harness=claude. Usage: /claude [--mode=...] <prompt>',
    handler: makeHandler('claude'),
  });
  pi.registerCommand('codex', {
    description: 'Alias for /delegate --harness=codex. Usage: /codex [--mode=...] <prompt>',
    handler: makeHandler('codex'),
  });
  pi.registerCommand('opencode', {
    description: 'Alias for /delegate --harness=opencode. Usage: /opencode [--mode=...] <prompt>',
    handler: makeHandler('opencode'),
  });
  pi.registerCommand('amp', {
    description: 'Alias for /delegate --harness=amp. Usage: /amp [--mode=...] <prompt>',
    handler: makeHandler('amp'),
  });
  pi.registerCommand('omp', {
    description: 'Alias for /delegate --harness=amp (omp compat). Usage: /omp [--mode=...] <prompt>',
    handler: makeHandler('amp'),
  });
  pi.registerCommand('devin', {
    description: 'Alias for /delegate --harness=devin. Usage: /devin [--mode=...] <prompt>',
    handler: makeHandler('devin'),
  });

  pi.on('input', async (event, _ctx) => {
    if (event.source === 'extension') return { action: 'continue' };
    const hint = delegationHint(event.text, { autoDelegateHints: loadConfig().autoDelegateHints });
    if (!hint) return { action: 'continue' };
    return { action: 'transform', text: `${stripMarker(event.text)}\n\n${hint}` };
  });

  pi.on('before_agent_start', async () => {
    if (!pendingReport) return;
    const report = pendingReport;
    pendingReport = null;
    return { message: { customType: 'delegate', content: report.content, display: true, details: report.details } };
  });
}
