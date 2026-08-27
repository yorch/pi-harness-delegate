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

export interface Harness {
  name: string;
  displayName: string;
  binary: string;
  aliases?: string[];
  /** Check if binary is available. */
  detect(): Promise<DetectResult>;
  /** Build CLI args (excluding binary). */
  buildArgs(opts: BuildArgsOpts): string[];
  /** Parse a single stdout line. State is mutated by runner; return deltas. */
  parseLine(line: string, state: ParseState): ParseOutcome;
  /** Extract final result after process exit (state.result may already be set). */
  extractResult(state: ParseState): StreamedResult | null;
  /** Normalized -> native arg fragments. */
  permissionMap?: Record<NormalizedPermission, string[]>;
  permissionHint?: (permission: NormalizedPermission) => string[];
}

export const DEFAULT_TIMEOUT_MS = 600_000;
