import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_TIMEOUT_MS } from './harnesses/types.ts';

export interface HarnessConfig {
	model?: string;
	timeoutMs?: number;
	allowDangerous?: boolean;
	maxBudgetUsd?: number;
}

export interface DelegateConfig {
	model?: string;
	timeoutMs: number;
	defaultMode: string;
	defaultHarness: string;
	allowDangerous: boolean;
	inspectThinking: boolean;
	maxBudgetUsd?: number;
	autoDelegateHints: boolean;
	modelAliases: Record<string, string>;
	maxConcurrent: number;
	maxTranscripts: number;
	harnesses: Record<string, HarnessConfig>;
}

export function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent');
}

export function outputsDir(harness?: string): string {
	const base = join(agentDir(), 'delegate', 'outputs');
	return harness ? join(base, harness) : base;
}

export function legacyOutputsDir(): string {
	return join(agentDir(), 'claude-delegate', 'outputs');
}

export function loadConfig(): DelegateConfig {
	const cfg: DelegateConfig = {
		timeoutMs: DEFAULT_TIMEOUT_MS,
		defaultMode: 'general',
		defaultHarness: 'claude',
		allowDangerous: false,
		inspectThinking: false,
		autoDelegateHints: false,
		modelAliases: { economy: 'haiku', balanced: 'sonnet', max: 'opus' },
		maxConcurrent: 1,
		maxTranscripts: 100,
		harnesses: {},
	};
	try {
		const file = join(agentDir(), 'settings.json');
		if (!existsSync(file)) return cfg;
		const settings = JSON.parse(readFileSync(file, 'utf8')) as {
			delegate?: Partial<DelegateConfig & { harnesses: Record<string, HarnessConfig> }>;
			claudeDelegate?: Partial<DelegateConfig & { model?: string }>;
		};
		// Legacy claudeDelegate -> delegate.harnesses.claude migration
		if (settings.claudeDelegate && !settings.delegate) {
			const c = settings.claudeDelegate as Partial<DelegateConfig>;
			if (typeof c.model === 'string') cfg.harnesses['claude'] = { ...(cfg.harnesses['claude'] ?? {}), model: c.model };
			if (typeof c.timeoutMs === 'number' && c.timeoutMs > 0) cfg.timeoutMs = c.timeoutMs;
			if (typeof c.defaultMode === 'string') cfg.defaultMode = c.defaultMode;
			if (typeof c.allowDangerous === 'boolean') cfg.allowDangerous = c.allowDangerous;
			if (typeof c.inspectThinking === 'boolean') cfg.inspectThinking = c.inspectThinking;
			if (typeof (c as DelegateConfig).maxBudgetUsd === 'number' && (c as DelegateConfig).maxBudgetUsd! > 0) cfg.maxBudgetUsd = (c as DelegateConfig).maxBudgetUsd;
			if (typeof c.autoDelegateHints === 'boolean') cfg.autoDelegateHints = c.autoDelegateHints;
			if ((c as DelegateConfig).modelAliases && typeof (c as DelegateConfig).modelAliases === 'object') {
				for (const [k, v] of Object.entries((c as DelegateConfig).modelAliases!)) {
					if (typeof v === 'string' && v) cfg.modelAliases[k] = v;
				}
			}
			if (typeof c.maxConcurrent === 'number' && c.maxConcurrent >= 0) cfg.maxConcurrent = c.maxConcurrent;
			if (typeof c.maxTranscripts === 'number' && c.maxTranscripts >= 0) cfg.maxTranscripts = c.maxTranscripts;
			if (c.harnesses && typeof c.harnesses === 'object') {
				for (const [k, v] of Object.entries(c.harnesses)) {
					if (v && typeof v === 'object') cfg.harnesses[k] = { ...(cfg.harnesses[k] ?? {}), ...(v as HarnessConfig) };
				}
			}
			// also map harnesses.claude if any
			return cfg;
		}
		const d = settings.delegate ?? {};
		if (typeof d.defaultHarness === 'string' && d.defaultHarness) cfg.defaultHarness = d.defaultHarness;
		if (typeof d.defaultMode === 'string') cfg.defaultMode = d.defaultMode;
		if (typeof d.model === 'string') cfg.model = d.model;
		if (typeof d.timeoutMs === 'number' && d.timeoutMs > 0) cfg.timeoutMs = d.timeoutMs;
		if (typeof d.allowDangerous === 'boolean') cfg.allowDangerous = d.allowDangerous;
		if (typeof d.inspectThinking === 'boolean') cfg.inspectThinking = d.inspectThinking;
		if (typeof d.maxBudgetUsd === 'number' && d.maxBudgetUsd > 0) cfg.maxBudgetUsd = d.maxBudgetUsd;
		if (typeof d.autoDelegateHints === 'boolean') cfg.autoDelegateHints = d.autoDelegateHints;
		if (d.modelAliases && typeof d.modelAliases === 'object') {
			for (const [k, v] of Object.entries(d.modelAliases)) {
				if (typeof v === 'string' && v) cfg.modelAliases[k] = v;
			}
		}
		if (typeof d.maxConcurrent === 'number' && d.maxConcurrent >= 0) cfg.maxConcurrent = d.maxConcurrent;
		// maxConcurrent may be object {global, perHarness} — handle as number fallback
		if (typeof d.maxTranscripts === 'number' && d.maxTranscripts >= 0) cfg.maxTranscripts = d.maxTranscripts;
		if (d.harnesses && typeof d.harnesses === 'object') {
			for (const [k, v] of Object.entries(d.harnesses)) {
				if (v && typeof v === 'object') cfg.harnesses[k] = { ...(v as HarnessConfig) };
			}
		}
		// also support legacy claudeDelegate merged when delegate also present (delegate wins)
		if (settings.claudeDelegate) {
			const c = settings.claudeDelegate as Partial<DelegateConfig>;
			if (typeof c.model === 'string' && !cfg.harnesses['claude']?.model) {
				cfg.harnesses['claude'] = { ...(cfg.harnesses['claude'] ?? {}), model: c.model };
			}
		}
	} catch {
		// invalid settings — fall back to defaults
	}
	return cfg;
}

export function resolveModelForHarness(cfg: DelegateConfig, harness: string, model?: string, templateModel?: string): string | undefined {
	const resolve = (m?: string) => (m ? (cfg.modelAliases[m] ?? m) : undefined);
	return resolve(model) ?? resolve(templateModel) ?? resolve(cfg.harnesses[harness]?.model) ?? resolve(cfg.model);
}

export function getMaxConcurrent(cfg: DelegateConfig, harness?: string): number {
	if (typeof cfg.maxConcurrent === 'number') return cfg.maxConcurrent;
	// if object shape {global, perHarness}
	const mc = cfg.maxConcurrent as unknown as { global?: number; perHarness?: Record<string, number> };
	if (harness && mc.perHarness && typeof mc.perHarness[harness] === 'number') return mc.perHarness[harness]!;
	if (typeof mc.global === 'number') return mc.global;
	return 1;
}
