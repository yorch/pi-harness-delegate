import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
	BuildArgsOpts,
	Harness,
	NormalizedPermission,
	ParseOutcome,
	ParseState,
	StreamedResult,
} from './types.ts';

const execFileAsync = promisify(execFile);

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const SANDBOX_MAP: Record<NormalizedPermission, string> = {
	readonly: 'read-only',
	edit: 'workspace-write',
	danger: 'danger-full-access',
};

function extractTextFromCodexEvent(o: Record<string, unknown>, state: ParseState): string | undefined {
	// Codex JSON variants: try common shapes
	// 1. {type:"item.completed", item:{type:"agent_message", text:"..."}}
	// 2. {type:"thread.item.completed", item:{type:"agent_message", ...}}
	// 3. {type:"event", event:{type:"response.output_text.delta", delta:"..."}}
	// 4. Plain {"text":"..."} or {"output":"..."}
	if (typeof o.text === 'string' && o.type !== 'tool_use') return o.text;
	if (typeof o.output === 'string') return o.output;
	if (typeof o.delta === 'string') return o.delta;
	if (isRecord(o.event) && typeof o.event.text === 'string') return o.event.text;
	if (isRecord(o.event) && typeof (o.event as Record<string, unknown>).delta === 'string')
		return (o.event as Record<string, unknown>).delta as string;
	if (isRecord(o.item) && typeof o.item.text === 'string') return o.item.text;
	if (isRecord(o.item) && typeof o.item.output === 'string') return o.item.output;
	// agent_message
	if (o.type === 'agent_message' && typeof o.text === 'string') return o.text;
	return undefined;
}

export function parseCodexLine(line: string, state: ParseState): ParseOutcome {
	let o: unknown;
	try {
		o = JSON.parse(line);
	} catch {
		// Non-JSON line: treat as streamed text (codex may emit plain text)
		if (line.trim().length > 0) return { streamedText: line + '\n', activities: [] };
		return { activities: [] };
	}
	if (!isRecord(o)) return { activities: [] };

	const activities: ParseOutcome['activities'] = [];
	let streamedText: string | undefined;

	// Tool activity heuristics
	// Codex may emit: {type:"item.started", item:{type:"tool_use", name:"...", input:{}}}
	// or {type:"tool_use", name:"..."}
	const item = isRecord(o.item) ? o.item : null;
	const typeStr = typeof o.type === 'string' ? o.type : '';

	if (typeStr.includes('tool') || typeStr.includes('item.started') || typeStr.includes('function_call')) {
		const toolName = (
			item && typeof item.name === 'string' ? item.name : typeof o.name === 'string' ? o.name : null
		) as string | null;
		if (toolName) {
			if (typeStr.includes('started') || o.type === 'tool_use') {
				activities.push({ kind: 'tool_start', name: toolName });
				if (item && isRecord(item.input))
					activities.push({
						kind: 'tool_input',
						name: toolName,
						input: item.input as Record<string, unknown>,
					});
				else if (isRecord(o.input))
					activities.push({ kind: 'tool_input', name: toolName, input: o.input as Record<string, unknown> });
			} else if (typeStr.includes('completed') || typeStr.includes('result')) {
				activities.push({ kind: 'tool_result', isError: o.is_error === true || o.error === true });
			}
		}
	}
	if (o.type === 'tool_result' || (typeStr === 'item.completed' && item?.type === 'tool_result')) {
		activities.push({ kind: 'tool_result', isError: (o as Record<string, unknown>).is_error === true });
	}
	if (typeStr.includes('thinking') || o.type === 'reasoning' || item?.type === 'reasoning') {
		const thinkingText = extractTextFromCodexEvent(o, state);
		if (thinkingText) activities.push({ kind: 'thinking', chars: thinkingText.length });
		else activities.push({ kind: 'thinking', chars: 10 });
	}

	// Text extraction
	const text = extractTextFromCodexEvent(o, state);
	if (text && !typeStr.includes('tool') && !typeStr.includes('thinking')) {
		// Avoid double-counting tool inputs as text
		streamedText = text;
	}

	// Result detection: final result often {type:"result", result:"...", total_cost_usd, usage, ...}
	// or {type:"thread.completed", ...}
	if (o.type === 'result' || o.type === 'thread.completed' || o.type === 'task.completed') {
		const usage = isRecord(o.usage) ? o.usage : null;
		const result: StreamedResult = {
			result:
				typeof o.result === 'string'
					? o.result
					: typeof o.output === 'string'
						? o.output
						: state.streamedText + (streamedText ?? ''),
			isError: o.is_error === true || o.error === true,
			numTurns: typeof o.num_turns === 'number' ? o.num_turns : typeof o.turns === 'number' ? o.turns : 0,
			totalCostUsd:
				typeof o.total_cost_usd === 'number' ? o.total_cost_usd : typeof o.cost === 'number' ? o.cost : 0,
			sessionId:
				typeof o.session_id === 'string'
					? o.session_id
					: typeof o.thread_id === 'string'
						? o.thread_id
						: typeof o.id === 'string'
							? o.id
							: null,
			stopReason: typeof o.stop_reason === 'string' ? o.stop_reason : null,
			permissionDenials: Array.isArray(o.permission_denials) ? o.permission_denials : [],
			durationMs: typeof o.duration_ms === 'number' ? o.duration_ms : null,
			durationApiMs: typeof o.duration_api_ms === 'number' ? o.duration_api_ms : null,
			ttftMs: typeof o.ttft_ms === 'number' ? o.ttft_ms : null,
			model: typeof o.model === 'string' ? o.model : null,
			contextWindow: typeof o.context_window === 'number' ? o.context_window : null,
			maxOutputTokens: null,
			usage: usage
				? {
						inputTokens:
							typeof usage.input_tokens === 'number'
								? usage.input_tokens
								: typeof (usage as Record<string, unknown>).inputTokens === 'number'
									? ((usage as Record<string, unknown>).inputTokens as number)
									: 0,
						outputTokens:
							typeof usage.output_tokens === 'number'
								? usage.output_tokens
								: typeof (usage as Record<string, unknown>).outputTokens === 'number'
									? ((usage as Record<string, unknown>).outputTokens as number)
									: 0,
						cacheCreationInputTokens:
							typeof (usage as Record<string, unknown>).cache_creation_input_tokens === 'number'
								? ((usage as Record<string, unknown>).cache_creation_input_tokens as number)
								: 0,
						cacheReadInputTokens:
							typeof (usage as Record<string, unknown>).cache_read_input_tokens === 'number'
								? ((usage as Record<string, unknown>).cache_read_input_tokens as number)
								: 0,
					}
				: null,
		};
		return { activities, streamedText, result };
	}

	return { activities, streamedText };
}

