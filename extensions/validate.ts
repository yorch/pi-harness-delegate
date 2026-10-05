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
import { sanitizeTemplateText } from './sanitize.ts';
import { quoteValue } from './templates.ts';

const SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const PR_NUMBER_RE = /^\d{1,10}$/;
const PR_SHORTHAND_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}#\d{1,10}$/;
// http(s)://<host>/<owner>/<repo>/pull/<n>[/files|?…|#…] — any host (GitHub Enterprise), but no
// userinfo (`user:pass@`) and nothing that isn't actually a pull-request URL.
const PR_URL_RE = /^https?:\/\/[^/@\s]+\/[^/\s]+\/[^/\s]+\/pull\/\d{1,10}(?:[/?#]\S*)?$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

// (a comma is fine: a harness spec may be a list like `claude,codex`)
const PLAIN_NAME_RE = /^[A-Za-z0-9_.,-]{1,200}$/;
/** A harness / mode name for a prompt or error: shown as is when it is an ordinary identifier, else
 *  quoted with every control / bidi / zero-width character escaped (`\\uXXXX`) — never raw. */
export function safeName(name: string): string {
  return PLAIN_NAME_RE.test(name) ? name : quoteValue(name, 200);
}

/** Returns an error message, or null when `id` is an acceptable session id. */
export function sessionIdError(id: string): string | null {
  if (id.startsWith('-') || !SESSION_ID_RE.test(id))
    return `invalid sessionId ${quoteValue(id.slice(0, 60), 200)} — expected 1-128 chars of [A-Za-z0-9._:-], not starting with "-" (use the session id from a previous run's details)`;
  return null;
}

/** Returns an error message, or null when `model` is an acceptable model name. */
export function modelError(model: string): string | null {
  if (model.length === 0 || model.length > 200 || model.startsWith('-') || CONTROL_RE.test(model))
    return `invalid model ${quoteValue(model.slice(0, 60), 200)} — must be a non-empty name, not starting with "-"`;
  return null;
}

/** Returns an error message, or null when `pr` is a PR number, an http(s) pull-request URL
 *  (`<host>/<owner>/<repo>/pull/<n>`, no userinfo), or `owner/repo#n`. */
export function prError(pr: string): string | null {
  const bad = `invalid pr ${quoteValue(pr.slice(0, 80), 240)} — expected a PR number, an http(s) PR URL, or owner/repo#123`;
  if (pr.startsWith('-') || CONTROL_RE.test(pr)) return bad;
  if (PR_NUMBER_RE.test(pr) || PR_SHORTHAND_RE.test(pr)) return null;
  if (PR_URL_RE.test(pr)) return null;
  return bad;
}

/**
 * Returns an error message, or null when `dir` is an acceptable extra directory path. Judged on its
 * *resolved* form, which is what actually reaches argv (`mergeAddDirs` resolves every entry against
 * cwd): an absolute path can't be parsed as a flag, so a legitimate relative dir like `-foo`
 * (→ `<cwd>/-foo`) is fine. Empty, oversized, and control-character entries are still rejected.
 */
export function addDirError(dir: string, cwd: string = process.cwd()): string | null {
  const bad = `invalid addDirs entry ${quoteValue(dir.slice(0, 80), 240)} — must be a non-empty path without control characters`;
  if (dir.length === 0 || dir.length > 4096 || CONTROL_RE.test(dir)) return bad;
  const abs = resolve(cwd, dir);
  if (!isAbsolute(abs) || abs.startsWith('-')) return bad;
  return null;
}

export interface ValidatableInputs {
  sessionId?: string;
  model?: string;
  pr?: string;
  addDirs?: string[];
  /** What relative `addDirs` resolve against (the run's cwd). */
  cwd?: string;
}

/** Throws a clear Error on the first invalid argv-bound input; returns normally otherwise. */
export function validateDelegateInputs(inputs: ValidatableInputs): void {
  const errors = [
    inputs.sessionId !== undefined ? sessionIdError(inputs.sessionId) : null,
    inputs.model !== undefined ? modelError(inputs.model) : null,
    inputs.pr !== undefined ? prError(inputs.pr) : null,
    ...(inputs.addDirs ?? []).map(d => addDirError(d, inputs.cwd)),
  ];
  const first = errors.find((e): e is string => e !== null);
  if (first) throw new Error(first);
}

type ConfirmCtx = Pick<ExtensionContext, 'hasUI'> & { ui?: { confirm?: ExtensionContext['ui']['confirm'] } };

/**
 * The one danger-confirmation primitive shared by the tool and command paths: with a UI, ask via
 * `ctx.ui.confirm` (a decline or a throwing dialog counts as "no"); without one there is nobody to
 * ask, so fail closed. Resolves only on an explicit approval; throws the caller's message otherwise.
 */
async function askDangerConfirmation(
  ctx: ConfirmCtx,
  opts: { task: string; body: string; noUiError: string; declinedError: string },
): Promise<void> {
  if (!ctx.hasUI || typeof ctx.ui?.confirm !== 'function') throw new Error(opts.noUiError);
  // the task may be model-set or read from a stored run record: one line, escapes/invisibles stripped
  const task = sanitizeTemplateText(opts.task, 200);
  let ok = false;
  try {
    ok = await ctx.ui.confirm('Allow dangerous delegation?', `${opts.body}\n\nTask: ${task}`);
  } catch {
    ok = false;
  }
  if (!ok) throw new Error(opts.declinedError);
}

/**
 * Gate a model-requested `allowDangerous: true` on the `delegate` tool behind a human: a tool
 * param is model-settable (prompt-injection reachable), and `danger` means an unrestricted
 * harness, so the model alone must never be able to grant it. With a UI, ask via
 * `ctx.ui.confirm`; without one there is nobody to ask, so fail closed with a clear error. The
 * `/delegate` command path uses `confirmDangerousCommand` instead.
 */
export async function confirmDangerousToolCall(
  ctx: ConfirmCtx,
  summary: { harness?: string; mode?: string; task: string },
): Promise<void> {
  // harness/mode are model-set strings: quoted (escapes, bidi, zero-width all rendered as \uXXXX)
  const target = `${summary.harness === undefined ? 'default harness' : safeName(summary.harness)} ${summary.mode === undefined ? 'default mode' : safeName(summary.mode)}`;
  await askDangerConfirmation(ctx, {
    task: summary.task,
    body: `The agent wants to run ${target} with DANGER permission (unrestricted: no sandbox, no approval prompts).`,
    noUiError: `allowDangerous requested for ${target}, but there is no interactive UI to confirm it with — refusing (danger permission needs a human's explicit approval; run it from an interactive session)`,
    declinedError: `allowDangerous for ${target} was declined by the user`,
  });
}

/**
 * Gate a human-typed `/delegate --allow-dangerous` behind the same interactive confirm. A human
 * typed the flag, but it's one token away from an unrestricted run (and also escalates a
 * non-danger template), so it's confirmed once more naming exactly what will run — one prompt
 * covering every harness of a fan-out. Headless sessions never honor it: there's no one to
 * confirm with, so it fails closed exactly like the tool path.
 */
export async function confirmDangerousCommand(
  ctx: ConfirmCtx,
  summary: { harnesses: string[]; mode: string; task: string },
): Promise<void> {
  const n = summary.harnesses.length;
  const names = summary.harnesses.map(safeName).join(', ');
  const mode = quoteValue(summary.mode, 200);
  const target = `${names} ${safeName(summary.mode)}`;
  await askDangerConfirmation(ctx, {
    task: summary.task,
    body: `--allow-dangerous: run ${mode} on ${n > 1 ? `all ${n} harnesses (${names})` : names} with DANGER permission — full, unrestricted permissions (no sandbox, no approval prompts). Applies to this invocation only.`,
    noUiError: `--allow-dangerous for ${target} needs interactive confirmation, but there is no UI — refusing (a headless /delegate never runs with danger permission)`,
    declinedError: `--allow-dangerous for ${target} was declined — nothing was run`,
  });
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
  /** Who is asking, for the prompt: the model (default), or a stored run record being rerun. */
  source: 'agent' | 'record' = 'agent',
): Promise<void> {
  const outside = addDirsOutsideCwd(ctx.cwd, addDirs);
  if (outside.length === 0) return;
  // directory names are model-set or stored: quoted so escapes / bidi / zero-width can't hide in them
  const list = outside.map(d => quoteValue(d, 300)).join(', ');
  const lead =
    source === 'record'
      ? 'The run record being repeated lists extra directories the delegated harness would access'
      : 'The agent wants the delegated harness to access directories';
  if (!ctx.hasUI || typeof ctx.ui?.confirm !== 'function') {
    throw new Error(
      `addDirs outside the working directory requested (${list}), but there is no interactive UI to confirm it with — refusing (extra directories outside the project need a human's explicit approval)`,
    );
  }
  let ok = false;
  try {
    ok = await ctx.ui.confirm(
      'Allow access outside the project?',
      `${lead} outside ${quoteValue(ctx.cwd, 300)}:\n\n${outside.map(d => `  ${quoteValue(d, 300)}`).join('\n')}\n\nOn non-readonly runs these may be writable.`,
    );
  } catch {
    ok = false;
  }
  if (!ok) throw new Error(`addDirs outside the working directory (${list}) were declined by the user`);
}
