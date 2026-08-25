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

function extractCodexText(o: Record<string, unknown>, _state: ParseState): string | undefined {
  if (typeof o.text === 'string' && o.type !== 'tool_use') return o.text;
  if (typeof o.output === 'string') return o.output;
  if (typeof o.delta === 'string') return o.delta;
  if (typeof o.message === 'string') return o.message;
  if (isRecord(o.event) && typeof o.event.text === 'string') return o.event.text;
  if (isRecord(o.item) && typeof o.item.text === 'string') return o.item.text;
  if (isRecord(o.item) && typeof o.item.output === 'string') return o.item.output;
  if (o.type === 'agent_message' && typeof o.text === 'string') return o.text;
  // codex error has message field at top level
  if (o.type === 'error' && typeof o.message === 'string') return o.message;
  return undefined;
}

export function parseCodexLine(line: string, state: ParseState): ParseOutcome {
  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch {
    if (line.trim().length > 0) return { streamedText: line + '\n', activities: [] };
    return { activities: [] };
  }
  if (!isRecord(o)) return { activities: [] };

  const activities: ParseOutcome['activities'] = [];
  let streamedText: string | undefined;
  const typeStr = typeof o.type === 'string' ? o.type : '';
  const item = isRecord(o.item) ? o.item : null;

  // Error handling: codex emits {"type":"error","message":"..."} and turn.failed
  if (typeStr === 'error' && typeof o.message === 'string') {
    streamedText = o.message;
    // treat as thinking or error activity? not needed, but capture as streamed
    // don't return as final result yet — wait for turn.failed
  }
  if (typeStr === 'turn.failed' || typeStr === 'turn.failed') {
    const msg =
      isRecord(o.error) && typeof o.error.message === 'string'
        ? o.error.message
        : typeof o.message === 'string'
          ? o.message
          : state.streamedText + (streamedText ?? '');
    const result: StreamedResult = {
      result: msg,
      isError: true,
      numTurns: 1,
      totalCostUsd: 0,
      sessionId: typeof o.thread_id === 'string' ? o.thread_id : typeof o.session_id === 'string' ? o.session_id : null,
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

  // Tool activity heuristics
  if (typeStr.includes('tool') || typeStr.includes('item.started') || typeStr.includes('function_call')) {
    const toolName = item && typeof item.name === 'string' ? item.name : typeof o.name === 'string' ? o.name : null;
    if (toolName) {
      if (typeStr.includes('started') || o.type === 'tool_use') {
        activities.push({ kind: 'tool_start', name: toolName });
        if (item && isRecord(item.input))
          activities.push({ kind: 'tool_input', name: toolName, input: item.input as Record<string, unknown> });
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
    const thinkingText = extractCodexText(o, state);
    if (thinkingText) activities.push({ kind: 'thinking', chars: thinkingText.length });
    else activities.push({ kind: 'thinking', chars: 10 });
  }

  // Thread/turn lifecycle: not text, ignore
  if (typeStr === 'thread.started' || typeStr === 'turn.started' || typeStr === 'thread.completed') {
    // thread.started carries thread_id, we could store it, but not needed for streaming
    if (typeStr === 'thread.completed' && typeof o.thread_id === 'string') {
      // treat as result if no other result
      const result: StreamedResult = {
        result: state.streamedText || '',
        isError: false,
        numTurns: 1,
        totalCostUsd: 0,
        sessionId: o.thread_id,
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
      return { activities, streamedText, result };
    }
    return { activities, streamedText };
  }

  const text = extractCodexText(o, state);
  if (
    text &&
    !typeStr.includes('tool') &&
    !typeStr.includes('thinking') &&
    typeStr !== 'error' &&
    typeStr !== 'turn.failed'
  ) {
    streamedText = text;
  }

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
      totalCostUsd: typeof o.total_cost_usd === 'number' ? o.total_cost_usd : typeof o.cost === 'number' ? o.cost : 0,
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
    const sandbox = opts.nativePermission ?? SANDBOX_MAP[opts.permission] ?? 'workspace-write';
    const args = ['exec', '--json', opts.prompt, '--sandbox', sandbox];
    if (opts.permission === 'danger' || sandbox === 'danger-full-access') args.push('--ask-for-approval', 'never');
    else if (opts.permission === 'readonly') args.push('--ask-for-approval', 'never');
    else args.push('--ask-for-approval', 'on-request');
    if (opts.model) args.push('--model', opts.model);
    if (opts.resumeSessionId) args.push('--thread-id', opts.resumeSessionId);
    for (const dir of opts.addDirs ?? []) args.push('--add-dir', dir);
    return args;
  },
  parseLine(line: string, state: ParseState): ParseOutcome {
    return parseCodexLine(line, state);
  },
  extractResult(state: ParseState): StreamedResult | null {
    if (state.result) return state.result;
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
