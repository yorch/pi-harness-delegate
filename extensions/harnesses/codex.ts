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

// Schema verified against codex-cli 0.149.1 — see tests/fixtures/codex.jsonl.
// `codex exec` in this version dropped `--ask-for-approval` entirely (exec is inherently
// non-interactive; sandbox alone governs what's allowed) and resume is a subcommand
// (`exec resume <id> <prompt>`), not a `--thread-id` flag — both confirmed via `codex exec
// --help` / `codex exec resume --help`, not just the JSONL capture.

const execFileAsync = promisify(execFile);
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
const SANDBOX_MAP: Record<NormalizedPermission, string> = {
  readonly: 'read-only',
  edit: 'workspace-write',
  danger: 'danger-full-access',
};
function extractTextFromCodexEvent(o: Record<string, unknown>, _state: ParseState): string | undefined {
  if (typeof o.text === 'string' && o.type !== 'tool_use') return o.text;
  if (typeof o.output === 'string') return o.output;
  if (typeof o.delta === 'string') return o.delta;
  if (isRecord(o.event) && typeof o.event.text === 'string') return o.event.text;
  if (isRecord(o.event) && typeof (o.event as Record<string, unknown>).delta === 'string')
    return (o.event as Record<string, unknown>).delta as string;
  if (isRecord(o.item) && typeof o.item.text === 'string') return o.item.text;
  if (isRecord(o.item) && typeof o.item.output === 'string') return o.item.output;
  if (o.type === 'agent_message' && typeof o.text === 'string') return o.text;
  if (o.type === 'error' && typeof o.message === 'string') return o.message;
  if (typeof o.error === 'string') return o.error;
  return undefined;
}

interface CodexHarnessState {
  sessionId?: string;
  turnCount?: number;
}

function harnessState(state: ParseState): CodexHarnessState {
  const s = (state._harness ?? {}) as CodexHarnessState;
  state._harness = s as unknown as Record<string, unknown>;
  return s;
}

