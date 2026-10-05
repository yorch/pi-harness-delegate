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
import type { DelegateOptions } from './engine.ts';
import {
  describeTextSummary,
  escapeForDisplay,
  quoteCapped,
  renderTextBlock,
  SCOPE_LIMITS,
  TASK_LIMITS,
  textTooLongReason,
} from './sanitize.ts';
import { quoteFull, quoteValue } from './templates.ts';

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
  return PLAIN_NAME_RE.test(name) ? name : quoteCapped(name, 200);
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

/** The longest single value (a session id, model, PR reference, directory) a confirmation shows; more is refused on a model-set path. */
export const MAX_CONFIRM_FIELD_CHARS = 500;
/** The most extra directories a single confirmation lists. */
export const MAX_CONFIRM_DIRS = 10;

/**
 * Everything on a run that steers what it does — what a danger confirmation (and a fan-out resume plan)
 * must show, because approving it approves all of it. Callers pass what they have; absent = not set.
 */
export interface RunSteering {
  /** The harness(es) that will run (a fan-out lists them all). */
  harnesses?: string[];
  mode?: string;
  task?: string;
  scope?: string;
  model?: string;
  sessionId?: string;
  /** harness -> its own session id (a fan-out resume). */
  sessions?: Record<string, string>;
  pr?: string;
  budgetUsd?: number;
  timeoutSec?: number;
  /** Every entry, those inside the working directory too — they are all handed to the harness. */
  addDirs?: string[];
  /** A host-run verify command (human-typed only — never on the tool path). */
  verify?: string;
}

/**
 * Which `DelegateOptions` keys a danger / resume confirmation shows (`shown`) and which it deliberately
 * does not (`hidden`, with the reason). `Record<keyof DelegateOptions, …>` makes adding an option to the
 * engine a compile error until someone decides — a steering option nobody displays is how a confirmation
 * ends up approving less than what runs (tests/confirm-steering.test.ts also checks the tool's schema).
 */
export const STEERING_DISPLAY: Record<keyof DelegateOptions, 'shown' | 'hidden'> = {
  harness: 'shown',
  task: 'shown',
  mode: 'shown',
  scope: 'shown',
  model: 'shown',
  maxBudgetUsd: 'shown',
  allowDangerous: 'hidden', // the very thing being confirmed
  sessionId: 'shown',
  pr: 'shown',
  addDirs: 'shown',
  timeoutSec: 'shown',
  timeoutSecMayRaise: 'hidden', // set by the command path only; the shown timeout is the typed value
  maxBudgetNarrowOnly: 'hidden', // narrows a shown budget, never widens
  verify: 'shown',
  onStream: 'hidden', // callbacks / plumbing, not run steering
  onActivity: 'hidden',
  signal: 'hidden',
  waitForSlot: 'hidden',
  onAcquired: 'hidden',
  fanoutId: 'hidden', // bookkeeping
  origin: 'hidden', // bookkeeping
  tierCeiling: 'hidden', // can only narrow what a run may resolve to
};

/** The tool's own parameters, likewise: shown in the danger / resume confirmation or deliberately not. */
export const TOOL_PARAM_DISPLAY: Record<string, 'shown' | 'hidden'> = {
  harness: 'shown',
  task: 'shown',
  mode: 'shown',
  scope: 'shown',
  model: 'shown',
  maxBudgetUsd: 'shown',
  timeoutSec: 'shown',
  sessionId: 'shown',
  resumeFanout: 'shown', // the resume plan names the fan-out and every member's session
  allowDangerous: 'hidden', // the very thing being confirmed
  pr: 'shown',
  addDirs: 'shown',
};

const money = (n: number): string => `$${n}`;

/** The one-line-per-fact part of a steering display (everything but the multi-line task / scope blocks). */
export function steeringFieldLines(s: RunSteering): string[] {
  const out: string[] = [];
  if (s.model !== undefined) out.push(`model: ${quoteFull(s.model)}`);
  if (s.sessionId !== undefined) out.push(`session: resumes ${quoteFull(s.sessionId)}`);
  if (s.sessions && Object.keys(s.sessions).length > 0)
    out.push(...Object.entries(s.sessions).map(([h, id]) => `session (${safeName(h)}): resumes ${quoteFull(id)}`));
  if (s.pr !== undefined) out.push(`pr: ${quoteFull(s.pr)}`);
  if (s.budgetUsd !== undefined) out.push(`budget: ${money(s.budgetUsd)}`);
  if (s.timeoutSec !== undefined) out.push(`timeout: ${s.timeoutSec}s`);
  if (s.addDirs !== undefined && s.addDirs.length > 0)
    out.push(`addDirs (${s.addDirs.length}): ${s.addDirs.map(quoteFull).join(', ')}`);
  if (s.verify !== undefined) out.push(`verify (runs on this machine after the harness exits): ${quoteFull(s.verify)}`);
  return out;
}

