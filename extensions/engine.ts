/**
 * The `delegate()` engine — the single source of truth for one harness run — plus its helpers
 * (prompt building, verify, transcripts, trust, the queued report) and the tool-path live-feed
 * wrapper `runDelegateForTool`. Split out of index.ts with no behavior change.
 */

import { resolve } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { acpView, runAcpHarness } from './acp-runner.ts';
import {
  buildReportContent,
  buildTranscript,
  buildVerifyResult,
  collectActivityLog,
  describeBudget,
  formatMetrics,
  formatToolUse,
  pruneOutputs,
  resolveVerifyPlan,
  skipVerifyResult,
  ToolCallIndex,
  type VerifyResult,
  writeTranscript,
} from './activity.ts';
import { acquireSlot } from './concurrency.ts';
import {
  type DelegateConfig,
  outputsDir as getOutputsDir,
  legacyOutputsDir,
  loadConfig,
  resolveModelForHarness,
  resolveTransport,
} from './config.ts';
import { ALIASES, getHarness, HARNESS_NAMES, isNativeDangerPermission } from './harnesses/registry.ts';
import type { ActivityEvent, NormalizedPermission } from './harnesses/types.ts';
import { runHarness } from './runner.ts';
import {
  type DelegateTemplate,
  describeSkippedProjectTemplates,
  loadTemplates,
  projectTemplatePresence,
  resolveNativePermission,
} from './templates.ts';
import { validateDelegateInputs } from './validate.ts';
/** Render a possibly-unknown cost — `null` means the harness didn't report one, not a measured $0. */
export function formatCost(cost: number | null): string {
  return cost !== null ? `$${cost.toFixed(3)}` : '$—';
}

