/**
 * Devin — runs over the Agent Client Protocol (`devin acp`), not stdout JSONL. `transport: 'acp'`
 * routes it through extensions/acp-runner.ts instead of runner.ts; `buildArgs` here only needs to
 * spawn the ACP server (`devin acp`) — the prompt, permission mode, and session lifecycle are all
 * negotiated over the wire by acp-runner.ts, not passed as CLI flags.
 *
 * `parseLine`/`extractResult` translate raw ACP JSON-RPC lines (one per line, same as any other
 * harness's JSONL) into `ParseOutcome`/`StreamedResult` — this is what makes the JSON-RPC plumbing
 * testable via the same fixture-replay pattern as the stdout harnesses (tests/fixtures.test.ts),
 * without spawning a process: `tests/fixtures/devin-acp.jsonl` is a real captured session.
 *
 * Schema verified against `devin 3000.6.7 (260a97c8)` — see docs/devin-acp-harness-design.md.
 *
 * Workspace trust: the design note this was built from flagged `devin`'s interactive workspace-trust
 * gate as a hazard needing a `detect()` hint. Live verification found that gate applies to `devin -p`
 * / interactive `devin`, but NOT to `devin acp` — confirmed by running the raw `initialize`/`session/new`
 * handshake against a directory never seen by devin before (no `--config` bypass), which succeeded with
 * no refusal, while `devin -p` in the same directory refused. So this harness's actual code path was
 * never gated in the first place; no hint or bypass is needed. If a future devin version starts
 * enforcing trust over ACP too, the generic non-zero-exit path in acp-runner.ts already surfaces
 * whatever refusal message devin prints, same as any other process failure.
 */
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

const execFileAsync = promisify(execFile);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Exact structural match to Claude's tiers (session/new's captured `availableModes`: plan, accept-edits,
 *  smart, ask, bypass). `smart`/`ask` stay reachable via the existing `nativePermission` escape hatch. */
const PERMISSION_MAP: Record<NormalizedPermission, string> = {
  readonly: 'plan',
  edit: 'accept-edits',
  danger: 'bypass',
};

/** Translate one `session/update` notification's `params.update` payload into ParseOutcome deltas. */
function translateUpdate(update: Record<string, unknown>, state: ParseState): ParseOutcome {
  const activities: ActivityEvent[] = [];
  let streamedText: string | undefined;
  const content = isRecord(update.content) ? update.content : undefined;
  const text = content?.type === 'text' && typeof content.text === 'string' ? content.text : undefined;

  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
      if (text !== undefined) streamedText = text;
      break;
    case 'agent_thought_chunk':
      if (text !== undefined) activities.push({ kind: 'thinking', chars: text.length });
      break;
    case 'tool_call': {
      if (typeof update.toolCallId !== 'string') break;
      const meta = isRecord(update._meta) ? update._meta : {};
      const inferenceName = meta['cognition.ai/inferenceToolName'];
      const name =
        typeof inferenceName === 'string' ? inferenceName : typeof update.kind === 'string' ? update.kind : 'tool';
      activities.push({
        kind: 'tool_input',
        name,
        input: isRecord(update.rawInput) ? update.rawInput : {},
        id: update.toolCallId,
      });
      break;
    }
    case 'tool_call_update': {
      // Only a terminal status produces a tool_result. A call fires multiple `in_progress`
      // updates for the same toolCallId before its `completed`/`failed` (real fixture: 2-3 per
      // id) — ToolCallIndex.resolve() consumes the pending entry on first match, so an earlier
      // in_progress "result" would eat the id and strand the real completion unattributed.
      if (typeof update.toolCallId !== 'string') break;
      if (update.status === 'completed' || update.status === 'failed') {
        activities.push({ kind: 'tool_result', isError: update.status === 'failed', id: update.toolCallId });
      }
      break;
    }
    case 'usage_update':
      state._harness ??= {};
      if (typeof update.size === 'number') state._harness.contextWindow = update.size;
      break;
    default:
      break;
  }
  return { streamedText, activities };
}

