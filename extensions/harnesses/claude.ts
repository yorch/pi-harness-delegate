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
  readonly: 'plan',
  edit: 'acceptEdits',
  danger: 'bypassPermissions',
};

export function parseClaudeLine(line: string, state: ParseState): ParseOutcome {
  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch {
    return { activities: [] };
  }
  if (!isRecord(o)) return { activities: [] };
  const activities: ParseOutcome['activities'] = [];
  let streamedText: string | undefined;

  if (o.type === 'stream_event' && isRecord(o.event)) {
    const ev = o.event;
    const delta = isRecord(ev.delta) ? ev.delta : undefined;
    if (ev.type === 'content_block_delta' && delta?.type === 'text_delta' && typeof delta.text === 'string') {
      streamedText = delta.text;
    } else if (
      ev.type === 'content_block_delta' &&
      delta?.type === 'thinking_delta' &&
      typeof delta.thinking === 'string'
    ) {
      activities.push({ kind: 'thinking', chars: delta.thinking.length });
    } else if (ev.type === 'content_block_start' && isRecord(ev.content_block)) {
      const cb = ev.content_block;
      if (cb.type === 'tool_use' && typeof cb.name === 'string') {
        activities.push({ kind: 'tool_start', name: cb.name });
      }
    }
  } else if (o.type === 'assistant' && isRecord(o.message)) {
    for (const block of Array.isArray(o.message.content) ? o.message.content : []) {
      if (isRecord(block) && block.type === 'tool_use' && typeof block.name === 'string') {
        activities.push({
          kind: 'tool_input',
          name: block.name,
          input: isRecord(block.input) ? block.input : {},
          id: typeof block.id === 'string' ? block.id : undefined,
        });
      }
    }
  } else if (o.type === 'user' && isRecord(o.message)) {
    for (const block of Array.isArray(o.message.content) ? o.message.content : []) {
      if (isRecord(block) && block.type === 'tool_result') {
        activities.push({
          kind: 'tool_result',
          isError: block.is_error === true,
          id: typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined,
        });
      }
    }
  } else if (o.type === 'result') {
    const u = isRecord(o.usage) ? o.usage : null;
    let model: string | null = null;
    let contextWindow: number | null = null;
    let maxOutputTokens: number | null = null;
    if (isRecord(o.modelUsage)) {
      const first = Object.entries(o.modelUsage)[0]?.[1];
      const firstKey = Object.keys(o.modelUsage)[0];
      if (firstKey) model = firstKey;
      if (isRecord(first)) {
        if (typeof first.contextWindow === 'number') contextWindow = first.contextWindow;
        if (typeof first.maxOutputTokens === 'number') maxOutputTokens = first.maxOutputTokens;
      }
    }
    const result: StreamedResult = {
      result: typeof o.result === 'string' ? o.result : state.streamedText,
      isError: o.is_error === true,
      numTurns: typeof o.num_turns === 'number' ? o.num_turns : null,
      totalCostUsd: typeof o.total_cost_usd === 'number' ? o.total_cost_usd : null,
      sessionId: typeof o.session_id === 'string' ? o.session_id : null,
      stopReason: typeof o.stop_reason === 'string' ? o.stop_reason : null,
      permissionDenials: Array.isArray(o.permission_denials) ? o.permission_denials : [],
      durationMs: typeof o.duration_ms === 'number' ? o.duration_ms : null,
      durationApiMs: typeof o.duration_api_ms === 'number' ? o.duration_api_ms : null,
      ttftMs: typeof o.ttft_ms === 'number' ? o.ttft_ms : null,
      model,
      contextWindow,
      maxOutputTokens,
      usage: u
        ? {
            inputTokens: typeof u.input_tokens === 'number' ? u.input_tokens : 0,
            outputTokens: typeof u.output_tokens === 'number' ? u.output_tokens : 0,
            cacheCreationInputTokens:
              typeof u.cache_creation_input_tokens === 'number' ? u.cache_creation_input_tokens : 0,
            cacheReadInputTokens: typeof u.cache_read_input_tokens === 'number' ? u.cache_read_input_tokens : 0,
          }
        : null,
    };
    return { activities, streamedText, result };
  }

  return { activities, streamedText };
}

export const claudeHarness: Harness = {
  name: 'claude',
  displayName: 'Claude Code',
  binary: 'claude',
  async detect() {
    try {
      const { stdout } = await execFileAsync('claude', ['--version'], { timeout: 5000 });
      return { ok: true, version: stdout.trim() };
    } catch {
      return { ok: false, hint: 'Install Claude Code: https://docs.anthropic.com/en/docs/claude-code' };
    }
  },
  buildArgs(opts: BuildArgsOpts): string[] {
    const mode = opts.nativePermission ?? PERMISSION_MAP[opts.permission] ?? 'acceptEdits';
    const args = [
      '-p',
      opts.prompt,
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-mode',
      mode,
    ];
    if (opts.resumeSessionId) args.push('--resume', opts.resumeSessionId);
    else args.push('--no-session-persistence');
    if (opts.model) args.push('--model', opts.model);
    if (opts.maxBudgetUsd !== undefined) args.push('--max-budget-usd', String(opts.maxBudgetUsd));
    for (const dir of opts.addDirs ?? []) args.push('--add-dir', dir);
    return args;
  },
  parseLine(line: string, state: ParseState): ParseOutcome {
    return parseClaudeLine(line, state);
  },
  extractResult(state: ParseState): StreamedResult | null {
    return state.result;
  },
  permissionMap: {
    readonly: ['plan'],
    edit: ['acceptEdits'],
    danger: ['bypassPermissions'],
  },
  // No `acp` subcommand exists (docs/acp-harness-assessment.md §2) — confirmed against the full
  // `claude --help` output, not just an earlier probe.
  supportsTransports: ['stdout'],
};
