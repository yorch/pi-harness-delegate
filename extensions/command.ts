import type { DelegateTemplate } from './templates.ts';

/**
 * Pure parser for /delegate and alias commands: --key=value flags, with optional
 * harness as first word and template name as next word.
 */

export interface DelegateCommandArgs {
	task: string;
	harness?: string;
	mode?: string;
	model?: string;
	scope?: string;
	budget?: number;
	/** Resume an existing delegated session (--resume=<id>). */
	sessionId?: string;
	/** GitHub PR number/URL to review (--pr=). */
	pr?: string;
}

export type ClaudeCommandArgs = DelegateCommandArgs;

const KNOWN_HARNESSES = new Set(['claude', 'codex', 'opencode', 'amp', 'omp']);

export function parseDelegateCommand(
	raw: string,
	knownModes: ReadonlySet<string>,
	knownHarnesses: ReadonlySet<string> = KNOWN_HARNESSES,
): DelegateCommandArgs {
	const flags: Record<string, string> = {};
	const rest = raw.replace(/--([a-zA-Z-]+)=(\S+)/g, (_m, k: string, v: string) => {
		flags[k] = v;
		return '';
	});

	let harness = flags.harness?.toLowerCase();
	let mode = flags.mode;
	let task = rest.trim();

	// First word handling: harness, mode, or both
	const words = task.split(/\s+/).filter(Boolean);
	let idx = 0;
	if (!harness && words[idx] && knownHarnesses.has(words[idx].toLowerCase())) {
		harness = words[idx].toLowerCase();
		if (harness === 'omp') harness = 'amp';
		idx++;
	}
	if (!mode && words[idx] && knownModes.has(words[idx])) {
		mode = words[idx];
		idx++;
	}
	if (idx > 0) task = words.slice(idx).join(' ').trim();

	const out: DelegateCommandArgs = { task };
	if (harness) out.harness = harness;
	if (mode) out.mode = mode;
	if (flags.model) out.model = flags.model;
	if (flags.scope) out.scope = flags.scope;
	if (flags.budget !== undefined) {
		const budget = Number(flags.budget);
		if (Number.isFinite(budget) && budget > 0) out.budget = budget;
	}
	if (flags.resume) out.sessionId = flags.resume;
	if (flags.pr) out.pr = flags.pr;
	return out;
}

export function parseClaudeCommand(raw: string, knownModes: ReadonlySet<string>): ClaudeCommandArgs {
	return parseDelegateCommand(raw, knownModes);
}

/**
 * Apply template defaults when the prompt is empty.
 */
export function resolveDefaults(
	args: DelegateCommandArgs,
	templates: ReadonlyMap<string, DelegateTemplate>,
): { task: string; scope?: string } | null {
	if (args.task) {
		return args.scope ? { task: args.task, scope: args.scope } : { task: args.task };
	}
	if (args.mode) {
		const t = templates.get(args.mode);
		if (t?.defaultTask) {
			const scope = args.scope ?? t.defaultScope;
			return scope ? { task: t.defaultTask, scope } : { task: t.defaultTask };
		}
		return null;
	}
	return null;
}
