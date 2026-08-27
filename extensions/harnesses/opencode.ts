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

// Schema verified against opencode 1.18.16 — see tests/fixtures/opencode.jsonl.
// `opencode run` in this version has no `--permission` or `--add-dir` flag at all (confirmed via
// `opencode run --help`) — permission tiers map onto built-in agents instead (`opencode agent
// list`: "plan" is the read-only-oriented primary agent, "build" is the full-access one).

const execFileAsync = promisify(execFile);
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
const AGENT_MAP: Record<NormalizedPermission, string> = {
  readonly: 'plan',
  edit: 'build',
  danger: 'build',
};
function extractOpencodeText(o: Record<string, unknown>): string | undefined {
  if (typeof o.text === 'string') return o.text;
  if (typeof o.output === 'string') return o.output;
  if (typeof o.delta === 'string') return o.delta;
  if (typeof o.content === 'string') return o.content;
  if (isRecord(o.part) && typeof o.part.text === 'string') return o.part.text;
  if (isRecord(o.event) && typeof o.event.text === 'string') return o.event.text;
  if (isRecord(o.message) && typeof o.message.text === 'string') return o.message.text;
  return undefined;
}

interface OpencodeHarnessState {
  sessionId?: string;
  costAccum?: number;
  inputAccum?: number;
  outputAccum?: number;
  cacheReadAccum?: number;
  cacheWriteAccum?: number;
  stepCount?: number;
}

function harnessState(state: ParseState): OpencodeHarnessState {
  const s = (state._harness ?? {}) as OpencodeHarnessState;
  state._harness = s as unknown as Record<string, unknown>;
  return s;
}