export function parseDevinLine(line: string, state: ParseState): ParseOutcome {
  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch {
    return {};
  }
  if (!isRecord(o)) return {};

  if (o.method === 'session/update' && isRecord(o.params) && isRecord(o.params.update)) {
    return translateUpdate(o.params.update, state);
  }

  if (o.method === '_cognition.ai/agent_stopped' && isRecord(o.params) && isRecord(o.params.stats)) {
    // The real model Devin ran, independent of whatever --model was requested — the honest
    // value to report, since `--model` accepts fuzzy names and enterprise config can override it.
    const label = o.params.stats.modelLabel;
    if (typeof label === 'string') {
      state._harness ??= {};
      state._harness.model = label;
    }
    return {};
  }

  if (isRecord(o.result)) {
    const r = o.result;
    if (typeof r.stopReason === 'string') {
      // session/prompt response — the turn is over, build the final result.
      const u = isRecord(r.usage) ? r.usage : null;
      const harnessState = isRecord(state._harness) ? state._harness : {};
      // Devin's inputTokens already includes cachedReadTokens as a subset (fixture: on every
      // usage_update/prompt result, used === inputTokens + outputTokens exactly, and
      // cachedReadTokens < inputTokens). StreamedUsage follows Claude's convention where
      // inputTokens EXCLUDES cache reads (index.ts sums inputTokens + cacheReadInputTokens into
      // promptTokens) — so subtract the cache-read subset back out here, or promptTokens/context%
      // double-counts it. Math.max guards against a negative if that invariant ever breaks.
      const cacheReadInputTokens = typeof u?.cachedReadTokens === 'number' ? u.cachedReadTokens : 0;
      const rawInputTokens = typeof u?.inputTokens === 'number' ? u.inputTokens : 0;
      const result: StreamedResult = {
        result: state.streamedText,
        // Devin's ACP prompt response carries no error flag of its own — a genuine failure
        // (JSON-RPC `error`, non-zero exit, workspace-trust refusal) surfaces via acp-runner.ts's
        // process-level fail() path instead, same as every other harness's non-zero-exit case.
        isError: false,
        numTurns: null, // not reported for a single prompt turn
        totalCostUsd: null, // Devin reports no $ cost over ACP — honest-metrics convention (#11)
        sessionId: typeof harnessState.sessionId === 'string' ? harnessState.sessionId : null,
        stopReason: r.stopReason,
        permissionDenials: [],
        durationMs: null,
        durationApiMs: null,
        ttftMs: null,
        model: typeof harnessState.model === 'string' ? harnessState.model : null,
        contextWindow: typeof harnessState.contextWindow === 'number' ? harnessState.contextWindow : null,
        maxOutputTokens: null,
        usage: u
          ? {
              inputTokens: Math.max(0, rawInputTokens - cacheReadInputTokens),
              outputTokens: typeof u.outputTokens === 'number' ? u.outputTokens : 0,
              cacheCreationInputTokens: 0, // not reported over ACP
              cacheReadInputTokens,
            }
          : null,
      };
      return { result };
    }
    if (typeof r.sessionId === 'string') {
      // session/new response — stash the id; the prompt response above has no sessionId of its own.
      state._harness ??= {};
      state._harness.sessionId = r.sessionId;
    }
  }
  return {};
}

export const devinHarness: Harness = {
  name: 'devin',
  displayName: 'Devin',
  binary: 'devin',
  transport: 'acp',
  async detect() {
    try {
      const { stdout } = await execFileAsync('devin', ['--version'], { timeout: 5000 });
      return { ok: true, version: stdout.trim() };
    } catch {
      return { ok: false, hint: 'Install the Devin CLI: https://docs.devin.ai/' };
    }
  },
  buildArgs(opts: BuildArgsOpts): string[] {
    // The prompt, permission mode, and session lifecycle are all negotiated over the ACP wire
    // (see acp-runner.ts) — this just launches the ACP server. `--model` is the one real CLI flag
    // `devin acp` accepts (verified: `devin acp --help`); it sets the default model for every new
    // ACP session on this server, and accepts fuzzy names (family slug, alias, or partial name).
    const args = ['acp'];
    if (opts.model) args.push('--model', opts.model);
    return args;
  },
  parseLine(line: string, state: ParseState): ParseOutcome {
    return parseDevinLine(line, state);
  },
  extractResult(state: ParseState): StreamedResult | null {
    return state.result;
  },
  permissionMap: {
    readonly: [PERMISSION_MAP.readonly],
    edit: [PERMISSION_MAP.edit],
    danger: [PERMISSION_MAP.danger],
  },
};
