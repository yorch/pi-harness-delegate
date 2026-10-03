/**
 * Memory caps shared by both runners (`runner.ts` for stdout harnesses, `acp-runner.ts` for ACP):
 * a misbehaving or compromised harness can stream without bound, so accumulated text and activity
 * events are capped here, once, instead of in two hand-copied blocks that could drift.
 */
import type { ActivityEvent, ParseState } from './harnesses/types.ts';

/** Max characters of streamed text kept per run (5MB) — beyond this the stream is truncated. */
export const MAX_STREAMED_CHARS = 5 * 1024 * 1024;
/** Max activity events kept (and forwarded to `onActivity`) per run. */
export const MAX_ACTIVITIES = 5000;

/**
 * Append a streamed chunk to `state.streamedText`, truncating at `max` with a
 * `[truncated N chars]` marker, and forward exactly what was kept to `onStream`. Once the cap has
 * been reached, further chunks are dropped (and not forwarded). Returns the appended chunk, or
 * `null` when nothing was appended.
 */
export function appendStreamed(
  state: ParseState,
  text: string,
  onStream?: (chunk: string) => void,
  max: number = MAX_STREAMED_CHARS,
): string | null {
  if (!text || state.streamedText.length >= max) return null;
  const remaining = max - state.streamedText.length;
  const chunk =
    text.length > remaining ? `${text.slice(0, remaining)} [truncated ${text.length - remaining} chars]` : text;
  state.streamedText += chunk;
  onStream?.(chunk);
  return chunk;
}

/** Append activity events to `state.activities` up to `max`, forwarding each kept one to `onActivity`. */
export function appendActivities(
  state: ParseState,
  activities: readonly ActivityEvent[],
  onActivity?: (ev: ActivityEvent) => void,
  max: number = MAX_ACTIVITIES,
): void {
  for (const a of activities) {
    if (state.activities.length >= max) return;
    state.activities.push(a);
    onActivity?.(a);
  }
}
