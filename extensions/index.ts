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

import { type ExtensionAPI, type ExtensionContext, getMarkdownTheme } from '@earendil-works/pi-coding-agent';
import { Container, Markdown, type OverlayHandle, Text } from '@earendil-works/pi-tui';
import { Type } from 'typebox';
import { formatToolUse, ToolCallIndex } from './activity.ts';
import {
  aliasUsage,
  delegateUsage,
  isFanoutSpec,
  parseDelegateCommand,
  resolveDefaults,
  resolveHarnessFilter,
} from './command.ts';
import { loadConfig } from './config.ts';
import {
  type DelegateToolParams,
  delegate,
  formatCost,
  injectReport,
  isProjectTrusted,
  runDelegateForTool,
  runMetrics,
  summarize,
  type ToolProgressUpdate,
  takePendingReport,
} from './engine.ts';
import { closeWhenMounted, type RunUiState, runFanoutCommand, runFanoutTool } from './fanout.ts';
import { ALIASES, HARNESS_NAMES, isKnownHarness, isTemplateDanger, resolveHarnessName } from './harnesses/registry.ts';
import type { ActivityEvent } from './harnesses/types.ts';
import { delegationHint, stripMarker } from './hint.ts';
import { showHistory } from './history.ts';
import { type FeedEntry, progressWindow } from './progress.ts';
import { initConfig, showConfig, showModes, showStatus } from './subcommands.ts';
import { type DelegateTemplate, loadTemplates } from './templates.ts';
import { mapClaudeUsage } from './usage.ts';
import { confirmDangerousCommand, confirmDangerousToolCall, confirmToolAddDirs } from './validate.ts';

