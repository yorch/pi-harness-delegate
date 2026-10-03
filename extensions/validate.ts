/**
 * Input validation for values that end up on a harness's (or `gh`'s) command line.
 *
 * `sessionId`, `model`, and `pr` all reach `spawn()`/`pi.exec()` argv — no shell, so no shell
 * injection, but a value starting with `-` would be parsed by the target CLI as a *flag* (argument
 * injection: e.g. a `sessionId` of `--dangerously-bypass-…` or a `pr` of `--repo=evil/x`). These
 * values are model-settable on the `delegate` tool, and the model's context is attacker-influenceable,
 * so they're validated once at the shared `delegate()` entry (both tool and `/delegate` paths) and
 * up front on fan-out — never left to each harness's `buildArgs`.
 */

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

const SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const PR_NUMBER_RE = /^\d{1,10}$/;
const PR_SHORTHAND_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}#\d{1,10}$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/** Returns an error message, or null when `id` is an acceptable session id. */
export function sessionIdError(id: string): string | null {
  if (id.startsWith('-') || !SESSION_ID_RE.test(id))
    return `invalid sessionId ${JSON.stringify(id.slice(0, 60))} — expected 1-128 chars of [A-Za-z0-9._:-], not starting with "-" (use the session id from a previous run's details)`;
  return null;
}

/** Returns an error message, or null when `model` is an acceptable model name. */
export function modelError(model: string): string | null {
  if (model.length === 0 || model.length > 200 || model.startsWith('-') || CONTROL_RE.test(model))
    return `invalid model ${JSON.stringify(model.slice(0, 60))} — must be a non-empty name, not starting with "-"`;
  return null;
}

/** Returns an error message, or null when `pr` is a PR number, an http(s) URL, or `owner/repo#n`. */
export function prError(pr: string): string | null {
  const bad = `invalid pr ${JSON.stringify(pr.slice(0, 80))} — expected a PR number, an http(s) PR URL, or owner/repo#123`;
  if (pr.startsWith('-') || CONTROL_RE.test(pr)) return bad;
  if (PR_NUMBER_RE.test(pr) || PR_SHORTHAND_RE.test(pr)) return null;
  try {
    const url = new URL(pr);
    if (url.protocol === 'http:' || url.protocol === 'https:') return null;
  } catch {
    // not a URL
  }
  return bad;
}

/** Returns an error message, or null when `dir` is an acceptable extra directory path. */
export function addDirError(dir: string): string | null {
  if (dir.length === 0 || dir.length > 4096 || dir.startsWith('-') || CONTROL_RE.test(dir))
    return `invalid addDirs entry ${JSON.stringify(dir.slice(0, 80))} — must be a non-empty path, not starting with "-"`;
  return null;
}

export interface ValidatableInputs {
  sessionId?: string;
  model?: string;
  pr?: string;
  addDirs?: string[];
}

/** Throws a clear Error on the first invalid argv-bound input; returns normally otherwise. */
export function validateDelegateInputs(inputs: ValidatableInputs): void {
  const errors = [
    inputs.sessionId !== undefined ? sessionIdError(inputs.sessionId) : null,
    inputs.model !== undefined ? modelError(inputs.model) : null,
    inputs.pr !== undefined ? prError(inputs.pr) : null,
    ...(inputs.addDirs ?? []).map(addDirError),
  ];
  const first = errors.find((e): e is string => e !== null);
  if (first) throw new Error(first);
}

/**
 * Gate a model-requested `allowDangerous: true` on the `delegate` tool behind a human: a tool
 * param is model-settable (prompt-injection reachable), and `danger` means an unrestricted
 * harness, so the model alone must never be able to grant it. With a UI, ask via
 * `ctx.ui.confirm`; without one there is nobody to ask, so fail closed with a clear error. The
 * `/delegate` command path never calls this — a human typed it.
 */
export async function confirmDangerousToolCall(
  ctx: Pick<ExtensionContext, 'hasUI'> & { ui?: { confirm?: ExtensionContext['ui']['confirm'] } },
  summary: { harness?: string; mode?: string; task: string },
): Promise<void> {
  const target = `${summary.harness ?? 'default harness'} ${summary.mode ?? 'default mode'}`;
  if (!ctx.hasUI || typeof ctx.ui?.confirm !== 'function') {
    throw new Error(
      `allowDangerous requested for ${target}, but there is no interactive UI to confirm it with — refusing (danger permission needs a human's explicit approval; run it from an interactive session)`,
    );
  }
  const task = summary.task.length > 200 ? `${summary.task.slice(0, 199)}…` : summary.task;
  let ok = false;
  try {
    ok = await ctx.ui.confirm(
      'Allow dangerous delegation?',
      `The agent wants to run ${target} with DANGER permission (unrestricted: no sandbox, no approval prompts).\n\nTask: ${task}`,
    );
  } catch {
    ok = false;
  }
  if (!ok) throw new Error(`allowDangerous for ${target} was declined by the user`);
}
