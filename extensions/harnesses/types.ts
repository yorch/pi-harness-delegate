/** Harness abstraction — normalized permission + generic runner contract. */

export type NormalizedPermission = 'readonly' | 'edit' | 'danger';

export interface StreamedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export interface StreamedResult {
  result: string;
  isError: boolean;
  /** null when the harness's payload doesn't report a turn count — distinct from a measured 0. */
  numTurns: number | null;
  /** null when the harness's payload doesn't report cost — distinct from a measured $0. */
  totalCostUsd: number | null;
  sessionId: string | null;
  stopReason: string | null;
  permissionDenials: unknown[];
  usage: StreamedUsage | null;
  durationMs: number | null;
  durationApiMs: number | null;
  ttftMs: number | null;
  model: string | null;
  contextWindow: number | null;
  maxOutputTokens: number | null;
}

export type ActivityEvent =
  | { kind: 'tool_start'; name: string }
  | { kind: 'tool_input'; name: string; input: Record<string, unknown>; id?: string }
  | { kind: 'tool_result'; isError: boolean; id?: string }
  | { kind: 'thinking'; chars: number };

export interface ParseState {
  streamedText: string;
  activities: ActivityEvent[];
  result: StreamedResult | null;
  /** Harness-internal scratch space. */
  _harness?: Record<string, unknown>;
}

export interface ParseOutcome {
  streamedText?: string;
  activities?: ActivityEvent[];
  result?: StreamedResult | null;
}

export interface StreamParseOutcome {
  streamedText: string;
  result: StreamedResult | null;
  activities: ActivityEvent[];
}

export interface BuildArgsOpts {
  prompt: string;
  cwd: string;
  permission: NormalizedPermission;
  nativePermission?: string;
  model?: string;
  maxBudgetUsd?: number;
  addDirs?: string[];
  resumeSessionId?: string;
  resumeId?: string;
}

export type HarnessBuildOpts = BuildArgsOpts;

export interface DetectResult {
  ok: boolean;
  version?: string;
  hint?: string;
}

/** Which runner drives a harness. Defaults to 'stdout' (extensions/runner.ts) when omitted.
 *  'acp' (extensions/acp-runner.ts) is for Agent Client Protocol agents — a bidirectional
 *  JSON-RPC session over stdio rather than a one-way JSONL stream. See AGENTS.md. */
export type Transport = 'stdout' | 'acp';

export interface Harness {
  name: string;
  displayName: string;
  binary: string;
  aliases?: string[];
  /** Check if binary is available. */
  detect(): Promise<DetectResult>;
  /** Build CLI args (excluding binary) for the 'stdout' transport. */
  buildArgs(opts: BuildArgsOpts): string[];
  /** Parse a single stdout-transport line. State is mutated by runner; return deltas. */
  parseLine(line: string, state: ParseState): ParseOutcome;
  /** Extract final result after process exit (state.result may already be set). */
  extractResult(state: ParseState): StreamedResult | null;
  /** Normalized -> native CLI arg fragments, used by the 'stdout' transport's buildArgs/nativePermission. */
  permissionMap?: Record<NormalizedPermission, string[]>;
  permissionHint?: (permission: NormalizedPermission) => string[];
  /** Which transports this harness's binary actually supports — the ceiling `config.harnesses.<name>.transport`
   *  is validated against (see config.ts's `resolveTransport`), independent of what a user configures.
   *  Omitted -> `[transport ?? 'stdout']` (today's single-transport harnesses). A harness legally offering
   *  both 'stdout' and 'acp' must also declare `buildAcpArgs`/`parseAcpLine`/`acpPermissionMap` below. */
  supportsTransports?: Transport[];
  /** Default transport when config doesn't override. Omitted -> 'stdout'. */
  transport?: Transport;
  /** Build args to spawn the ACP server (e.g. ['acp']), for a harness whose `supportsTransports`
   *  includes 'acp'. Devin (ACP-only) has no separate stdout buildArgs, so it reuses `buildArgs` for
   *  this and doesn't need to declare `buildAcpArgs` — acp-runner.ts's caller falls back to `buildArgs`
   *  when `buildAcpArgs` is absent (see acp-runner.ts's `acpView`). */
  buildAcpArgs?(opts: BuildArgsOpts): string[];
  /** Parse a single ACP JSON-RPC line (see acp-runner.ts). Falls back to `parseLine` when absent, same
   *  reasoning as `buildAcpArgs`. */
  parseAcpLine?(line: string, state: ParseState): ParseOutcome;
  /** Normalized -> ACP session mode id (`session/set_mode`'s `modeId`) — a distinct vocabulary from
   *  `permissionMap`'s CLI arg fragments even when a value happens to coincide (e.g. opencode's `build`
   *  is both). Falls back to `permissionMap` when absent, same reasoning as `buildAcpArgs`. */
  acpPermissionMap?: Record<NormalizedPermission, string[]>;
}

export const DEFAULT_TIMEOUT_MS = 600_000;