export function parseCodexLine(line: string, state: ParseState): ParseOutcome {
  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch {
    if (line.trim().length > 0) return { streamedText: `${line}\n`, activities: [] };
    return { activities: [] };
  }
  if (!isRecord(o)) return { activities: [] };
  const activities: ParseOutcome['activities'] = [];
  let streamedText: string | undefined;
  const typeStr = typeof o.type === 'string' ? o.type : '';
  const item = isRecord(o.item) ? o.item : null;
  const hs = harnessState(state);
  // latch thread_id from thread.started
  if (typeStr === 'thread.started' && typeof o.thread_id === 'string') {
    hs.sessionId = o.thread_id;
    return { activities, streamedText };
  }
  if (typeStr === 'turn.started') {
    hs.turnCount = (hs.turnCount ?? 0) + 1;
    return { activities, streamedText };
  }
  if (typeStr === 'error' && typeof o.message === 'string') {
    streamedText = o.message;
  }
  if (typeof o.error === 'string' && !streamedText) streamedText = o.error;
  if (typeStr === 'turn.failed') {
    const msg =
      isRecord(o.error) && typeof o.error.message === 'string'
        ? o.error.message
        : typeof o.error === 'string'
          ? o.error
          : typeof o.message === 'string'
            ? o.message
            : state.streamedText + (streamedText ?? '');
    const result: StreamedResult = {
      result: msg,
      isError: true,
      numTurns: null,
      totalCostUsd: null,
      sessionId: typeof o.thread_id === 'string' ? o.thread_id : (hs.sessionId ?? null),
      stopReason: 'error',
      permissionDenials: [],
      durationMs: null,
      durationApiMs: null,
      ttftMs: null,
      model: null,
      contextWindow: null,
      maxOutputTokens: null,
      usage: null,
    };
    return { activities, streamedText, result };
  }
  // real tool schema: item.started/item.completed carry item.id (correlating id) and item.type
  // (no separate "name" field — command_execution is the only item type observed emitting a
  // shell command; other item types like file_change/mcp_tool_call may exist but weren't
  // captured, so the generic name/input guesses below stay as a fallback for those).
  if (
    item &&
    (typeStr === 'item.started' || typeStr === 'item.completed') &&
    item.type !== 'agent_message' &&
    item.type !== 'reasoning'
  ) {
    const id = typeof item.id === 'string' ? item.id : undefined;
    const name = typeof item.name === 'string' ? item.name : typeof item.type === 'string' ? item.type : 'tool';
    if (typeStr === 'item.started') {
      const input =
        typeof item.command === 'string' ? { command: item.command } : isRecord(item.input) ? item.input : {};
      activities.push({ kind: 'tool_start', name });
      activities.push({ kind: 'tool_input', name, input: input as Record<string, unknown>, id });
    } else {
      const isError =
        (typeof item.exit_code === 'number' && item.exit_code !== 0) ||
        item.status === 'failed' ||
        item.is_error === true;
      activities.push({ kind: 'tool_result', isError, id });
    }
  } else if (typeStr.includes('tool') || typeStr.includes('function_call')) {
    const toolName = (item && typeof item.name === 'string' ? item.name : typeof o.name === 'string' ? o.name : null) as
      | string
      | null;
    if (toolName) {
      if (typeStr.includes('started') || o.type === 'tool_use') {
        activities.push({ kind: 'tool_start', name: toolName });
        if (item && isRecord(item.input))
          activities.push({ kind: 'tool_input', name: toolName, input: item.input as Record<string, unknown> });
        else if (isRecord(o.input))
          activities.push({ kind: 'tool_input', name: toolName, input: o.input as Record<string, unknown> });
      } else if (typeStr.includes('completed') || typeStr.includes('result'))
        activities.push({ kind: 'tool_result', isError: o.is_error === true || o.error === true });
    }
  }
  if (o.type === 'tool_result')
    activities.push({ kind: 'tool_result', isError: (o as Record<string, unknown>).is_error === true });
  if (typeStr.includes('thinking') || o.type === 'reasoning' || item?.type === 'reasoning') {
    const thinkingText = extractTextFromCodexEvent(o, state);
    if (thinkingText) activities.push({ kind: 'thinking', chars: thinkingText.length });
    else activities.push({ kind: 'thinking', chars: 10 });
  }
  const text = extractTextFromCodexEvent(o, state);
  if (
    text &&
    !typeStr.includes('tool') &&
    !typeStr.includes('thinking') &&
    typeStr !== 'error' &&
    typeStr !== 'turn.failed'
  )
    streamedText = text;
  // real final-usage event is turn.completed (thread.completed/task.completed/result kept as
  // fallback in case another codex-cli version emits them instead).
  if (
    o.type === 'result' ||
    o.type === 'thread.completed' ||
    o.type === 'task.completed' ||
    typeStr === 'turn.completed'
  ) {
    const usage = isRecord(o.usage) ? o.usage : null;
    const result: StreamedResult = {
      result:
        typeof o.result === 'string'
          ? o.result
          : typeof o.output === 'string'
            ? o.output
            : state.streamedText + (streamedText ?? ''),
      isError: o.is_error === true || o.error === true,
      numTurns:
        typeof o.num_turns === 'number'
          ? o.num_turns
          : typeof o.turns === 'number'
            ? o.turns
            : hs.turnCount
              ? hs.turnCount
              : null,
      totalCostUsd:
        typeof o.total_cost_usd === 'number' ? o.total_cost_usd : typeof o.cost === 'number' ? o.cost : null,
      sessionId:
        typeof o.session_id === 'string'
          ? o.session_id
          : typeof o.thread_id === 'string'
            ? o.thread_id
            : typeof o.id === 'string'
              ? o.id
              : (hs.sessionId ?? null),
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
            // real fields: input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens
            // (no total_cost_usd anywhere in this schema — ChatGPT-plan auth doesn't report $ cost).
            inputTokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : 0,
            outputTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : 0,
            cacheCreationInputTokens:
              typeof usage.cache_write_input_tokens === 'number'
                ? usage.cache_write_input_tokens
                : typeof (usage as Record<string, unknown>).cache_creation_input_tokens === 'number'
                  ? ((usage as Record<string, unknown>).cache_creation_input_tokens as number)
                  : 0,
            cacheReadInputTokens:
              typeof usage.cached_input_tokens === 'number'
                ? usage.cached_input_tokens
                : typeof (usage as Record<string, unknown>).cache_read_input_tokens === 'number'
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
    const sandbox = opts.nativePermission ?? SANDBOX_MAP[opts.permission] ?? 'workspace-write';
    const args = opts.resumeSessionId
      ? ['exec', 'resume', opts.resumeSessionId, opts.prompt, '--json']
      : ['exec', '--json', opts.prompt, '--sandbox', sandbox];
    if (opts.model) args.push('--model', opts.model);
    for (const dir of opts.addDirs ?? []) args.push('--add-dir', dir);
    return args;
  },
  parseLine(line: string, state: ParseState): ParseOutcome {
    return parseCodexLine(line, state);
  },
  extractResult(state: ParseState): StreamedResult | null {
    if (state.result) return state.result;
    if (state.streamedText.trim().length > 0) {
      const latched = (state._harness as CodexHarnessState | undefined)?.sessionId;
      return {
        result: state.streamedText,
        isError: false,
        numTurns: null,
        totalCostUsd: null,
        sessionId: latched ?? null,
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
  permissionMap: { readonly: ['read-only'], edit: ['workspace-write'], danger: ['danger-full-access'] },
};