export default function (pi: ExtensionAPI) {
  const ui: RunUiState = { activeRunId: 0, activeOverlay: null };

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
      'sessionId resumes a previous delegated session instead of starting fresh — pass the exact session id from a previous run\'s details (letters, digits, . _ : - only). It cannot be combined with a fan-out harness ("all" or a comma list) — a session belongs to one harness.',
      'pr must be a PR number, an http(s) pull-request URL (https://<host>/<owner>/<repo>/pull/<n>), or owner/repo#123.',
      'addDirs inside the working directory are accepted as-is; any entry outside it asks the human to confirm interactively and is refused in a non-interactive session.',
      'Do not set allowDangerous unless the user explicitly asks for unrestricted access (danger permission). Setting it always asks the human to confirm interactively; in a non-interactive session it is refused outright.',
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
          description:
            'Escalate to danger permission (unrestricted). Always requires interactive human confirmation; refused without a UI.',
        }),
      ),
      pr: Type.Optional(
        Type.String({ description: 'GitHub PR number, http(s) PR URL, or owner/repo#123 (alternative to scope pr).' }),
      ),
      addDirs: Type.Optional(
        Type.Array(Type.String(), {
          description:
            'Extra directories the harness may access. Relative paths resolve against the working directory. Any entry that resolves (after symlinks) outside the working directory requires interactive human confirmation and is refused without a UI. Not every harness supports this (opencode ignores it; codex ignores it on resume).',
        }),
      ),
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
      // A model-set allowDangerous is never honored on its own — a human confirms it (or, with no
      // UI to ask, it's refused). Checked once up front, before any fan-out. See validate.ts.
      if (params.allowDangerous === true) await confirmDangerousToolCall(ctx, params);
      // Same trust model for model-set addDirs: inside cwd is fine, anything outside needs a human
      // (fail closed without a UI). Covers single, fan-out, and the claude_delegate alias.
      await confirmToolAddDirs(ctx, params.addDirs);
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
          addDirs: params.addDirs,
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
      addDirs?: string[];
      verify?: string;
      template?: DelegateTemplate;
      isDanger: boolean;
      /** Only ever true after `confirmDangerousCommand` approved this invocation's --allow-dangerous. */
      allowDangerous?: boolean;
    },
  ): Promise<{
    result: Awaited<ReturnType<typeof delegate>> | null;
    error: Error | null;
    cancelled: boolean;
  }> => {
    const { harnessName, mode, task, scope, model, budget, sessionId, pr, addDirs, verify, template, isDanger } = opts;
    const allowDangerous = opts.allowDangerous === true;
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
    const runId = ++ui.activeRunId;
    const clearActive = () => {
      if (ui.activeOverlay?.runId === runId) ui.activeOverlay = null;
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
      addDirs,
      verify,
      allowDangerous, // never from config.allowDangerous — only a confirmed --allow-dangerous
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
              ui.activeOverlay = { show: () => h.setHidden(false), focus: () => h.focus(), runId };
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
      if (ui.activeOverlay) {
        ui.activeOverlay.show();
        ui.activeOverlay.focus();
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
    const trusted = isProjectTrusted(ctx);
    const allModes = new Set<string>();
    for (const h of HARNESS_NAMES) for (const k of loadTemplates(ctx.cwd, h, trusted).keys()) allModes.add(k);
    for (const k of loadTemplates(ctx.cwd, undefined, trusted).keys()) allModes.add(k);
    const knownHarnessesSet = new Set([...HARNESS_NAMES, ...Object.keys(ALIASES)]);
    const parsed = parseDelegateCommand(rawForParse, allModes, knownHarnessesSet);
    // if forcedHarness provided, it wins
    if (forcedHarness) parsed.harness = forcedHarness;
    // a flag that was given but can't be honored (e.g. --budget=0) runs nothing — never silently dropped
    if (parsed.errors && parsed.errors.length > 0) {
      const msg = `${parsed.errors.join('; ')}\nUsage: ${forcedHarness ? aliasUsage(forcedHarness) : delegateUsage()}`;
      if (ctx.hasUI) ctx.ui.notify(msg, 'error');
      else process.stderr.write(`${msg}\n`);
      return;
    }

    // fan-out: harness field is `all` or a comma list — resolve to detected harnesses and run
    // the engine once per harness instead of the single-harness flow below.
    if (parsed.harness && isFanoutSpec(parsed.harness)) {
      await runFanoutCommand(pi, ui, ctx, parsed);
      return;
    }

    const harnessName = parsed.harness ?? loadConfig().defaultHarness ?? 'claude';
    const templates = loadTemplates(ctx.cwd, harnessName, trusted);
    const resolved = resolveDefaults(parsed, templates);
    // the template delegate() will actually run — the default mode when none was given — so the
    // danger banner agrees with the engine's own gate (isTemplateDanger, same check)
    const template = templates.get(parsed.mode || loadConfig().defaultMode);
    const isDanger = isTemplateDanger(harnessName, template);

    if (!resolved) {
      if (parsed.mode)
        ctx.ui.notify?.(
          `/delegate ${parsed.mode} <what to do> — give a prompt for the "${parsed.mode}" mode`,
          'warning',
        );
      else ctx.ui.notify?.(`Usage: ${forcedHarness ? aliasUsage(forcedHarness) : delegateUsage()}`, 'warning');
      return;
    }

    // --allow-dangerous: honored for this invocation only, and only once a human confirms it in an
    // interactive dialog — headless refuses (fail closed). Escalates a non-danger template too (the
    // engine's existing allowDangerous semantics), so the same confirm applies either way.
    let allowDangerous = false;
    if (parsed.allowDangerous) {
      try {
        await confirmDangerousCommand(ctx, {
          harnesses: [harnessName],
          mode: parsed.mode ?? loadConfig().defaultMode,
          task: resolved.task,
        });
        allowDangerous = true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (ctx.hasUI) ctx.ui.notify(msg, 'warning');
        else process.stderr.write(`${msg}\n`);
        return;
      }
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
      addDirs: parsed.addDirs,
      verify: parsed.verify,
      template,
      isDanger: isDanger || allowDangerous,
      allowDangerous,
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
    const metrics = runMetrics(details);
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
    description: `Delegate a task to any harness. Usage: ${delegateUsage()} — or use harness as first word: /delegate codex review <prompt>. harness=all or a comma list (e.g. claude,codex) fans out to every detected harness and returns one comparison report. --allow-dangerous runs this one invocation with danger (unrestricted) permission after an interactive confirm; refused headless.`,
    handler: makeHandler(),
  });
  // alias commands: same flag set as /delegate (one source — COMMAND_FLAGS_HINT), harness fixed
  const aliasCommands: [command: string, harness: string, note: string][] = [
    ['claude', 'claude', ''],
    ['codex', 'codex', ''],
    ['opencode', 'opencode', ''],
    ['amp', 'amp', ''],
    ['omp', 'amp', ' (omp compat)'],
    ['devin', 'devin', ''],
  ];
  for (const [command, harness, note] of aliasCommands) {
    pi.registerCommand(command, {
      description: `Alias for /delegate --harness=${harness}${note}. Usage: ${aliasUsage(command)}`,
      handler: makeHandler(harness),
    });
  }

  pi.on('input', async (event, _ctx) => {
    if (event.source === 'extension') return { action: 'continue' };
    const hint = delegationHint(event.text, { autoDelegateHints: loadConfig().autoDelegateHints });
    if (!hint) return { action: 'continue' };
    return { action: 'transform', text: `${stripMarker(event.text)}\n\n${hint}` };
  });

  pi.on('before_agent_start', async () => {
    const report = takePendingReport();
    if (!report) return;
    return { message: { customType: 'delegate', content: report.content, display: true, details: report.details } };
  });
}
