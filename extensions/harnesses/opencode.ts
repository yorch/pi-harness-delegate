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
  edit: 'allow-edit',
  danger: 'danger',
};

function extractOpencodeText(o: Record<string, unknown>): string | undefined {
  if (typeof o.text === 'string') return o.text;
  if (typeof o.output === 'string') return o.output;
  if (typeof o.delta === 'string') return o.delta;
  if (typeof o.content === 'string') return o.content;
  if (isRecord(o.part) && typeof o.part.text === 'string') return o.part.text;
  if (isRecord(o.event) && typeof o.event.text === 'string') return o.event.text;
  if (isRecord(o.message) && typeof o.message.text === 'string') return o.message.text;
  // opencode step_finish with part.tokens etc. not text
  return undefined;
}

export function parseOpencodeLine(line: string, state: ParseState): ParseOutcome {
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

  if (typeStr.includes('tool') || o.type === 'tool_use' || o.type === 'tool_result') {
    const name =
      typeof o.name === 'string'
        ? o.name
        : typeof (o as Record<string, unknown>).tool === 'string'
          ? ((o as Record<string, unknown>).tool as string)
          : 'tool';
    if (typeStr.includes('start') || o.type === 'tool_use') {
      activities.push({ kind: 'tool_start', name });
      if (isRecord(o.input)) activities.push({ kind: 'tool_input', name, input: o.input as Record<string, unknown> });
    } else if (typeStr.includes('result') || typeStr.includes('completed') || o.type === 'tool_result') {
      activities.push({ kind: 'tool_result', isError: o.is_error === true || o.error === true });
    }
  }
  if (typeStr.includes('thinking') || o.type === 'reasoning') {
    activities.push({ kind: 'thinking', chars: 10 });
  }

  // Direct text at top level or part.text (opencode fixture: {type:"text", part:{text:"..."}})
  const directText = extractOpencodeText(o);
  if (directText && !typeStr.includes('tool') && !typeStr.includes('thinking')) streamedText = directText;
  if (o.type === 'text' && isRecord(o.part) && typeof o.part.text === 'string') streamedText = o.part.text;

  // Terminal: result / completed / done / step_finish (opencode hello uses step_finish with part.tokens/cost)
  if (o.type === 'result' || o.type === 'completed' || o.type === 'done' || o.type === 'step_finish') {
    const part = isRecord(o.part) ? (o.part as Record<string, unknown>) : null;
    const usageRaw = isRecord(o.usage)
      ? o.usage
      : part && isRecord((part as Record<string, unknown>).tokens)
        ? ((part as Record<string, unknown>).tokens as Record<string, unknown>)
        : null;
    // opencode step_finish: part.tokens {input,output,total}, part.cost
    const usage = isRecord(usageRaw) ? usageRaw : null;
    const tokensInput = isRecord(usage)
      ? typeof usage.input === 'number'
        ? usage.input
        : typeof usage.input_tokens === 'number'
          ? usage.input_tokens
          : 0
      : 0;
    const tokensOutput = isRecord(usage)
      ? typeof usage.output === 'number'
        ? usage.output
        : typeof usage.output_tokens === 'number'
          ? usage.output_tokens
          : 0
      : 0;
    const cost =
      typeof o.total_cost_usd === 'number'
        ? o.total_cost_usd
        : typeof part?.cost === 'number'
          ? part.cost
          : typeof o.cost === 'number'
            ? o.cost
            : 0;
    const sessionId =
      typeof o.session_id === 'string'
        ? o.session_id
        : typeof o.sessionID === 'string'
          ? o.sessionID
          : typeof (o as Record<string, unknown>).sessionID === 'string'
            ? ((o as Record<string, unknown>).sessionID as string)
            : isRecord(part) && typeof part.sessionID === 'string'
              ? part.sessionID
              : typeof o.id === 'string'
                ? o.id
                : null;
    const result: StreamedResult = {
      result:
        typeof o.result === 'string'
          ? o.result
          : typeof o.output === 'string'
            ? o.output
            : state.streamedText + (streamedText ?? ''),
      isError: o.is_error === true,
      numTurns: typeof o.num_turns === 'number' ? o.num_turns : 0,
      totalCostUsd: cost,
      sessionId,
      stopReason:
        typeof o.stop_reason === 'string' ? o.stop_reason : typeof part?.reason === 'string' ? part.reason : null,
      permissionDenials: [],
      durationMs: typeof o.duration_ms === 'number' ? o.duration_ms : null,
      durationApiMs: null,
      ttftMs: null,
      model: typeof o.model === 'string' ? o.model : null,
      contextWindow: null,
      maxOutputTokens: null,
      usage: usage
        ? {
            inputTokens: tokensInput,
            outputTokens: tokensOutput,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
          }
        : null,
    };
    return { activities, streamedText, result };
  }
  return { activities, streamedText };
}

export const opencodeHarness: Harness = {
  name: 'opencode',
  displayName: 'OpenCode',
  binary: 'opencode',
  async detect() {
    try {
      const { stdout } = await execFileAsync('opencode', ['--version'], { timeout: 5000 });
      return { ok: true, version: stdout.trim() };
    } catch {
      return { ok: false, hint: 'Install OpenCode: https://opencode.ai' };
    }
  },
  buildArgs(opts: BuildArgsOpts): string[] {
    const args = ['run', '--format', 'json', opts.prompt];
    const perm = opts.nativePermission ?? PERMISSION_MAP[opts.permission] ?? 'allow-edit';
    args.push('--permission', perm);
    if (opts.model) args.push('--model', opts.model);
    if (opts.resumeSessionId) args.push('--session', opts.resumeSessionId);
    for (const dir of opts.addDirs ?? []) args.push('--add-dir', dir);
    return args;
  },
  parseLine(line: string, state: ParseState): ParseOutcome {
    return parseOpencodeLine(line, state);
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
    edit: ['allow-edit'],
    danger: ['danger'],
  },
};