/**
 * The scope and task blocks followed by their one-line summaries — the summaries LAST, because a
 * dialog is bottom-anchored and the last lines are the ones always on screen.
 */
export function steeringTextBlocks(s: RunSteering, taskLabel = 'Task'): string[] {
  const out: string[] = [];
  if (s.scope !== undefined) out.push(renderTextBlock('Scope', s.scope, SCOPE_LIMITS));
  if (s.task !== undefined) out.push(renderTextBlock(taskLabel, s.task, TASK_LIMITS));
  const summary: string[] = [];
  if (s.scope !== undefined) summary.push(describeTextSummary('scope', s.scope));
  if (s.task !== undefined) summary.push(describeTextSummary(taskLabel.toLowerCase(), s.task));
  if (summary.length > 0) out.push(summary.join('\n'));
  return out;
}

/**
 * Why a MODEL-SET run cannot be put in front of a person (null = it can): a task / scope too tall or
 * long to show whole, or a field / directory list too big to list. The model has no `--long-task`: a
 * value that cannot be reviewed in full is simply not run behind a confirmation.
 */
export function steeringRefusal(s: RunSteering): string | null {
  const tooLong = (label: string, reason: string): string =>
    `the ${label} is ${reason} — too long for a person to review in the confirmation, so it is refused. Shorten it`;
  if (s.task !== undefined) {
    const r = textTooLongReason(s.task, TASK_LIMITS);
    if (r) return tooLong('task', r);
  }
  if (s.scope !== undefined) {
    const r = textTooLongReason(s.scope, SCOPE_LIMITS);
    if (r) return tooLong('scope', r);
  }
  for (const [label, v] of [
    ['model', s.model],
    ['sessionId', s.sessionId],
    ['pr', s.pr],
    ['verify', s.verify],
  ] as const)
    if (v !== undefined && Array.from(v).length > MAX_CONFIRM_FIELD_CHARS)
      return `the ${label} is longer than the ${MAX_CONFIRM_FIELD_CHARS} characters a confirmation shows — refused`;
  if (s.addDirs !== undefined) {
    if (s.addDirs.length > MAX_CONFIRM_DIRS)
      return `${s.addDirs.length} addDirs entries — more than the ${MAX_CONFIRM_DIRS} a confirmation lists — refused`;
    if (s.addDirs.some(d => Array.from(d).length > MAX_CONFIRM_FIELD_CHARS))
      return `an addDirs entry is longer than the ${MAX_CONFIRM_FIELD_CHARS} characters a confirmation shows — refused`;
  }
  return null;
}

/**
 * The one danger-confirmation primitive shared by the tool and command paths: with a UI, ask via
 * `ctx.ui.confirm` (a decline or a throwing dialog counts as "no"); without one there is nobody to
 * ask, so fail closed. Resolves only on an explicit approval; throws the caller's message otherwise.
 *
 * What the human approves is shown whole: every steering field (`steeringFieldLines`), the scope and
 * task as escaped blocks (head + tail with an explicit "not shown" marker beyond the limits — only a
 * human-typed value ever reaches that; a model-set one is refused first, `refuseLong`), and the
 * one-line summaries last.
 */
async function askDangerConfirmation(
  ctx: ConfirmCtx,
  opts: {
    steering: RunSteering;
    body: string;
    noUiError: string;
    declinedError: string;
    /** Refuse (rather than abbreviate) a task / scope / field too big to show whole — the model-set tool path. */
    refuseLong: boolean;
  },
): Promise<void> {
  if (!ctx.hasUI || typeof ctx.ui?.confirm !== 'function') throw new Error(opts.noUiError);
  if (opts.refuseLong) {
    const why = steeringRefusal(opts.steering);
    if (why) throw new Error(`allowDangerous refused: ${why}`);
  }
  const text = [opts.body, ...steeringFieldLines(opts.steering), '', ...steeringTextBlocks(opts.steering)].join('\n');
  let ok = false;
  try {
    ok = await ctx.ui.confirm('Allow dangerous delegation?', text);
  } catch {
    ok = false;
  }
  if (!ok) throw new Error(opts.declinedError);
}

