/**
 * pi-harness-delegate — delegate work to any harness from the pi coding agent.
 *
 * Registers:
 *   - `delegate` tool (primary) + `claude_delegate` alias
 *   - `/delegate` command (primary) + `/claude`, `/codex`, `/opencode`, `/amp`, `/omp` aliases
 *
 * Templates ship in ../templates/shared + ../templates/<harness>; users add custom ones in
 *   ~/.pi/agent/delegate/templates/<harness>/  (global)
 *   .pi/delegate/templates/<harness>/          (project)
 * Legacy: ~/.pi/agent/claude-delegate/templates/, .pi/claude-delegate/templates/
 *
 * Config in ~/.pi/agent/settings.json: { delegate: { defaultHarness, defaultMode, ... } }
 * Legacy: { claudeDelegate: {...} } is auto-migrated.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { Type } from 'typebox';
import { getMarkdownTheme, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Container, Key, Markdown, matchesKey, SelectList, Text, truncateToWidth, type Component, type OverlayHandle, type SelectItem } from '@earendil-works/pi-tui';
import { runHarness } from './runner.ts';
import { DEFAULT_TIMEOUT_MS } from './harnesses/types.ts';
import { parseDelegateCommand, parseClaudeCommand, resolveDefaults } from './command.ts';
import { delegationHint, stripMarker } from './hint.ts';
import { progressWindow, type FeedEntry } from './progress.ts';
import { loadTemplates, type DelegateTemplate } from './templates.ts';
import { mapClaudeUsage } from './usage.ts';
import { buildReportContent, buildTranscript, collectActivityLog, formatMetrics, formatToolUse, parseTranscriptMeta, pruneOutputs, safeSegmentName } from './activity.ts';
import { loadConfig, outputsDir as getOutputsDir, legacyOutputsDir, resolveModelForHarness, agentDir } from './config.ts';
import { getHarness, HARNESS_NAMES, ALIASES, isKnownHarness } from './harnesses/registry.ts';
import type { ActivityEvent } from './harnesses/types.ts';
import type { NormalizedPermission } from './harnesses/types.ts';

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
	onStream?: (text: string) => void;
	onActivity?: (ev: ActivityEvent) => void;
	signal?: AbortSignal;
}

const activeRuns = new Map<string, number>();
let globalActiveRuns = 0;

function getMaxConcurrentGlobal(): number {
	const cfg = loadConfig();
	if (typeof cfg.maxConcurrent === 'number') return cfg.maxConcurrent;
	const mc = cfg.maxConcurrent as unknown as { global?: number };
	if (typeof mc.global === 'number') return mc.global;
	return 1;
}

async function closeWhenMounted(getClose: () => (() => void) | null, capMs: number): Promise<void> {
	const close = getClose();
	if (close) {
		close();
		return;
	}
	await new Promise<void>((resolve) => {
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
	const parts = [t.name, `[${t.permission}]`, t.model ? `model=${t.model}` : '', t.defaultTask ? '↳ default task' : '', t.harness ? `(${t.harness})` : ''];
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
				const header = theme.fg('accent', `delegate — modes${harnessFilter ? ` (${harnessFilter})` : ''} (↑↓ scroll · any key to close)`);
				const visible = rows.slice(offset, offset + height);
				return [header, ...visible.map((l) => theme.fg('muted', truncateToWidth(l, width)))];
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
	cost: number;
	sessionId: string | null;
	mtime: number;
}

function readHistory(dir: string, harness: string): HistoryEntry[] {
	try {
		return readdirSync(dir)
			.filter((f) => f.endsWith('.md') && !f.includes('-partial'))
			.map((f) => {
				const file = join(dir, f);
				let mode = 'delegate';
				let cost = 0;
				let sessionId: string | null = null;
				try {
					const meta = parseTranscriptMeta(readFileSync(file, 'utf8').slice(0, 2000));
					mode = meta.mode;
					cost = meta.cost;
					sessionId = meta.sessionId;
				} catch {}
				return { file, mode, harness, cost, sessionId, mtime: statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0 };
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
		const legacy = readdirSync(legacyOutputsDir()).filter((f) => f.endsWith('.md'));
		for (const f of legacy) {
			const file = join(legacyOutputsDir(), f);
			let mode = 'delegate';
			let cost = 0;
			let sessionId: string | null = null;
			try {
				const meta = parseTranscriptMeta(readFileSync(file, 'utf8').slice(0, 2000));
				mode = meta.mode;
				cost = meta.cost;
				sessionId = meta.sessionId;
			} catch {}
			entries.push({ file, mode, harness: 'claude', cost, sessionId, mtime: statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0 });
		}
	} catch {}
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
				return [header, ...visible.map((l) => theme.fg('muted', truncateToWidth(l, width)))];
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

async function showHistory(ctx: ExtensionContext): Promise<void> {
	const entries = readAllHistory();
	if (entries.length === 0) {
		ctx.ui.notify?.('No transcripts yet — run /delegate <harness> <mode> <prompt> first', 'info');
		return;
	}
	if (!ctx.hasUI) {
		for (const e of entries) {
			process.stdout.write(`${e.harness} ${e.mode} · $${e.cost.toFixed(3)} · ${e.sessionId ?? '-'}\n`);
		}
		return;
	}
	const entry = await ctx.ui.custom((tui, theme, _kb, done) => {
		const items: SelectItem[] = entries.map((e) => ({
			value: e.file,
			label: `${e.harness} ${e.mode} · $${e.cost.toFixed(3)} · ${new Date(e.mtime).toISOString().slice(0, 16)}`,
			description: e.sessionId ? `session ${e.sessionId.slice(0, 8)}…` : undefined,
		}));
		const list = new SelectList(items, Math.min(items.length, 10), {
			selectedPrefix: (s: string) => theme.fg('accent', s),
			selectedText: (s: string) => theme.fg('accent', s),
			description: (s: string) => theme.fg('dim', s),
			scrollInfo: (s: string) => theme.fg('dim', s),
			noMatch: (s: string) => theme.fg('warning', s),
		});
		list.onSelect = (item) => done(item.value);
		list.onCancel = () => done(undefined);
		return {
			render: (w: number) => list.render(w),
			invalidate: () => list.invalidate(),
			handleInput: (data: string) => {
				list.handleInput(data);
				tui.requestRender();
			},
		};
	});
	if (entry) {
		const chosen = entries.find((e) => e.file === entry);
		if (chosen) await viewTranscript(ctx, chosen);
	}
}

function saveOutput(harness: string, mode: string, text: string): string {
	const dir = outputsDirFor(harness);
	mkdirSync(dir, { recursive: true });
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const file = join(dir, `${stamp}-${safeSegmentName(mode)}.md`);
	writeFileSync(file, text, 'utf8');
	return file;
}

function buildPrompt(template: DelegateTemplate, task: string, scopeText: string | null, cwd: string, harness: string): string {
	let prompt = [`You are being delegated a subtask by the pi coding agent.`, `Working directory: ${cwd}`, `Harness: ${harness}`, `Mode: ${template.name}`, ``, template.prompt].join('\n');
	prompt += `\n\n# Task\n${task}`;
	if (scopeText) prompt += `\n\n# Scope\n${scopeText}`;
	if (template.skill) prompt += `\n\nUse the "${template.skill}" skill.`;
	return prompt;
}

async function delegate(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	opts: DelegateOptions,
): Promise<{ content: string; details: Record<string, unknown>; result: import('./harnesses/types.ts').StreamedResult & { streamedText: string; harness: string }; activityLog: string[] }> {
	const config = loadConfig();
	const harnessName = opts.harness ?? config.defaultHarness ?? 'claude';
	const harness = getHarness(harnessName);
	if (!harness) throw new Error(`unknown harness "${harnessName}". Available: ${HARNESS_NAMES.join(', ')} (aliases: ${Object.keys(ALIASES).join(', ')})`);
	const templates = loadTemplates(ctx.cwd, harnessName);
	const mode = opts.mode || config.defaultMode;
	const template = templates.get(mode);
	if (!template) throw new Error(`unknown delegate mode "${mode}" for harness "${harnessName}". Available: ${[...templates.keys()].sort().join(', ')}`);
	const task = opts.task || template.defaultTask;
	if (!task) throw new Error(`delegate mode "${mode}" requires a task`);

	// concurrency guard
	const maxGlobal = getMaxConcurrentGlobal();
	const perHarnessCount = activeRuns.get(harnessName) ?? 0;
	if (maxGlobal > 0 && globalActiveRuns >= maxGlobal) throw new Error('another delegate run is already in progress (global limit)');
	// per-harness limit if configured as object
	const perHarnessLimit = (() => {
		const mc = config.maxConcurrent as unknown as { perHarness?: Record<string, number> };
		if (mc && typeof mc === 'object' && mc.perHarness && typeof mc.perHarness[harnessName] === 'number') return mc.perHarness[harnessName]!;
		return maxGlobal;
	})();
	if (perHarnessLimit > 0 && perHarnessCount >= perHarnessLimit) throw new Error(`another ${harnessName} run is already in progress`);
	activeRuns.set(harnessName, perHarnessCount + 1);
	globalActiveRuns++;
	const release = () => {
		activeRuns.set(harnessName, (activeRuns.get(harnessName) ?? 1) - 1);
		globalActiveRuns = Math.max(0, globalActiveRuns - 1);
	};

	let scopeText: string | null = opts.scope ?? null;
	if (opts.scope === 'diff') {
		const diff = await pi.exec('git', ['diff', 'HEAD'], { cwd: ctx.cwd });
		scopeText = diff.stdout ? `Current git diff (working tree vs HEAD):\n${diff.stdout}` : 'No git diff vs HEAD (working tree clean).';
	} else if (opts.scope === 'pr' || opts.pr) {
		const target = opts.pr ?? '';
		const pr = await pi.exec('gh', target ? ['pr', 'diff', target] : ['pr', 'diff'], { cwd: ctx.cwd });
		scopeText = pr.stdout ? `Pull request diff (${target || 'current branch'}):\n${pr.stdout}` : `Could not resolve the PR diff${pr.stderr ? ` — ${pr.stderr.trim().slice(0, 300)}` : ''}.`;
	}

	// permission: normalized, danger requires allowDangerous
	let permission: NormalizedPermission = template.permission;
	if (opts.allowDangerous) permission = 'danger';
	else if (template.permission === 'danger' && !config.allowDangerous && !opts.allowDangerous) {
		// template wants danger but not allowed — downgrade to edit with warning? keep as edit
		permission = 'edit';
	}
	const nativePerm = template.nativePermission;
	// if template has nativePermission, use it; otherwise map normalized via harness
	const permissionForDisplay = nativePerm ?? permission;

	const model = resolveModelForHarness(config, harnessName, opts.model, template.model);
	const prompt = buildPrompt(template, task, scopeText, ctx.cwd, harnessName);

	const activityEvents: ActivityEvent[] = [];
	let streamedFull = '';
	let result: import('./runner.ts').HarnessResult;
	try {
		result = await runHarness({
			harness,
			prompt,
			cwd: ctx.cwd,
			permission,
			model,
			maxBudgetUsd: opts.maxBudgetUsd ?? template.maxBudgetUsd ?? config.maxBudgetUsd ?? config.harnesses[harnessName]?.maxBudgetUsd,
			signal: opts.signal,
			timeoutMs: config.harnesses[harnessName]?.timeoutMs ?? config.timeoutMs,
			resumeSessionId: opts.sessionId,
			onStream: (t) => {
				streamedFull += t;
				opts.onStream?.(t);
			},
			onActivity: (ev) => {
				activityEvents.push(ev);
				opts.onActivity?.(ev);
			},
		});
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
						numTurns: 0,
						totalCostUsd: 0,
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
			} catch {}
		}
		throw err;
	}
	release();

	if (result.isError && !result.result && !result.streamedText) throw new Error(`${harnessName} reported an error and produced no output`);

	const actualModel = result.model ?? model ?? null;
	const promptTokens = result.usage === null ? null : result.usage.inputTokens + result.usage.cacheCreationInputTokens + result.usage.cacheReadInputTokens;
	const contextPercent = promptTokens !== null && result.contextWindow ? (promptTokens / result.contextWindow) * 100 : null;

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
		},
		result,
		activityLog: collectActivityLog(activityEvents),
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
function injectReport(_ctx: ExtensionContext, opts: { harness: string; mode: string; metrics: string; body: string; file?: string; sessionId?: string }): void {
	pendingReport = {
		content: buildReportContent({ harness: opts.harness, mode: opts.mode, metrics: opts.metrics, body: opts.body, file: opts.file, sessionId: opts.sessionId }),
		details: { harness: opts.harness, mode: opts.mode, file: opts.file, sessionId: opts.sessionId, metrics: opts.metrics },
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
			'Delegate a task to any harness (claude, codex, opencode, amp) running headless in the repo and return its streamed report (cost, token usage, context %, session id). harness selects the backend (default from config, fallback claude). mode selects a template: review, plan, implement, security-audit, docs, general, or custom. scope restricts work: diff for current git diff, pr for PR diff, path list, or whole repo. sessionId continues a prior session.',
		promptSnippet: 'Delegate a subtask to a harness and return its report',
		promptGuidelines: [
			'delegate runs a harness headless in the working directory and returns a streamed report with cost, token usage, and a session id for follow-ups.',
			'Pass harness (claude|codex|opencode|amp) + focused task string + intent and constraints. Use scope: diff for current git diff, pr for PR diff, path list, or omit for whole repo.',
			'mode selects the template and its permission level: review/plan/security-audit are readonly; implement/docs/general are edit. Custom template names also work.',
			'sessionId resumes a previous delegated session instead of starting fresh.',
			'Do not set allowDangerous unless the user explicitly asks for unrestricted access (danger permission).',
		],
		parameters: Type.Object({
			harness: Type.Optional(Type.String({ description: 'Harness to use: claude, codex, opencode, amp (aliases: omp). Defaults to config defaultHarness.' })),
			task: Type.String({ description: 'The task/intent to delegate. Be specific.' }),
			mode: Type.Optional(Type.String({ description: 'Template/mode to run: review, plan, implement, security-audit, docs, general, or custom. Defaults to config defaultMode.' })),
			scope: Type.Optional(Type.String({ description: 'Restrict the work: diff (git diff), pr (PR diff), comma/space-separated path list, or omit for whole repo.' })),
			model: Type.Optional(Type.String({ description: 'Model (e.g. sonnet, opus, gpt-5). Defaults to template/config.' })),
			maxBudgetUsd: Type.Optional(Type.Number({ description: 'Hard spend cap in USD for the run.' })),
			sessionId: Type.Optional(Type.String({ description: 'Resume an existing delegated session (pass its session id from a previous run details).' })),
			allowDangerous: Type.Optional(Type.Boolean({ description: 'Escalate to danger permission (unrestricted). Only with explicit user approval.' })),
			pr: Type.Optional(Type.String({ description: 'GitHub PR number/URL (alternative to scope pr).' })),
		}),
		async execute(_toolCallId: string, params: { harness?: string; task: string; mode?: string; scope?: string; model?: string; maxBudgetUsd?: number; allowDangerous?: boolean; sessionId?: string; pr?: string }, signal: AbortSignal | undefined, onUpdate: ((u: { content: { type: string; text: string }[]; details: { progress: number } }) => void) | undefined, ctx: ExtensionContext) {
			const config = loadConfig();
			const feed: string[] = [];
			let liveTail = '';
			let thinkingChars = 0;
			let lastPushAt = 0;
			const THROTTLE_MS = 250;
			const pushFeed = () => {
				const now = Date.now();
				if (now - lastPushAt < THROTTLE_MS) return;
				lastPushAt = now;
				const lines: string[] = [...feed.slice(-6)];
				if (thinkingChars > 0) lines.push(config.inspectThinking ? `💭 thinking… (${thinkingChars} chars)` : '💭 thinking…');
				if (liveTail) lines.push(`✍ ${liveTail}`);
				if (lines.length === 0) return;
				onUpdate?.({ content: [{ type: 'text', text: lines.join('\n') }], details: { progress: 0.5 } });
			};
			const { content, details, result } = await delegate(pi, ctx, {
				harness: params.harness,
				task: params.task,
				mode: params.mode,
				scope: params.scope,
				model: params.model,
				maxBudgetUsd: params.maxBudgetUsd,
				allowDangerous: params.allowDangerous ?? config.allowDangerous,
				sessionId: params.sessionId,
				pr: params.pr,
				signal,
				onStream: (text) => {
					liveTail = (liveTail + text).slice(-400);
					pushFeed();
				},
				onActivity: (ev) => {
					if (ev.kind === 'tool_input') {
						feed.push(`▶ ${formatToolUse(ev.name, ev.input)}`);
						if (feed.length > 40) feed.splice(0, feed.length - 40);
					} else if (ev.kind === 'tool_result') {
						const last = feed.length - 1;
						if (last >= 0 && feed[last].startsWith('▶')) feed[last] += ev.isError ? ' ✗' : ' ✓';
					} else if (ev.kind === 'thinking') thinkingChars += ev.chars;
					pushFeed();
				},
			});
			const summary = summarize(content);
			const resumed = details.resumed ? ' · resumed' : '';
			const head = result.isError ? `⚠ ${details.harness} reported an error` : `${details.harness} ${details.mode} (${result.numTurns} turn(s), $${result.totalCostUsd.toFixed(3)})${resumed}`;
			const body = result.isError ? `\n${summary.text}` : `\n\n${summary.text}`;
			const footer = summary.truncated ? `\nFull output: ${details.file}` : `\nTranscript: ${details.file}`;
			(details as Record<string, unknown>).markdown = summary.text;
			return { content: [{ type: 'text', text: `${head}${body}${footer}` }], details, usage: result.usage ? mapClaudeUsage({ ...result.usage, totalCostUsd: result.totalCostUsd }) : undefined };
		},
		renderCall(args: unknown, theme: { fg: (c: string, s: string) => string; bg: (c: string, s: string) => string }) {
			const params = args as { harness?: string; mode?: string; task?: string };
			const harness = params.harness ?? 'delegate';
			const mode = params.mode ?? 'general';
			const task = params.task ?? '';
			const taskStr = task ? ` — ${task.length > 60 ? `${task.slice(0, 59)}…` : task}` : '';
			return new Text(theme.fg('accent', `${harness} ${mode}`) + theme.fg('dim', taskStr), 1, 1, (s) => theme.bg('toolPendingBg', s));
		},
		renderResult(result: { content?: { type: string; text: string }[]; details?: Record<string, unknown> }, options: { isPartial: boolean }, theme: { fg: (c: string, s: string) => string; bg: (c: string, s: string) => string }) {
			if (options.isPartial) {
				const text = (result.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
				return new Text(text, 1, 1, (s) => theme.bg('toolPendingBg', s));
			}
			const details = (result.details ?? {}) as Record<string, unknown>;
			const harness = typeof details.harness === 'string' ? details.harness : 'delegate';
			const mode = typeof details.mode === 'string' ? details.mode : 'delegate';
			const cost = typeof details.totalCostUsd === 'number' ? details.totalCostUsd : 0;
			const turns = typeof details.numTurns === 'number' ? details.numTurns : 0;
			const isError = details.isError === true;
			const resumed = details.resumed === true;
			const file = typeof details.file === 'string' ? details.file : null;
			const sessionId = typeof details.sessionId === 'string' ? details.sessionId : null;
			const container = new Container();
			container.addChild(new Text(theme.fg(isError ? 'error' : 'accent', `${harness} ${mode}`) + theme.fg('dim', ` · ${turns} turn(s) · `) + theme.fg('warning', `$${cost.toFixed(3)}`) + (resumed ? theme.fg('dim', ' · resumed') : ''), 1, 1));
			const md = typeof details.markdown === 'string' && details.markdown ? details.markdown : null;
			if (md) container.addChild(new Markdown(md, 1, 1, getMarkdownTheme()));
			else {
				const text = (result.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
				container.addChild(new Text(text, 1, 1));
			}
			const foot: string[] = [];
			if (file) foot.push(`Transcript: ${file}`);
			if (sessionId) foot.push(`Resume: /delegate --resume=${sessionId} <prompt>`);
			if (foot.length > 0) container.addChild(new Text(theme.fg('dim', foot.join('   ')), 1, 1));
			return container;
		},
	};

	pi.registerTool(delegateToolDef as unknown as Parameters<typeof pi.registerTool>[0]);

	// deprecated alias
	pi.registerTool({
		name: 'claude_delegate',
		label: 'Claude Delegate (deprecated)',
		description: 'Deprecated alias for delegate{harness:claude}. Use delegate tool with harness:claude instead. ' + (delegateToolDef as { description: string }).description,
		promptSnippet: 'Delegate a subtask to Claude Code (deprecated alias)',
		promptGuidelines: [...(delegateToolDef as unknown as { promptGuidelines: string[] }).promptGuidelines],
		parameters: (delegateToolDef as { parameters: unknown }).parameters as never,
		async execute(toolCallId: string, params: { harness?: string; task: string; mode?: string; scope?: string; model?: string; maxBudgetUsd?: number; allowDangerous?: boolean; sessionId?: string; pr?: string }, signal: AbortSignal | undefined, onUpdate: never, ctx: ExtensionContext) {
			return (delegateToolDef as unknown as { execute: (a: string, b: unknown, c: unknown, d: unknown, e: unknown) => Promise<unknown> }).execute(toolCallId, { ...params, harness: 'claude' }, signal, onUpdate, ctx);
		},
		renderCall: (delegateToolDef as unknown as { renderCall: (a: unknown, b: unknown) => unknown }).renderCall,
		renderResult: (delegateToolDef as unknown as { renderResult: (a: unknown, b: unknown, c: unknown) => unknown }).renderResult,
	} as unknown as Parameters<typeof pi.registerTool>[0]);

	// ── Commands ─────────────────────────────────────────────────────────────
	const makeHandler = (forcedHarness?: string) => async (args: string, ctx: ExtensionContext) => {
		const sub = args.trim();
		if (sub === 'watch' || sub === 'show') {
			if (activeOverlay) {
				activeOverlay.show();
				activeOverlay.focus();
			} else {
				ctx.ui.notify?.('No active delegate run to show — start one with /delegate <harness> <mode> <prompt>', 'info');
			}
			return;
		}
		if (sub === 'list') {
			await showModes(ctx, forcedHarness);
			return;
		}
		if (sub.startsWith('list ')) {
			const h = sub.slice(5).trim();
			if (isKnownHarness(h)) {
				await showModes(ctx, h);
				return;
			}
		}
		if (sub === 'history' || sub === 'logs') {
			await showHistory(ctx);
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
		const harnessName = parsed.harness ?? loadConfig().defaultHarness ?? 'claude';
		const templates = loadTemplates(ctx.cwd, harnessName);
		const resolved = resolveDefaults(parsed, templates);
		const template = parsed.mode ? templates.get(parsed.mode) : undefined;
		const isDanger = template?.permission === 'danger' || template?.permissionMode === 'bypassPermissions';

		if (!resolved) {
			if (parsed.mode) ctx.ui.notify?.(`/delegate ${parsed.mode} <what to do> — give a prompt for the "${parsed.mode}" mode`, 'warning');
			else ctx.ui.notify?.('Usage: /delegate [--harness=claude|codex|opencode|amp] [--mode=…] [--model=…] [--scope=…] <prompt>', 'warning');
			return;
		}
		const modeForDisplay = parsed.mode ?? 'general';
		const harnessForDisplay = harnessName;

		const feed: FeedEntry[] = [];
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
		let chipLastPush = 0;
		const pushChip = () => {
			if (!ctx.hasUI) return;
			const now = Date.now();
			if (now - chipLastPush < 500) return;
			chipLastPush = now;
			const theme = ctx.ui.theme;
			const activity = chipActivity ? ` ${chipActivity}` : theme.fg('dim', ' running…');
			ctx.ui.setStatus('delegate', theme.fg('accent', '●') + theme.fg('dim', ` ${harnessForDisplay} ${modeForDisplay}`) + activity);
		};
		const onActivity = (ev: ActivityEvent) => {
			if (ev.kind === 'tool_input') {
				chipActivity = `▶ ${formatToolUse(ev.name, ev.input)}`;
				feed.push({ kind: 'tool', text: formatToolUse(ev.name, ev.input) });
				if (feed.length > 40) feed.splice(0, feed.length - 40);
			} else if (ev.kind === 'tool_result') {
				if (chipActivity.startsWith('▶')) chipActivity += ev.isError ? ' ✗' : ' ✓';
				const last = feed.length - 1;
				if (last >= 0 && feed[last].kind === 'tool') feed[last] = { ...feed[last], ok: ev.isError ? false : true };
			} else if (ev.kind === 'thinking') {
				chipActivity = '💭 thinking…';
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
			task: resolved.task,
			mode: parsed.mode,
			scope: resolved.scope,
			model: parsed.model,
			maxBudgetUsd: parsed.budget,
			sessionId: parsed.sessionId,
			pr: parsed.pr,
			signal: ac.signal,
			onStream: (t) => {
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
							mode: `${harnessForDisplay} ${modeForDisplay}`,
							model: parsed.model ?? template?.model ?? loadConfig().harnesses[harnessName]?.model ?? loadConfig().model,
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
					{ overlay: true, overlayOptions: { width: '70%', maxHeight: '60%', anchor: 'top-center' }, onHandle: (h) => { overlayHandle = h; activeOverlay = { show: () => h.setHidden(false), focus: () => h.focus(), runId }; h.focus(); } },
				)
				.catch(() => {});
			result = await run;
			await closeWhenMounted(() => closeWindow, 2000);
			await uiPromise;
		} else {
			result = await run;
		}
		clearActive();
		if (cancelled || !result) {
			if (ctx.hasUI) ctx.ui.setStatus('delegate', undefined);
			const message = runState.error ? runState.error.message : cancelled ? 'cancelled' : 'delegation failed';
			if (ctx.hasUI) ctx.ui.notify(`delegate ${cancelled ? 'cancelled' : 'failed'}: ${message}`, cancelled ? 'warning' : 'error');
			else process.stderr.write(`${message}\n`);
			return;
		}
		const { content, details } = result;
		const summary = summarize(content);
		const file = (details.file as string) ?? null;
		const sessionId = (details.sessionId as string) ?? null;
		const resumeHint = sessionId ? ` · resume: /delegate --resume=${sessionId} <prompt>` : '';
		const usage = details.usage as { inputTokens?: number; outputTokens?: number; cacheCreationInputTokens?: number; cacheReadInputTokens?: number } | undefined;
		const promptTokens = usage ? (usage.inputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0) + (usage.cacheReadInputTokens ?? 0) : 0;
		const metrics = formatMetrics({
			numTurns: (details.numTurns as number) ?? 0,
			totalCostUsd: (details.totalCostUsd as number) ?? 0,
			promptTokens,
			contextPercent: typeof details.contextPercent === 'number' ? (details.contextPercent as number) : null,
			durationMs: typeof details.durationMs === 'number' && details.durationMs !== null ? (details.durationMs as number) : null,
		});
		injectReport(ctx, { harness: details.harness as string, mode: details.mode as string, metrics, body: summary.text, file: file ?? undefined, sessionId: sessionId ?? undefined });
		if (ctx.hasUI) {
			ctx.ui.setStatus('delegate', undefined);
			ctx.ui.notify(`${details.harness} ${details.mode} done — ${metrics}${resumeHint} · transcript: ${file}`, 'info');
		} else process.stdout.write(`${summary.text}\n`);
	};

	pi.registerCommand('delegate', { description: 'Delegate a task to any harness. Usage: /delegate [--harness=claude|codex|opencode|amp] [--mode=review|plan|implement|security-audit|docs|general] [--model=...] [--scope=diff|pr|paths] [--resume=<id>] <prompt> — or use harness as first word: /delegate codex review <prompt>', handler: makeHandler() });
	pi.registerCommand('claude', { description: 'Alias for /delegate --harness=claude. Usage: /claude [--mode=...] <prompt>', handler: makeHandler('claude') });
	pi.registerCommand('codex', { description: 'Alias for /delegate --harness=codex. Usage: /codex [--mode=...] <prompt>', handler: makeHandler('codex') });
	pi.registerCommand('opencode', { description: 'Alias for /delegate --harness=opencode. Usage: /opencode [--mode=...] <prompt>', handler: makeHandler('opencode') });
	pi.registerCommand('amp', { description: 'Alias for /delegate --harness=amp. Usage: /amp [--mode=...] <prompt>', handler: makeHandler('amp') });
	pi.registerCommand('omp', { description: 'Alias for /delegate --harness=amp (omp compat). Usage: /omp [--mode=...] <prompt>', handler: makeHandler('amp') });

	pi.on('input', async (event, ctx) => {
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
