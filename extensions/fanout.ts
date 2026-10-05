/**
 * Fan-out (`harness: "all"` or a comma list): the tool path (`runFanoutTool`) and the `/delegate`
 * command path (`runFanoutCommand` -> `runFanoutConcurrent`, one multi-run overlay). Split out of
 * index.ts with no behavior change; the command path's overlay state is passed in as `RunUiState`.
 */

import type { Usage } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { OverlayHandle } from '@earendil-works/pi-tui';
import { buildFanoutReport, type FanoutRunSummary, formatToolUse, orderFanoutResults } from './activity.ts';
import { fanoutResumeError, type parseDelegateCommand, resolveDefaults, resolveHarnessList } from './command.ts';
import { type DelegateConfig, loadConfig } from './config.ts';
import {
  type DelegateToolParams,
  delegate,
  injectReport,
  isProjectTrusted,
  runDelegateForTool,
  runMetrics,
  summarize,
  type ToolProgressUpdate,
} from './engine.ts';
import {
  detectAll,
  HARNESS_NAMES,
  isKnownHarness,
  isTemplateDanger,
  resolveHarnessName,
} from './harnesses/registry.ts';
import type { ActivityEvent } from './harnesses/types.ts';
import { NotifyBatcher } from './notify.ts';
import { formatFanoutChip, multiProgressWindow, type RunRow } from './progress-multi.ts';
import { newFanoutId } from './run-record.ts';
import { loadTemplates } from './templates.ts';
import { mapClaudeUsage } from './usage.ts';
import { confirmDangerousCommand, validateDelegateInputs } from './validate.ts';
/** How long the fan-out overlay lingers on the finished board after the last run resolves, so a
 *  user who looked away still catches the final state instead of it clearing instantly. */
export const FANOUT_LINGER_MS = 3000;

export async function closeWhenMounted(getClose: () => (() => void) | null, capMs: number): Promise<void> {
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

/** `delegate({harness:"all"|"a,b"})` — resolve the requested harnesses to detected installs, run the
 *  existing `delegate()` engine concurrently across all of them (bounded by `maxConcurrent` via
 *  `acquireSlot({wait:true})` — see concurrency.ts), and mechanically synthesize one comparison
 *  report ordered by the resolved harness list regardless of completion order. No second model call. */
export async function runFanoutTool(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  config: DelegateConfig,
  params: DelegateToolParams,
  signal: AbortSignal | undefined,
  onUpdate: ((u: ToolProgressUpdate) => void) | undefined,
): Promise<{ content: { type: 'text'; text: string }[]; details: Record<string, unknown>; usage?: Usage }> {
  const resumeErr = fanoutResumeError(params.harness, params.sessionId);
  if (resumeErr) throw new Error(resumeErr);
  validateDelegateInputs({
    sessionId: params.sessionId,
    model: params.model,
    pr: params.pr,
    addDirs: params.addDirs,
    cwd: ctx.cwd,
  });
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
  const fanoutId = newFanoutId();

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
          timeoutSec: params.timeoutSec,
          allowDangerous: params.allowDangerous === true,
          sessionId: params.sessionId,
          pr: params.pr,
          addDirs: params.addDirs,
          // no verify: intentionally not model-settable — see DelegateToolParams
          waitForSlot: true,
          fanoutId,
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
        metrics: runMetrics(run.details),
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
    details: { fanout: true, fanoutId, harness: 'all', mode, harnesses: resolved, skipped, unknown, runs },
    usage,
  };
}

/** Mutable UI state shared by the command-path runners — owned by the extension factory. */
export interface RunUiState {
  activeRunId: number;
  activeOverlay: { show(): void; focus(): void; runId: number } | null;
}