export function parseOpencodeLine(line: string, state: ParseState): ParseOutcome {
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
  const hs = harnessState(state);
  // latch sessionID — real events carry it top-level (not just nested under part)
  if (typeof o.sessionID === 'string' && !hs.sessionId) hs.sessionId = o.sessionID;
  if (isRecord(o.part) && typeof (o.part as Record<string, unknown>).sessionID === 'string' && !hs.sessionId) {
    hs.sessionId = (o.part as Record<string, unknown>).sessionID as string;
  }
  // real tool schema: one combined `tool_use` event per call (already resolved by the time it's
  // emitted — no separate start/pending line observed), correlated by part.callID.
  if (typeStr === 'tool_use' && isRecord(o.part)) {
    const part = o.part as Record<string, unknown>;
    const name = typeof part.tool === 'string' ? part.tool : 'tool';
    const id = typeof part.callID === 'string' ? part.callID : undefined;
    const toolState = isRecord(part.state) ? (part.state as Record<string, unknown>) : null;
    const input = toolState && isRecord(toolState.input) ? (toolState.input as Record<string, unknown>) : {};
    const isError = Boolean(toolState?.error) || toolState?.status === 'error';
    activities.push({ kind: 'tool_start', name });
    activities.push({ kind: 'tool_input', name, input, id });
    activities.push({ kind: 'tool_result', isError, id });
  } else if (typeStr.includes('tool') || o.type === 'tool_result') {
    // fallback for older/other event shapes that don't match the combined tool_use schema above
    const name =
      typeof o.name === 'string'
        ? o.name
        : typeof (o as Record<string, unknown>).tool === 'string'
          ? ((o as Record<string, unknown>).tool as string)
          : 'tool';
    if (typeStr.includes('start')) {
      activities.push({ kind: 'tool_start', name });
      if (isRecord(o.input)) activities.push({ kind: 'tool_input', name, input: o.input as Record<string, unknown> });
    } else if (typeStr.includes('result') || typeStr.includes('completed') || o.type === 'tool_result')
      activities.push({ kind: 'tool_result', isError: o.is_error === true || o.error === true });
  }
  if (typeStr.includes('thinking') || o.type === 'reasoning') activities.push({ kind: 'thinking', chars: 10 });
  const directText = extractOpencodeText(o);
  if (directText && typeStr !== 'tool_use' && !typeStr.includes('tool') && !typeStr.includes('thinking'))
    streamedText = directText;
  if (o.type === 'text' && isRecord(o.part) && typeof o.part.text === 'string') streamedText = o.part.text;
  if (o.type === 'result' || o.type === 'completed' || o.type === 'done' || o.type === 'step_finish') {
    const part = isRecord(o.part) ? (o.part as Record<string, unknown>) : null;
    // step_finish reports the cost/tokens of that one step, not a running total — accumulate
    // across every step_finish seen so far so the final result reports a genuine session total.
    if (typeStr === 'step_finish' && part) {
      const tokens = isRecord(part.tokens) ? (part.tokens as Record<string, unknown>) : null;
      const cache = tokens && isRecord(tokens.cache) ? (tokens.cache as Record<string, unknown>) : null;
      hs.costAccum = (hs.costAccum ?? 0) + (typeof part.cost === 'number' ? part.cost : 0);
      hs.inputAccum = (hs.inputAccum ?? 0) + (tokens && typeof tokens.input === 'number' ? tokens.input : 0);
      hs.outputAccum = (hs.outputAccum ?? 0) + (tokens && typeof tokens.output === 'number' ? tokens.output : 0);
      hs.cacheReadAccum = (hs.cacheReadAccum ?? 0) + (cache && typeof cache.read === 'number' ? cache.read : 0);
      hs.cacheWriteAccum = (hs.cacheWriteAccum ?? 0) + (cache && typeof cache.write === 'number' ? cache.write : 0);
      hs.stepCount = (hs.stepCount ?? 0) + 1;
    }
    const measured = (hs.stepCount ?? 0) > 0;
    const sessionId =
      typeof o.session_id === 'string'
        ? o.session_id
        : typeof o.sessionID === 'string'
          ? o.sessionID
          : part && typeof (part as Record<string, unknown>).sessionID === 'string'
            ? ((part as Record<string, unknown>).sessionID as string)
            : typeof o.id === 'string'
              ? o.id
              : (hs.sessionId ?? null);
    const result: StreamedResult = {
      result:
        typeof o.result === 'string'
          ? o.result
          : typeof o.output === 'string'
            ? o.output
            : state.streamedText + (streamedText ?? ''),
      isError: o.is_error === true,
      numTurns: typeof o.num_turns === 'number' ? o.num_turns : measured ? (hs.stepCount as number) : null,
      totalCostUsd: measured
        ? (hs.costAccum as number)
        : typeof o.total_cost_usd === 'number'
          ? o.total_cost_usd
          : null,
      sessionId,
      stopReason:
        typeof o.stop_reason === 'string'
          ? o.stop_reason
          : part && typeof (part as Record<string, unknown>).reason === 'string'
            ? ((part as Record<string, unknown>).reason as string)
            : null,
      permissionDenials: [],
      durationMs: typeof o.duration_ms === 'number' ? o.duration_ms : null,
      durationApiMs: null,
      ttftMs: null,
      model: typeof o.model === 'string' ? o.model : null,
      contextWindow: null,
      maxOutputTokens: null,
      usage: measured
        ? {
            inputTokens: hs.inputAccum ?? 0,
            outputTokens: hs.outputAccum ?? 0,
            cacheCreationInputTokens: hs.cacheWriteAccum ?? 0,
            cacheReadInputTokens: hs.cacheReadAccum ?? 0,
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
    const agent = opts.nativePermission ?? AGENT_MAP[opts.permission] ?? 'build';
    const args = ['run', opts.prompt, '--format', 'json', '--agent', agent];
    if (opts.permission === 'danger' && !opts.nativePermission) args.push('--auto');
    if (opts.model) args.push('--model', opts.model);
    if (opts.resumeSessionId) args.push('--session', opts.resumeSessionId);
    return args;
  },
  parseLine(line: string, state: ParseState): ParseOutcome {
    return parseOpencodeLine(line, state);
  },
  extractResult(state: ParseState): StreamedResult | null {
    if (state.result) return state.result;
    if (state.streamedText.trim().length > 0) {
      const latched = (state._harness as OpencodeHarnessState | undefined)?.sessionId;
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
  permissionMap: { readonly: ['plan'], edit: ['build'], danger: ['build', '--auto'] },
};
