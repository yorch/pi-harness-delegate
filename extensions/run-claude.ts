/** @deprecated use extensions/runner.ts + harnesses/claude.ts directly */

import { claudeHarness } from './harnesses/claude.ts';
import type { ActivityEvent, StreamedResult } from './harnesses/types.ts';
import { runHarness } from './runner.ts';

export interface RunClaudeOptions {
  prompt: string;
  cwd: string;
  permissionMode: string;
  model?: string;
  maxBudgetUsd?: number;
  addDirs?: string[];
  signal?: AbortSignal;
  timeoutMs?: number;
  resumeSessionId?: string;
  onStream?: (text: string) => void;
  onActivity?: (ev: ActivityEvent) => void;
}

export interface ClaudeResult extends StreamedResult {
  streamedText: string;
}

export const DEFAULT_TIMEOUT_MS = 600_000;

function mapPerm(mode: string): 'readonly' | 'edit' | 'danger' {
  if (mode === 'plan') return 'readonly';
  if (mode === 'bypassPermissions') return 'danger';
  return 'edit';
}

export function runClaude(opts: RunClaudeOptions): Promise<ClaudeResult> {
  const perm = mapPerm(opts.permissionMode);
  const nativePerm =
    perm === 'readonly' && opts.permissionMode !== 'plan'
      ? opts.permissionMode
      : perm === 'danger' && opts.permissionMode !== 'bypassPermissions'
        ? opts.permissionMode
        : undefined;
  // normalize: if caller passed a non-standard mode, preserve as native
  const isStandard =
    opts.permissionMode === 'plan' ||
    opts.permissionMode === 'acceptEdits' ||
    opts.permissionMode === 'bypassPermissions';
  return runHarness({
    harness: claudeHarness,
    prompt: opts.prompt,
    cwd: opts.cwd,
    permission: perm,
    nativePermission: isStandard ? undefined : opts.permissionMode,
    model: opts.model,
    maxBudgetUsd: opts.maxBudgetUsd,
    addDirs: opts.addDirs,
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
    resumeSessionId: opts.resumeSessionId,
    onStream: opts.onStream,
    onActivity: opts.onActivity,
  }).then((r) => ({ ...r, streamedText: r.streamedText }));
}
