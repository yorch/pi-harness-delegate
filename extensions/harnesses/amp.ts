import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import type {
  BuildArgsOpts,
  Harness,
  NormalizedPermission,
  ParseOutcome,
  ParseState,
  StreamedResult,
} from './types.ts';

// Schema verified against omp/17.2.9 (the only binary of this harness installed on the capture
// machine — see tests/fixtures/amp.jsonl and AGENTS.md for what "amp" vs "omp" means here).

const execFileAsync = promisify(execFile);
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * `amp` isn't on PATH on machines that only have the `omp` alias binary installed — resolve
 * which one actually exists once at module load, so the spawned binary matches what `detect()`
 * already tolerates. Falls back to 'amp' (the documented default) when neither is found, so
 * error messages still name the expected tool.
 */
export function resolveAmpBinary(pathEnv: string | undefined, exists: (p: string) => boolean = pathExists): string {
  const dirs = (pathEnv ?? '').split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    if (exists(join(dir, 'amp'))) return 'amp';
  }
  for (const dir of dirs) {
    if (exists(join(dir, 'omp'))) return 'omp';
  }
  return 'amp';
}

function pathExists(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const RESOLVED_BINARY = resolveAmpBinary(process.env.PATH);

// approval-mode maps cleanly onto the normalized 3-tier permission model.
const PERMISSION_MAP: Record<NormalizedPermission, string> = {
  readonly: 'always-ask',
  edit: 'write',
  danger: 'yolo',
};
function extractAmpText(o: Record<string, unknown>): string | undefined {
  if (typeof o.text === 'string') return o.text;
  if (typeof o.output === 'string') return o.output;
  if (typeof o.delta === 'string') return o.delta;
  if (typeof o.content === 'string') return o.content;
  if (isRecord(o.part) && typeof o.part.text === 'string') return o.part.text;
  return undefined;
}

interface AmpHarnessState {
  sessionId?: string;
  costAccum?: number;
  inputAccum?: number;
  outputAccum?: number;
  cacheReadAccum?: number;
  cacheWriteAccum?: number;
  turnCount?: number;
}

function harnessState(state: ParseState): AmpHarnessState {
  const s = (state._harness ?? {}) as AmpHarnessState;
  state._harness = s as unknown as Record<string, unknown>;
  return s;
}

export function parseAmpLine(line: string, state: ParseState): ParseOutcome {
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
  // latch session id
  if (typeStr === 'session' && typeof o.id === 'string') hs.sessionId = o.id;
  if (isRecord(o.part) && typeof (o.part as Record<string, unknown>).sessionID === 'string')
    hs.sessionId = (o.part as Record<string, unknown>).sessionID as string;
  if (typeStr === 'session' && typeof (o as Record<string, unknown>).sessionID === 'string')
    hs.sessionId = (o as Record<string, unknown>).sessionID as string;

  // real tool schema: top-level tool_execution_start/tool_execution_end, correlated by toolCallId
  if (typeStr === 'tool_execution_start' || typeStr === 'tool_execution_end') {
    const name = typeof o.toolName === 'string' ? o.toolName : 'tool';
    const id = typeof o.toolCallId === 'string' ? o.toolCallId : undefined;
    if (typeStr === 'tool_execution_start') {
      activities.push({ kind: 'tool_start', name });
      activities.push({
        kind: 'tool_input',
        name,
        input: isRecord(o.args) ? (o.args as Record<string, unknown>) : {},
        id,
      });
    } else {
      activities.push({ kind: 'tool_result', isError: o.isError === true, id });
    }
  }
  if (typeStr === 'message_update' && isRecord(o.assistantMessageEvent)) {
    const ev = o.assistantMessageEvent as Record<string, unknown>;
    if (ev.type === 'thinking_delta' && typeof ev.delta === 'string')
      activities.push({ kind: 'thinking', chars: ev.delta.length });
    else if (ev.type === 'text_delta' && typeof ev.delta === 'string') streamedText = ev.delta;
    else if (ev.type === 'thinking_start') activities.push({ kind: 'thinking', chars: 5 });
  }
  if (typeStr === 'turn_end' || typeStr === 'agent_end') {
    const msg = isRecord(o.message)
      ? (o.message as Record<string, unknown>)
      : Array.isArray(o.messages) && isRecord(o.messages[o.messages.length - 1])
        ? (o.messages[o.messages.length - 1] as Record<string, unknown>)
        : null;
    if (msg && Array.isArray(msg.content)) {
      for (const block of msg.content as unknown[]) {
        if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') streamedText = block.text;
        if (isRecord(block) && block.type === 'thinking' && typeof block.thinking === 'string')
          activities.push({ kind: 'thinking', chars: (block.thinking as string).length });
      }
    }
    // real usage lives at message.usage on turn_end (per-turn, not cumulative — see accumulation below)
    if (typeStr === 'turn_end' && isRecord(msg?.usage)) {
      const u = msg.usage as Record<string, unknown>;
      const cost =
        isRecord(u.cost) && typeof (u.cost as Record<string, unknown>).total === 'number'
          ? ((u.cost as Record<string, unknown>).total as number)
          : 0;
      hs.costAccum = (hs.costAccum ?? 0) + cost;
      hs.inputAccum = (hs.inputAccum ?? 0) + (typeof u.input === 'number' ? u.input : 0);
      hs.outputAccum = (hs.outputAccum ?? 0) + (typeof u.output === 'number' ? u.output : 0);
      hs.cacheReadAccum = (hs.cacheReadAccum ?? 0) + (typeof u.cacheRead === 'number' ? u.cacheRead : 0);
      hs.cacheWriteAccum = (hs.cacheWriteAccum ?? 0) + (typeof u.cacheWrite === 'number' ? u.cacheWrite : 0);
      hs.turnCount = (hs.turnCount ?? 0) + 1;
    }
  }
  const text = extractAmpText(o);
  if (text && typeStr !== 'tool_execution_start' && typeStr !== 'tool_execution_end' && !streamedText)
    streamedText = text;
  if (typeStr === 'turn_end' || typeStr === 'agent_end') {
    const msg = isRecord(o.message)
      ? (o.message as Record<string, unknown>)
      : Array.isArray(o.messages) && isRecord(o.messages[o.messages.length - 1])
        ? (o.messages[o.messages.length - 1] as Record<string, unknown>)
        : null;
    const measured = (hs.turnCount ?? 0) > 0;
    // real error shape: message.stopReason === 'error' + message.errorMessage — observed live on a
    // 429 quota rejection, where message.content is an empty array, so the text-block extraction
    // above never sets streamedText and this would otherwise silently report success with empty
    // text (tests/fixtures/amp-error.jsonl).
    const errorMessage = typeof msg?.errorMessage === 'string' ? (msg.errorMessage as string) : undefined;
    const isErrorTurn = msg?.stopReason === 'error' || errorMessage !== undefined;
    const result: StreamedResult = {
      result:
        typeof o.result === 'string'
          ? o.result
          : errorMessage
            ? errorMessage
            : streamedText
              ? state.streamedText + streamedText
              : state.streamedText || (text ?? ''),
      isError: o.is_error === true || isErrorTurn,
      numTurns: measured ? (hs.turnCount as number) : null,
      totalCostUsd: measured ? (hs.costAccum as number) : null,
      sessionId:
        typeof o.session_id === 'string' ? o.session_id : typeof o.id === 'string' ? o.id : (hs.sessionId ?? null),
      stopReason:
        typeof o.stop_reason === 'string'
          ? o.stop_reason
          : typeof msg?.stopReason === 'string'
            ? (msg.stopReason as string)
            : null,
      permissionDenials: [],
      durationMs:
        typeof o.duration_ms === 'number'
          ? o.duration_ms
          : typeof (o as Record<string, unknown>).duration === 'number'
            ? ((o as Record<string, unknown>).duration as number)
            : null,
      durationApiMs: null,
      ttftMs:
        typeof (o as Record<string, unknown>).ttft === 'number'
          ? ((o as Record<string, unknown>).ttft as number)
          : null,
      model: typeof o.model === 'string' ? o.model : typeof msg?.model === 'string' ? (msg.model as string) : null,
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
    if (!result.result) result.result = state.streamedText + (streamedText ?? '');
    return { activities, streamedText, result };
  }
  return { activities, streamedText };
}
export const ampHarness: Harness = {
  name: 'amp',
  displayName: 'Amp',
  binary: RESOLVED_BINARY,
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
    const approvalMode = opts.nativePermission ?? PERMISSION_MAP[opts.permission] ?? 'always-ask';
    const args = ['-p', '--mode', 'json', '--approval-mode', approvalMode];
    if (opts.model) args.push('--model', opts.model);
    if (opts.resumeSessionId) args.push('--resume', opts.resumeSessionId);
    // `--add-dir=<value>` is real and repeatable per `omp --help` — confirmed live: a run with
    // --add-dir echoed the directory back in the session line's `additionalDirectories`. (Earlier
    // research had flagged this as possibly absent; that was wrong for omp 17.2.9.)
    for (const dir of opts.addDirs ?? []) args.push('--add-dir', dir);
    args.push(opts.prompt);
    return args;
  },
  parseLine(line: string, state: ParseState): ParseOutcome {
    return parseAmpLine(line, state);
  },
  extractResult(state: ParseState): StreamedResult | null {
    if (state.result) return state.result;
    if (state.streamedText.trim().length > 0) {
      const latched = (state._harness as AmpHarnessState | undefined)?.sessionId;
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
  permissionMap: { readonly: ['always-ask'], edit: ['write'], danger: ['yolo'] },
  // `omp acp` is real and live-verified (docs/acp-harness-assessment.md §2/§4) — but deliberately
  // NOT offered as a config value yet: its ACP mode surface only has 2 tiers (`default`/`plan`),
  // while the stdout `--approval-mode` above has 3 genuine ones. Adding 'acp' here would let a
  // user configure `edit`, expecting "ask before every write", and silently collapse it onto the
  // same `default` mode as `danger` — a real permission-tier regression, not a cosmetic one. Only
  // revisit if a future omp ACP version exposes a third tier (e.g. an `approval-mode`-shaped
  // `configOptions` category, the same slot `thinking` already occupies today) — redo the §4-style
  // live permission-tier analysis before changing this, don't just add 'acp' to the list.
  supportsTransports: ['stdout'],
};