export const codexHarness: Harness = {
	name: 'codex',
	displayName: 'Muse',
	binary: 'codex',
	async detect() {
		try {
			const { stdout } = await execFileAsync('codex', ['--version'], { timeout: 5000 });
			return { ok: true, version: stdout.trim() };
		} catch {
			return { ok: false, hint: 'Install Muse: https://github.com/openai/codex' };
		}
	},
	buildArgs(opts: BuildArgsOpts): string[] {
		// codex exec --json <prompt> --sandbox <level> --ask-for-approval <level>
		const sandbox = opts.nativePermission ?? SANDBOX_MAP[opts.permission] ?? 'workspace-write';
		const args = ['exec', '--json', opts.prompt, '--sandbox', sandbox];
		if (opts.permission === 'danger' || sandbox === 'danger-full-access') args.push('--ask-for-approval', 'never');
		else if (opts.permission === 'readonly') args.push('--ask-for-approval', 'never');
		else args.push('--ask-for-approval', 'on-request');
		if (opts.model) args.push('--model', opts.model);
		if (opts.resumeSessionId) args.push('--thread-id', opts.resumeSessionId);
		// maxBudgetUsd not natively supported; pass as env hint via --config if needed
		for (const dir of opts.addDirs ?? []) args.push('--add-dir', dir);
		return args;
	},
	parseLine(line: string, state: ParseState): ParseOutcome {
		return parseCodexLine(line, state);
	},
	extractResult(state: ParseState): StreamedResult | null {
		if (state.result) return state.result;
		// Fallback: if no explicit result, synthesize from streamed text if any
		if (state.streamedText.trim().length > 0) {
			return {
				result: state.streamedText,
				isError: false,
				numTurns: 1,
				totalCostUsd: 0,
				sessionId: null,
				stopReason: null,
				permissionDenials: [],
				durationMs: null,
				durationApiMs: null,
				ttftMs: null,
				model: null,
				contextWindow: null,
				maxOutputTokens: null,
				usage: null,
			};
		}
		return null;
	},
	permissionMap: {
		readonly: ['read-only'],
		edit: ['workspace-write'],
		danger: ['danger-full-access'],
	},
};
