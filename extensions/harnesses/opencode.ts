import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  ActivityEvent,
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
//
// This harness also supports the ACP transport (`opencode acp`) — see the `parseOpencodeAcpLine`/
// `buildAcpArgs`/`ACP_MODE_MAP` block below and tests/fixtures/opencode-acp*.jsonl. Live-verified
// (docs/acp-harness-assessment.md §2/§4, closed by a second live run — see
// tests/fixtures/opencode-acp-build-write.jsonl): a real write prompt under `build` mode produced
// a `tool_call`/`tool_call_update` pair with `kind: "edit"` and no `session/request_permission`
// request at all — this project's ACP client auto-declines that request when it arrives (see
// acp-runner.ts's `handleServerRequest`), so its absence here means `edit`/`danger` genuinely
// execute over ACP rather than silently no-op.

const execFileAsync = promisify(execFile);
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
const AGENT_MAP: Record<NormalizedPermission, string> = {
  readonly: 'plan',
  edit: 'build',
  danger: 'build',
};
// A distinct vocabulary from AGENT_MAP even though the values happen to coincide today (`plan`/
// `build` are both the CLI agent name and the ACP `session/set_mode` modeId) — kept separate on
// purpose, per docs/acp-harness-assessment.md §6, so the two never silently drift together.
const ACP_MODE_MAP: Record<NormalizedPermission, string> = {
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

interface OpencodeAcpHarnessState {
  sessionId?: string;
  contextWindow?: number;
  costUsd?: number;
}

function acpHarnessState(state: ParseState): OpencodeAcpHarnessState {
  const s = (state._harness ?? {}) as OpencodeAcpHarnessState;
  state._harness = s as unknown as Record<string, unknown>;
  return s;
}

/** Translate one `session/update` notification's `params.update` payload into ParseOutcome deltas.
 *  Same wire dialect as devin.ts's `translateUpdate` (both are real ACP `session/update` payloads —
 *  see docs/acp-harness-assessment.md §2's evidence that opencode/omp share an ACP implementation),
 *  kept as an independent function rather than a shared import so devin.ts needs zero changes here. */
function translateOpencodeAcpUpdate(update: Record<string, unknown>, state: ParseState): ParseOutcome {
  const activities: ActivityEvent[] = [];
  let streamedText: string | undefined;
  const content = isRecord(update.content) ? update.content : undefined;
  const text = content?.type === 'text' && typeof content.text === 'string' ? content.text : undefined;
  const hs = acpHarnessState(state);

  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
      if (text !== undefined) streamedText = text;
      break;
    case 'agent_thought_chunk':
      if (text !== undefined) activities.push({ kind: 'thinking', chars: text.length });
      break;
    case 'tool_call': {
      if (typeof update.toolCallId !== 'string') break;
      // real fixture: `title` is the tool name ("read", "glob", "write"), matching the stdout
      // parser's `part.tool` convention — fall back to `kind` (the coarser category) if absent.
      const name =
        typeof update.title === 'string' ? update.title : typeof update.kind === 'string' ? update.kind : 'tool';
      activities.push({
        kind: 'tool_input',
        name,
        input: isRecord(update.rawInput) ? update.rawInput : {},
        id: update.toolCallId,
      });
      break;
    }
    case 'tool_call_update': {
      // Only a terminal status produces a tool_result — same reasoning as devin.ts: a call fires
      // multiple `in_progress` updates before its `completed`/`failed`, and ToolCallIndex.resolve()
      // consumes the pending entry on first match.
      if (typeof update.toolCallId !== 'string') break;
      if (update.status === 'completed' || update.status === 'failed') {
        activities.push({ kind: 'tool_result', isError: update.status === 'failed', id: update.toolCallId });
      }
      break;
    }
    case 'usage_update':
      // Both fields are genuinely real over ACP (unlike stdout's `null`s) — see
      // docs/acp-harness-assessment.md §2 — and, per the same section, this is a running session
      // total already, latched from the *last* usage_update seen, never summed across a series.
      if (typeof update.size === 'number') hs.contextWindow = update.size;
      if (isRecord(update.cost) && typeof update.cost.amount === 'number') hs.costUsd = update.cost.amount;
      break;
    default:
      break;
  }
  return { streamedText, activities };
}

export function parseOpencodeAcpLine(line: string, state: ParseState): ParseOutcome {
  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch {
    return {};
  }
  if (!isRecord(o)) return {};

  if (o.method === 'session/update' && isRecord(o.params) && isRecord(o.params.update)) {
    return translateOpencodeAcpUpdate(o.params.update, state);
  }

  if (isRecord(o.result)) {
    const r = o.result;
    if (typeof r.stopReason === 'string') {
      // session/prompt response — the turn is over, build the final result.
      const u = isRecord(r.usage) ? r.usage : null;
      const hs = acpHarnessState(state);
      const result: StreamedResult = {
        result: state.streamedText,
        // opencode's ACP prompt response carries no error flag of its own — a genuine failure
        // surfaces via acp-runner.ts's process-level fail() path, same as every other harness.
        isError: false,
        numTurns: null, // never observed populated over ACP (docs/acp-harness-assessment.md §2)
        totalCostUsd: typeof hs.costUsd === 'number' ? hs.costUsd : null,
        sessionId: typeof hs.sessionId === 'string' ? hs.sessionId : null,
        stopReason: r.stopReason,
        permissionDenials: [],
        durationMs: null,
        durationApiMs: null,
        ttftMs: null,
        // Only ever the *requested* configOptions value from session/new, never confirmed back
        // the way Devin's agent_stopped event confirms what actually ran — null is the honest
        // value, not a guess.
        model: null,
        contextWindow: typeof hs.contextWindow === 'number' ? hs.contextWindow : null,
        maxOutputTokens: null,
        usage: u
          ? {
              // Unlike Devin's inputTokens (which includes cachedReadTokens as a subset and needs
              // subtracting), opencode's inputTokens already EXCLUDES it — verified against the
              // real capture: inputTokens + cachedReadTokens === totalTokens - outputTokens exactly
              // in both tests/fixtures/opencode-acp.jsonl and opencode-acp-build-write.jsonl.
              inputTokens: typeof u.inputTokens === 'number' ? u.inputTokens : 0,
              outputTokens: typeof u.outputTokens === 'number' ? u.outputTokens : 0,
              cacheCreationInputTokens: 0, // not reported over ACP
              cacheReadInputTokens: typeof u.cachedReadTokens === 'number' ? u.cachedReadTokens : 0,
            }
          : null,
      };
      return { result };
    }
    if (typeof r.sessionId === 'string') {
      // session/new response — stash the id; session/load's response has none of its own
      // (acp-runner.ts stashes it into state._harness.sessionId itself on a resume).
      acpHarnessState(state).sessionId = r.sessionId;
    }
  }
  return {};
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
  // ACP path — opt-in only (transport defaults to 'stdout'; see config.ts's resolveTransport).
  // `--model` isn't wired here: `opencode acp --help` has no such flag, unlike `devin acp
  // --model`; the ACP handshake's own `configOptions` "model" category is the real mechanism
  // (session/set_config_option, unverified live — see ROADMAP.md), out of scope for this change.
  buildAcpArgs(): string[] {
    return ['acp'];
  },
  parseAcpLine(line: string, state: ParseState): ParseOutcome {
    return parseOpencodeAcpLine(line, state);
  },
  acpPermissionMap: { readonly: [ACP_MODE_MAP.readonly], edit: [ACP_MODE_MAP.edit], danger: [ACP_MODE_MAP.danger] },
  supportsTransports: ['stdout', 'acp'],
};
