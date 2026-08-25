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

const PERMISSION_MAP: Record<NormalizedPermission, string> = {
  readonly: 'read-only',
  edit: 'workspace',
  danger: 'danger',
};

function extractAmpText(o: Record<string, unknown>): string | undefined {
  if (typeof o.text === 'string') return o.text;
  if (typeof o.output === 'string') return o.output;
  if (typeof o.delta === 'string') return o.delta;
  if (typeof o.content === 'string') return o.content;
  if (isRecord(o.part) && typeof o.part.text === 'string') return o.part.text;
  return undefined;
}

export function parseAmpLine(line: string, state: ParseState): ParseOutcome {
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

  // Tool activity: amp may emit via mcp__* or tool_use
  if (typeStr.includes('tool') || o.type === 'tool_use') {
    const name = typeof o.name === 'string' ? o.name : 'tool';
    if (typeStr.includes('start') || o.type === 'tool_use') {
      activities.push({ kind: 'tool_start', name });
      if (isRecord(o.input)) activities.push({ kind: 'tool_input', name, input: o.input as Record<string, unknown> });
    } else {
      activities.push({ kind: 'tool_result', isError: o.is_error === true });
    }
  }

  // Thinking: amp fixture has message with thinking, and message_update thinking_delta
  if (typeStr.includes('thinking')) activities.push({ kind: 'thinking', chars: 10 });
  // amp message_update thinking_delta
  if (typeStr === 'message_update' && isRecord(o.assistantMessageEvent)) {
    const ev = o.assistantMessageEvent as Record<string, unknown>;
    if (ev.type === 'thinking_delta' && typeof ev.delta === 'string') {
      activities.push({ kind: 'thinking', chars: ev.delta.length });
    } else if (ev.type === 'text_delta' && typeof ev.delta === 'string') {
      streamedText = ev.delta;
    } else if (ev.type === 'thinking_start') {
      activities.push({ kind: 'thinking', chars: 5 });
    }
  }
  // turn_end / agent_end may carry final text in message.content
  if (typeStr === 'turn_end' || typeStr === 'agent_end') {
    const msg = isRecord(o.message) ? o.message : null;
    if (msg && Array.isArray(msg.content)) {
      for (const block of msg.content as unknown[]) {
        if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
          streamedText = block.text;
        }
        if (isRecord(block) && block.type === 'thinking' && typeof block.thinking === 'string') {
          activities.push({ kind: 'thinking', chars: (block.thinking as string).length });
        }
      }
    }
    // also check top-level messages array for agent_end
    if (Array.isArray(o.messages)) {
      const last = o.messages[o.messages.length - 1] as unknown;
      if (isRecord(last) && Array.isArray(last.content)) {
        for (const block of last.content as unknown[]) {
          if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
            // this is final text, but we already have streamedText from deltas, so keep it as fallback
            if (!streamedText) streamedText = block.text as string;
          }
        }
      }
    }
  }

  const text = extractAmpText(o);
  if (text && !typeStr.includes('tool') && !streamedText) streamedText = text;

  // Terminal: amp uses turn_end / agent_end with usage, also result/done
  if (
    o.type === 'result' ||
    o.type === 'done' ||
    o.type === 'completed' ||
    typeStr === 'turn_end' ||
    typeStr === 'agent_end'
  ) {
    const usage = isRecord(o.usage)
      ? o.usage
      : isRecord(o.message) && isRecord(o.message.usage)
        ? o.message.usage
        : null;
    // For turn_end, usage is in o.message.usage
    const actualUsage = isRecord(usage)
      ? usage
      : isRecord(o.message) && isRecord((o.message as Record<string, unknown>).usage)
        ? ((o.message as Record<string, unknown>).usage as Record<string, unknown>)
        : null;
    const msg = isRecord(o.message) ? o.message : null;
    const cost =
      isRecord(actualUsage) && typeof actualUsage.total === 'number'
        ? actualUsage.total
        : typeof o.total_cost_usd === 'number'
          ? o.total_cost_usd
          : 0;
    // amp usage shape: {input, output, totalTokens, cost} with cost nested
    const inputTokens = isRecord(actualUsage)
      ? typeof actualUsage.input === 'number'
        ? actualUsage.input
        : typeof actualUsage.input_tokens === 'number'
          ? actualUsage.input_tokens
          : 0
      : 0;
    const outputTokens = isRecord(actualUsage)
      ? typeof actualUsage.output === 'number'
        ? actualUsage.output
        : typeof actualUsage.output_tokens === 'number'
          ? actualUsage.output_tokens
          : 0
      : 0;
    const result: StreamedResult = {
      result:
        typeof o.result === 'string'
          ? o.result
          : streamedText
            ? state.streamedText + streamedText
            : state.streamedText || (text ?? ''),
      isError: o.is_error === true,
      numTurns: 1,
      totalCostUsd: typeof cost === 'number' ? cost : 0,
      sessionId: typeof o.session_id === 'string' ? o.session_id : typeof o.id === 'string' ? o.id : null,
      stopReason:
        typeof o.stop_reason === 'string'
          ? o.stop_reason
          : typeof msg?.stopReason === 'string'
            ? (msg.stopReason as string)
            : null,
      permissionDenials: [],
      durationMs:
        typeof o.duration_ms === 'number' ? o.duration_ms : typeof o.duration === 'number' ? o.duration : null,
      durationApiMs: null,
      ttftMs: typeof o.ttft === 'number' ? o.ttft : null,
      model: typeof o.model === 'string' ? o.model : typeof msg?.model === 'string' ? (msg.model as string) : null,
      contextWindow: null,
      maxOutputTokens: null,
      usage:
        actualUsage && (inputTokens || outputTokens)
          ? {
              inputTokens,
              outputTokens,
              cacheCreationInputTokens: 0,
              cacheReadInputTokens: typeof actualUsage.cacheRead === 'number' ? actualUsage.cacheRead : 0,
            }
          : null,
    };
    // For turn_end/agent_end, ensure result is present from streamedText
    if (!result.result) result.result = state.streamedText + (streamedText ?? '');
    return { activities, streamedText, result };
  }
  return { activities, streamedText };
}

export const ampHarness: Harness = {
  name: 'amp',
  displayName: 'Amp',
  binary: 'amp',
  async detect() {
    try {
      const { stdout } = await execFileAsync('amp', ['--version'], { timeout: 5000 });
      return { ok: true, version: stdout.trim() };
    } catch {
      try {
        const { stdout } = await execFileAsync('omp', ['--version'], { timeout: 5000 });
        return { ok: true, version: stdout.trim() };
      } catch {
        return { ok: false, hint: 'Install Amp: https://ampcode.com' };
      }
    }
  },
  buildArgs(opts: BuildArgsOpts): string[] {
    const perm = opts.nativePermission ?? PERMISSION_MAP[opts.permission] ?? 'workspace';
    const args = ['--output', 'jsonl', opts.prompt, '--permission', perm];
    if (opts.model) args.push('--model', opts.model);
    if (opts.resumeSessionId) args.push('--resume', opts.resumeSessionId);
    for (const dir of opts.addDirs ?? []) args.push('--add-dir', dir);
    return args;
  },
  parseLine(line: string, state: ParseState): ParseOutcome {
    return parseAmpLine(line, state);
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
    edit: ['workspace'],
    danger: ['danger'],
  },
};