export interface FanoutSpec {
  harnessName: string;
  task: string;
  scope?: string;
  model?: string;
  budget?: number;
  timeoutSec?: number;
  sessionId?: string;
  pr?: string;
  addDirs?: string[];
  verify?: string;
  isDanger: boolean;
  /** Only ever true after `confirmDangerousCommand` approved this invocation's --allow-dangerous. */
  allowDangerous?: boolean;
}
export interface FanoutOutcome {
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
export async function runFanoutConcurrent(
  pi: ExtensionAPI,
  ui: RunUiState,
  ctx: ExtensionContext,
  mode: string | undefined,
  specs: FanoutSpec[],
  fanoutId?: string,
): Promise<FanoutOutcome[]> {
  const ac = new AbortController();
  let cancelledAll = false;
  const runId = ++ui.activeRunId;
  const clearActive = () => {
    if (ui.activeOverlay?.runId === runId) ui.activeOverlay = null;
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
      timeoutSec: spec.timeoutSec,
      timeoutSecMayRaise: true, // command path only: --timeout= is human-typed
      sessionId: spec.sessionId,
      pr: spec.pr,
      addDirs: spec.addDirs,
      verify: spec.verify,
      allowDangerous: spec.allowDangerous === true, // never from config — only a confirmed --allow-dangerous
      signal: ac.signal,
      waitForSlot: true,
      fanoutId,
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
            ui.activeOverlay = { show: () => h.setHidden(false), focus: () => h.focus(), runId };
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
    // injected report). `ui.activeOverlay` stays valid for `/delegate watch` until this settles.
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
}

/** `/delegate all …` / `/delegate a,b …` — resolve to detected harnesses, run `delegate()`
 *  concurrently across all of them in one multi-run overlay (see `runFanoutConcurrent`), batch
 *  success notifications, and inject one synthesized comparison report ordered by the resolved
 *  harness list regardless of completion order. */
export async function runFanoutCommand(
  pi: ExtensionAPI,
  ui: RunUiState,
  ctx: ExtensionContext,
  parsed: ReturnType<typeof parseDelegateCommand>,
): Promise<void> {
  const harnessSpec = parsed.harness as string;
  const modeForReport = parsed.mode ?? loadConfig().defaultMode;
  try {
    const resumeErr = fanoutResumeError(harnessSpec, parsed.sessionId);
    if (resumeErr) throw new Error(resumeErr);
    validateDelegateInputs({
      sessionId: parsed.sessionId,
      model: parsed.model,
      pr: parsed.pr,
      addDirs: parsed.addDirs,
      cwd: ctx.cwd,
    });
    // Headless never honors --allow-dangerous: refuse before even probing harness binaries. (With a
    // UI the single confirm happens below, once the harness list is actually resolved.)
    if (parsed.allowDangerous && !ctx.hasUI) {
      await confirmDangerousCommand(ctx, { harnesses: [harnessSpec], mode: modeForReport, task: parsed.task });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (ctx.hasUI) ctx.ui.notify(msg, 'error');
    else process.stderr.write(`${msg}\n`);
    return;
  }
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

  const batcher = new NotifyBatcher((text, level) => {
    if (ctx.hasUI) ctx.ui.notify(text, level);
    else process.stdout.write(`${text}\n`);
  });

  // Resolve each harness's task/scope/danger flag up front — cheap and synchronous — so a
  // harness that can't even start (e.g. mode needs a prompt) fails immediately instead of
  // occupying a concurrency slot.
  const specs: FanoutSpec[] = [];
  const immediateFailures: FanoutRunSummary[] = [];
  const trusted = isProjectTrusted(ctx);
  for (const h of resolved) {
    const templates = loadTemplates(ctx.cwd, h, trusted);
    const resolvedTaskScope = resolveDefaults(parsed, templates);
    if (!resolvedTaskScope) {
      const message = `mode "${parsed.mode ?? 'general'}" needs a prompt`;
      immediateFailures.push({ harness: h, ok: false, cost: null, error: message });
      batcher.failure(`${h}: ${message}`);
      continue;
    }
    // the template delegate() will actually run for this harness (default mode when none given),
    // judged by the engine's own danger gate — so the banner can't disagree with the engine
    const isDanger = isTemplateDanger(h, templates.get(modeForReport));
    specs.push({
      harnessName: h,
      task: resolvedTaskScope.task,
      scope: resolvedTaskScope.scope,
      model: parsed.model,
      budget: parsed.budget,
      timeoutSec: parsed.timeoutSec,
      sessionId: parsed.sessionId,
      pr: parsed.pr,
      addDirs: parsed.addDirs,
      verify: parsed.verify,
      isDanger,
    });
  }

  // --allow-dangerous: ONE confirm naming every harness that will actually run — never one per
  // harness, and never a run before it's approved. A decline (or no UI) runs nothing.
  if (parsed.allowDangerous && specs.length > 0) {
    try {
      await confirmDangerousCommand(ctx, {
        harnesses: specs.map(s => s.harnessName),
        mode: modeForReport,
        task: specs[0].task,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (ctx.hasUI) ctx.ui.notify(msg, 'warning');
      else process.stderr.write(`${msg}\n`);
      return;
    }
    for (const s of specs) {
      s.allowDangerous = true;
      s.isDanger = true; // escalated — the overlay shows the danger banner
    }
  }

  const fanoutId = newFanoutId();
  const outcomes = specs.length > 0 ? await runFanoutConcurrent(pi, ui, ctx, parsed.mode, specs, fanoutId) : [];
  const completed: FanoutRunSummary[] = outcomes.map(outcome => {
    if (outcome.cancelled || !outcome.result) {
      const message = outcome.error ? outcome.error.message : outcome.cancelled ? 'cancelled' : 'delegation failed';
      batcher.failure(`${outcome.harnessName}: ${outcome.cancelled ? 'cancelled' : 'failed'} — ${message}`);
      return { harness: outcome.harnessName, ok: false, cost: null, error: message };
    }
    const { content, details, result, verify } = outcome.result;
    const summary = summarize(content);
    const metrics = runMetrics(details);
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
    body:
      specs.length > 0
        ? `${report}\n\n_fan-out id: ${fanoutId} — resume every member: /delegate --resume=${fanoutId} <prompt>_`
        : report,
  });
  batcher.flush();
}
