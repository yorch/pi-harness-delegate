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

import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
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

/** realpath of `p`, or — when `p` doesn't exist yet — realpath of its nearest existing ancestor
 *  with the missing tail re-appended, so a not-yet-created dir under a symlink still resolves
 *  through that symlink. */
function realpathOrAncestor(p: string): string {
  let cur = p;
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(cur), ...tail);
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return p;
      tail.unshift(basename(cur));
      cur = parent;
    }
  }
}

/**
 * The model-supplied `addDirs` entries that resolve **outside** `cwd` — after `resolve()` against
 * `cwd` and symlink resolution on both sides, so neither `..` nor a symlink inside the repo
 * pointing out of it escapes. Empty when every entry stays inside the working directory.
 */
export function addDirsOutsideCwd(cwd: string, addDirs: string[] | undefined): string[] {
  if (!addDirs || addDirs.length === 0) return [];
  const root = realpathOrAncestor(resolve(cwd));
  const out: string[] = [];
  for (const d of addDirs) {
    const real = realpathOrAncestor(resolve(cwd, d));
    const rel = relative(root, real);
    const inside = rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
    if (!inside) out.push(real);
  }
  return out;
}

/**
 * Gate model-requested `addDirs` on the `delegate` tool. `addDirs` widens what the harness may
 * touch — on `codex`/`claude`/`amp` the extra dir is writable on any non-readonly run, and even a
 * `readonly` run can read it — so a model-set entry (prompt-injection reachable, same trust model as
 * `allowDangerous`/`verify`) may only stay inside the working directory on its own. Anything that
 * resolves outside it needs a human's `ctx.ui.confirm`; with no UI, fail closed. Template
 * frontmatter (trusted on-disk config) and the human-typed `/delegate --add-dir` never call this.
 */
export async function confirmToolAddDirs(
  ctx: Pick<ExtensionContext, 'hasUI' | 'cwd'> & { ui?: { confirm?: ExtensionContext['ui']['confirm'] } },
  addDirs: string[] | undefined,
): Promise<void> {
  const outside = addDirsOutsideCwd(ctx.cwd, addDirs);
  if (outside.length === 0) return;
  const list = outside.join(', ');
  if (!ctx.hasUI || typeof ctx.ui?.confirm !== 'function') {
    throw new Error(
      `addDirs outside the working directory requested (${list}), but there is no interactive UI to confirm it with — refusing (extra directories outside the project need a human's explicit approval)`,
    );
  }
  let ok = false;
  try {
    ok = await ctx.ui.confirm(
      'Allow access outside the project?',
      `The agent wants the delegated harness to access directories outside ${ctx.cwd}:\n\n${outside.map(d => `  ${d}`).join('\n')}\n\nOn non-readonly runs these may be writable.`,
    );
  } catch {
    ok = false;
  }
  if (!ok) throw new Error(`addDirs outside the working directory (${list}) were declined by the user`);
}