export interface DelegateOptions {
  harness?: string;
  task: string;
  mode?: string;
  scope?: string;
  model?: string;
  maxBudgetUsd?: number;
  allowDangerous?: boolean;
  sessionId?: string;
  pr?: string;
  /** Extra directories the harness may access, merged with the template's `addDirs` (relative
   *  paths resolve against the run's cwd). Per-harness limits apply — see each `buildArgs`. */
  addDirs?: string[];
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
export const VERIFY_TIMEOUT_MS = 5 * 60_000;

/**
 * Run a verify command in-process on the host (never delegated to the harness). Report-only —
 * callers must not let this flip a run's `isError`.
 *
 * Trust model: a verify command can only come from two places — on-disk template frontmatter
 * (project-local templates are already gated by `isProjectTrusted(ctx)` — pi's own trust store,
 * never anything inside the project itself) or a human typing `/delegate --verify=<cmd>` at the
 * CLI. It is deliberately **not** a `delegate` tool parameter: a tool
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
export async function runVerify(pi: ExtensionAPI, cwd: string, command: string): Promise<VerifyResult> {
  try {
    const res = await pi.exec('sh', ['-c', command], { cwd, timeout: VERIFY_TIMEOUT_MS });
    return buildVerifyResult(command, res.code, `${res.stdout}${res.stderr}`);
  } catch (err) {
    return buildVerifyResult(command, 1, err instanceof Error ? err.message : String(err));
  }
}

export function outputsDirFor(harness: string): string {
  return getOutputsDir(harness);
}

/**
 * Whether pi's own trust store (`ctx.isProjectTrusted()`, backed by `~/.pi/agent/trust.json`,
 * outside any project) considers `ctx.cwd` trusted. This is the sole source of truth for whether
 * project-local delegate templates load — see the trust-tier comment on `loadTemplates`. Fails
 * closed (untrusted) if the host is old enough not to expose the method, or if it throws.
 */
/**
 * Warn once per project when trusted-only content was silently skipped.
 *
 * Before 0.6.0 a committed `.pi/trusted` file (or `PI_TRUSTED=1`) granted trust; both were removed as
 * a security fix. A user who relied on either loses their project-local templates on upgrade with no
 * visible signal — an override shares its name with the builtin it replaces, so the run just uses the
 * builtin and looks fine. `/delegate status` reports trust state, but nobody runs it unless something
 * already looks wrong, so this fires on an actual delegation instead — and only when the project
 * demonstrably has the content being skipped, so it never nags anyone unaffected.
 */
const warnedUntrustedProjects = new Set<string>();

export function warnIfProjectTemplatesSkipped(ctx: ExtensionContext, trusted: boolean): void {
  if (trusted || warnedUntrustedProjects.has(ctx.cwd)) return;
  const lines = describeSkippedProjectTemplates(projectTemplatePresence(ctx.cwd, HARNESS_NAMES));
  if (lines.length === 0) return;
  warnedUntrustedProjects.add(ctx.cwd);
  const msg = lines.join('\n');
  if (ctx.hasUI) ctx.ui.notify?.(msg, 'warning');
  else process.stderr.write(`${msg}\n`);
}

export function isProjectTrusted(ctx: ExtensionContext): boolean {
  try {
    return typeof ctx.isProjectTrusted === 'function' && ctx.isProjectTrusted() === true;
  } catch {
    return false;
  }
}

export function saveOutput(harness: string, mode: string, text: string): string {
  return writeTranscript(outputsDirFor(harness), mode, text);
}

/** Union of the template's and the call's extra dirs (template first, deduped), resolved against
 *  `cwd`. Undefined when neither declares any, so harness args stay byte-identical. */
export function mergeAddDirs(cwd: string, fromTemplate?: string[], fromCall?: string[]): string[] | undefined {
  const out: string[] = [];
  for (const d of [...(fromTemplate ?? []), ...(fromCall ?? [])]) {
    const abs = resolve(cwd, d);
    if (!out.includes(abs)) out.push(abs);
  }
  return out.length > 0 ? out : undefined;
}

export function buildPrompt(
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

/** The shared single-run engine. Exported for tests only — pi loads this module's default export. */
export async function delegate(
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
  // argv-bound inputs (sessionId/model/pr) are validated here, the one entry both the tool and
  // the /delegate command share — see validate.ts for the argument-injection rationale.
  validateDelegateInputs({
    sessionId: opts.sessionId,
    model: opts.model,
    pr: opts.pr,
    addDirs: opts.addDirs,
    cwd: ctx.cwd,
  });
  const config = loadConfig();
  const harnessName = opts.harness ?? config.defaultHarness ?? 'claude';
  const harness = getHarness(harnessName);
  if (!harness)
    throw new Error(
      `unknown harness "${harnessName}". Available: ${HARNESS_NAMES.join(', ')} (aliases: ${Object.keys(ALIASES).join(', ')})`,
    );
  const projectTrusted = isProjectTrusted(ctx);
  warnIfProjectTemplatesSkipped(ctx, projectTrusted);
  const templates = loadTemplates(ctx.cwd, harnessName, projectTrusted);
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

  // permission: normalized, danger requires explicit per-call allowDangerous:true (tool: model-set,
  // human-confirmed in execute(); command: --allow-dangerous, human-confirmed in the handler). Resolved (and
  // the danger refusal thrown) before acquireSlot() — it's pure, so a refused run never occupies
  // (or, for fan-out, waits for) a concurrency slot it can't use.
  let permission: NormalizedPermission = template.permission;
  const nativePerm = template.nativePermission;
  const isNativeDanger = isNativeDangerPermission(harness, nativePerm);
  if (template.permission === 'danger' || isNativeDanger) {
    if (opts.allowDangerous !== true) {
      throw new Error(
        `template "${mode}" requires danger permission — never a default: pass allowDangerous:true on the delegate tool, or --allow-dangerous on /delegate (both ask you to confirm interactively)`,
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
  const addDirs = mergeAddDirs(ctx.cwd, template.addDirs, opts.addDirs);
  const maxBudgetUsd =
    opts.maxBudgetUsd ?? template.maxBudgetUsd ?? config.maxBudgetUsd ?? config.harnesses[harnessName]?.maxBudgetUsd;

  // concurrency guard — see concurrency.ts. Single runs (waitForSlot unset) fail fast at capacity,
  // exactly as before; fan-out passes waitForSlot:true to queue instead.
  const release = await acquireSlot({
    harness: harnessName,
    mode,
    config,
    wait: opts.waitForSlot ?? false,
    signal: opts.signal,
  });

  // Everything from here until the harness exits holds the slot — any throw (scope resolution,
  // prompt building, the runner itself) must release it, or the slot leaks for the rest of the
  // process's life. `finally` below is the single release point for that whole span.
  const activityEvents: ActivityEvent[] = [];
  let streamedFull = '';
  let result: import('./runner.ts').HarnessResult;
  try {
    // A cancel that landed while we were waiting on (or just after winning) the slot — don't
    // spawn anything for a run the caller has already given up on.
    if (opts.signal?.aborted) throw new Error('cancelled');
    opts.onAcquired?.();

    let scopeText: string | null = opts.scope ?? null;
    if (opts.scope === 'diff') {
      const diff = await pi.exec('git', ['diff', 'HEAD'], { cwd: ctx.cwd });
      scopeText = diff.stdout
        ? `Current git diff (working tree vs HEAD):\n${diff.stdout}`
        : 'No git diff vs HEAD (working tree clean).';
    } else if (opts.scope === 'pr' || opts.pr) {
      const target = opts.pr ?? '';
      const pr = await pi.exec('gh', target ? ['pr', 'diff', '--', target] : ['pr', 'diff'], { cwd: ctx.cwd });
      scopeText = pr.stdout
        ? `Pull request diff (${target || 'current branch'}):\n${pr.stdout}`
        : `Could not resolve the PR diff${pr.stderr ? ` — ${pr.stderr.trim().slice(0, 300)}` : ''}.`;
    }
    const prompt = buildPrompt(template, task, scopeText, ctx.cwd, harnessName);

    const baseRunOpts = {
      harness,
      prompt,
      cwd: ctx.cwd,
      permission,
      model,
      maxBudgetUsd,
      signal: opts.signal,
      timeoutMs: config.harnesses[harnessName]?.timeoutMs ?? config.timeoutMs,
      resumeSessionId: opts.sessionId,
      addDirs,
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
  } finally {
    release();
  }

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

  // How maxBudgetUsd fared: native (claude), host-enforced best-effort from streamed cost, checked
  // only at the step/turn boundaries the harness reports, so it can overshoot (the runner kills the
  // run — `result.budgetExceeded`), or unenforceable (no native flag and no cost reported) — the
  // last two always surface a message, never silently.
  const budget = describeBudget({
    harness: harnessName,
    limitUsd: maxBudgetUsd,
    native: harness.nativeBudget === true,
    costUsd: result.totalCostUsd,
    stoppedByHost: result.budgetExceeded === true,
  });

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
      budget,
    }),
  );
  pruneOutputs(outputsDirFor(harnessName), config.maxTranscripts);
  // also prune legacy if claude
  if (harnessName === 'claude') pruneOutputs(legacyOutputsDir(), config.maxTranscripts);

  const output = result.result || result.streamedText || '(empty result)';
  return {
    content: budget?.message ? `${budget.message}\n\n${output}` : output,
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
      budget,
    },
    result,
    activityLog: collectActivityLog(activityEvents),
    verify,
  };
}

/**
 * The one-line metrics summary (`N turn(s) · $X · Nk tok · N% ctx · Ns`) for a finished `delegate()`
 * run, read from its `details`. Shared by the single-run command path and both fan-out paths so a
 * comparison row reports the same real prompt-token figure the single run does (it used to be a
 * hard-coded 0 there, which silently dropped the `tok` column from every fan-out row).
 */
export function runMetrics(details: Record<string, unknown>): string {
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return formatMetrics({
    numTurns: num(details.numTurns),
    totalCostUsd: num(details.totalCostUsd),
    promptTokens: num(details.promptTokens) ?? 0,
    contextPercent: num(details.contextPercent),
    durationMs: num(details.durationMs),
  });
}

export function summarize(content: string, max = 30_000): { text: string; truncated: boolean } {
  if (content.length <= max) return { text: content, truncated: false };
  return { text: `${content.slice(0, max)}\n…[truncated — full output saved to file]`, truncated: true };
}

export interface PendingReport {
  content: string;
  details: Record<string, unknown>;
}

let pendingReport: PendingReport | null = null;

export function injectReport(
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

export interface ToolProgressUpdate {
  content: { type: string; text: string }[];
  details: { progress: number };
}

/**
 * `delegate` tool params. Deliberately has no `verify` field — a tool param is model-controlled,
 * and the model's context (repo content, delegated-harness output) is attacker-influenceable, so
 * a model-settable verify command would be a prompt-injection -> arbitrary-host-command path.
 * Verify only comes from on-disk template frontmatter or a human-typed `/delegate --verify=`.
 */
export interface DelegateToolParams {
  harness?: string;
  task: string;
  mode?: string;
  scope?: string;
  model?: string;
  maxBudgetUsd?: number;
  allowDangerous?: boolean;
  sessionId?: string;
  pr?: string;
  addDirs?: string[];
}

/** One `delegate()` call with the tool's live-feed progress reporting (`onUpdate`). Shared by the
 *  single-harness tool path and the fan-out loop — `labelPrefix` tags fan-out feed lines by harness. */
export async function runDelegateForTool(
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

/** Hand off (and clear) the report queued by `injectReport`, for pi's `before_agent_start`. */
export function takePendingReport(): PendingReport | null {
  const report = pendingReport;
  pendingReport = null;
  return report;
}