/** What the tool's danger confirmation is shown — the tool params that steer a run. */
export interface ToolDangerSummary {
  harness?: string;
  mode?: string;
  task: string;
  scope?: string;
  model?: string;
  maxBudgetUsd?: number;
  timeoutSec?: number;
  sessionId?: string;
  pr?: string;
  addDirs?: string[];
}

/**
 * Gate a model-requested `allowDangerous: true` on the `delegate` tool behind a human: a tool
 * param is model-settable (prompt-injection reachable), and `danger` means an unrestricted
 * harness, so the model alone must never be able to grant it. With a UI, ask via
 * `ctx.ui.confirm`; without one there is nobody to ask, so fail closed with a clear error. The
 * confirmation shows every param that steers the run, and a task / scope too long to review is
 * refused outright. The `/delegate` command path uses `confirmDangerousCommand` instead.
 */
export async function confirmDangerousToolCall(ctx: ConfirmCtx, summary: ToolDangerSummary): Promise<void> {
  // harness/mode are model-set strings: quoted (escapes, bidi, zero-width all rendered as \uXXXX)
  const target = `${summary.harness === undefined ? 'default harness' : safeName(summary.harness)} ${summary.mode === undefined ? 'default mode' : safeName(summary.mode)}`;
  await askDangerConfirmation(ctx, {
    steering: {
      task: summary.task,
      scope: summary.scope,
      model: summary.model,
      sessionId: summary.sessionId,
      pr: summary.pr,
      budgetUsd: summary.maxBudgetUsd,
      timeoutSec: summary.timeoutSec,
      addDirs: summary.addDirs,
    },
    refuseLong: true,
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
  summary: {
    harnesses: string[];
    mode: string;
    task: string;
    scope?: string;
    model?: string;
    budget?: number;
    timeoutSec?: number;
    sessionId?: string;
    sessions?: Record<string, string>;
    pr?: string;
    addDirs?: string[];
    verify?: string;
  },
): Promise<void> {
  const n = summary.harnesses.length;
  const names = summary.harnesses.map(safeName).join(', ');
  const mode = quoteCapped(summary.mode, 200);
  const target = `${names} ${safeName(summary.mode)}`;
  await askDangerConfirmation(ctx, {
    steering: {
      task: summary.task,
      scope: summary.scope,
      model: summary.model,
      budgetUsd: summary.budget,
      timeoutSec: summary.timeoutSec,
      sessionId: summary.sessionId,
      sessions: summary.sessions,
      pr: summary.pr,
      addDirs: summary.addDirs,
      verify: summary.verify,
    },
    refuseLong: false,
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
  // directory names are model-set or stored: quoted so escapes / bidi / zero-width can't hide in them,
  // and shown whole — which is why a list too long (or an entry too big) to show whole is refused: a
  // dialog taller than the screen scrolls its top away
  const refusal =
    outside.length > MAX_CONFIRM_DIRS
      ? `${outside.length} directories outside the project — more than the ${MAX_CONFIRM_DIRS} a confirmation lists`
      : outside.some(d => Array.from(d).length > MAX_CONFIRM_FIELD_CHARS)
        ? `a directory path longer than the ${MAX_CONFIRM_FIELD_CHARS} characters a confirmation shows`
        : null;
  const list = outside.map(d => quoteFull(d)).join(', ');
  const lead =
    source === 'record'
      ? 'The run record being repeated lists extra directories the delegated harness would access'
      : 'The agent wants the delegated harness to access directories';
  if (!ctx.hasUI || typeof ctx.ui?.confirm !== 'function') {
    throw new Error(
      `addDirs outside the working directory requested (${outside.length > MAX_CONFIRM_DIRS ? `${outside.length} entries` : list}), but there is no interactive UI to confirm it with — refusing (extra directories outside the project need a human's explicit approval)`,
    );
  }
  if (refusal) throw new Error(`addDirs outside the working directory refused: ${refusal}. Give fewer / shorter paths`);
  let ok = false;
  try {
    // this dialog lists directories only — the task being run is not part of it (the danger / rerun /
    // resume confirmations show that)
    ok = await ctx.ui.confirm(
      'Allow access outside the project?',
      `${lead} outside ${quoteFull(ctx.cwd)}:\n\n${outside.map(d => `  ${quoteFull(d)}`).join('\n')}\n\nOn non-readonly runs these may be writable.\n${outside.length} director${outside.length === 1 ? 'y' : 'ies'} outside the project — first: ${escapeForDisplay(quoteFull(outside[0]))}`,
    );
  } catch {
    ok = false;
  }
  if (!ok) throw new Error(`addDirs outside the working directory (${list}) were declined by the user`);
}
