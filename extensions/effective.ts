/**
 * What a run will ACTUALLY apply, for the confirmation dialogs: the settings a person typed (or a model set)
 * are only part of it — the template, the config and the harness's own defaults fill in the rest (a model
 * alias is resolved, a template may carry its own `maxBudgetUsd` / `timeout:` / `verify:`, the transport comes
 * from config). One line per harness, every value escaped, resolved with the SAME functions the engine uses
 * (`resolveModelForHarness`, `resolveRunTimeoutMs`, `resolveTransport`, `resolveVerifyPlan`).
 */

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { resolveVerifyPlan } from './activity.ts';
import { resolveHarnessList } from './command.ts';
import { type DelegateConfig, resolveModelForHarness, resolveRunTimeoutMs, resolveTransport } from './config.ts';
import { isProjectTrusted, mergeAddDirs, resolveRunPermission } from './engine.ts';
import { detectAll, getHarness, HARNESS_NAMES, isKnownHarness, resolveHarnessName } from './harnesses/registry.ts';
import { loadTemplates, quoteFull } from './templates.ts';
import { safeName } from './validate.ts';

/** The per-call values that feed the resolution (what was typed / model-set — the rest is config and template). */
export interface EffectiveCall {
  model?: string;
  budgetUsd?: number;
  /** The budget came from stored data: it can only lower a configured one. */
  budgetNarrowOnly?: boolean;
  timeoutSec?: number;
  /** A human typed the timeout (it may raise the configured one); a model-set or stored one only lowers. */
  timeoutMayRaise?: boolean;
  verify?: string;
  /**
   * `allowDangerous` is being confirmed / applied for this run: the run's tier is then `danger` whatever the
   * template says — which is what decides whether the verify command runs (`resolveRunPermission`, engine.ts, the
   * engine's own rule). Every call site that confirms or applies `allowDangerous` MUST say so.
   */
  allowDangerous?: boolean;
  /** The task the call carries (the tool's): empty means the engine runs the template's `defaultTask`, which is then shown. */
  task?: string;
}

/** `text` quoted in full when it is short, else its first `max` characters, escaped, with the exact count left out. */
function quoteHead(text: string, max: number): string {
  const cps = Array.from(text);
  if (cps.length <= max) return quoteFull(text);
  return `${quoteFull(cps.slice(0, max).join(''))} (+${cps.length - max} more characters)`;
}

type Facts = [key: string, text: string][];

/**
 * `will apply` rows for the harness(es) of a run: the resolved model, budget, timeout, transport, the native
 * permission the run passes on, the template's own `addDirs`, and the verify command — each resolved with the SAME
 * functions the engine uses (`resolveModelForHarness`, `resolveRunTimeoutMs`, `resolveTransport`,
 * `resolveRunPermission`, `resolveVerifyPlan`, `mergeAddDirs`). One row for a single harness; for a fan-out one
 * shared row (`will apply (all N): …`) for what every member has in common plus one short row per member for only the
 * facts that differ — so a 5-harness fan-out costs a row or two, not five long ones.
 */
export function effectiveRunLines(
  ctx: ExtensionContext,
  config: DelegateConfig,
  harnessNames: readonly string[],
  mode: string,
  call: EffectiveCall,
): string[] {
  const trusted = isProjectTrusted(ctx);
  const rows: string[] = [];
  const members: { name: string; facts: Facts }[] = [];
  for (const name of harnessNames) {
    const harness = getHarness(name);
    const template = loadTemplates(ctx.cwd, name, trusted).get(mode);
    if (!harness || !template) {
      rows.push(`will apply (${safeName(name)}): mode ${quoteFull(mode)} does not resolve for this harness`);
      continue;
    }
    const facts: Facts = [];
    const raw = call.model ?? template.model ?? config.harnesses[name]?.model ?? config.model;
    const model = resolveModelForHarness(config, name, call.model, template.model);
    const aliased = raw !== undefined && model !== undefined && raw !== model ? ` (alias ${quoteFull(raw)})` : '';
    facts.push(['model', `model ${model === undefined ? 'harness default' : `${quoteFull(model)}${aliased}`}`]);
    const configured = template.maxBudgetUsd ?? config.maxBudgetUsd ?? config.harnesses[name]?.maxBudgetUsd;
    const narrowed = call.budgetUsd !== undefined && call.budgetNarrowOnly === true && configured !== undefined;
    const budget =
      call.budgetUsd === undefined ? configured : narrowed ? Math.min(call.budgetUsd, configured) : call.budgetUsd;
    facts.push([
      'budget',
      `budget ${budget === undefined ? 'none' : `$${budget}`}${call.budgetNarrowOnly === true && call.budgetUsd !== undefined ? ' (stored: only lowers)' : ''}`,
    ]);
    const timeoutMs = resolveRunTimeoutMs(
      config,
      name,
      template.timeoutSec,
      call.timeoutSec,
      call.timeoutMayRaise === true,
    );
    facts.push([
      'timeout',
      `timeout ${Math.round(timeoutMs / 1000)}s${call.timeoutSec !== undefined && call.timeoutMayRaise !== true ? ' (only lowers)' : ''}`,
    ]);
    let transport: string;
    try {
      transport = resolveTransport(config, name, harness);
    } catch (err) {
      transport = `INVALID (${err instanceof Error ? err.message : 'error'})`;
    }
    facts.push(['transport', `transport ${transport}`]);
    // the permission the run ACTUALLY has (escalated by an approved allowDangerous): the engine's own rule
    const perm = resolveRunPermission(harness, template, call.allowDangerous === true);
    if (perm.nativePermissionForRun !== undefined)
      facts.push(['native', `native permission ${quoteFull(perm.nativePermissionForRun)} (as the template declares)`]);
    const dirs = mergeAddDirs(ctx.cwd, template.addDirs, undefined);
    if (dirs) facts.push(['tpl-dirs', `template addDirs (${dirs.length}): ${dirs.map(quoteFull).join(' · ')}`]);
    if (!call.task && template.defaultTask)
      facts.push([
        'tpl-task',
        `no task given: the template's default task runs: ${quoteHead(template.defaultTask, 100)}`,
      ]);
    const verify = resolveVerifyPlan(call.verify, template.verify, perm.permission);
    if (verify)
      facts.push([
        'verify',
        `verify ${quoteFull(verify.command)} (${call.verify ? 'typed' : 'from the template'}; ${verify.skip ? 'NOT run: readonly tier' : 'runs on this machine after the harness exits'})`,
      ]);
    members.push({ name, facts });
  }
  if (members.length === 1) {
    const m = members[0];
    rows.unshift(`will apply (${safeName(m.name)}): ${m.facts.map(f => f[1]).join(', ')}`);
    return rows;
  }
  if (members.length > 1) {
    const keys = [...new Set(members.flatMap(m => m.facts.map(f => f[0])))];
    const at = (m: (typeof members)[number], k: string): string | undefined => m.facts.find(f => f[0] === k)?.[1];
    // the shared row carries each fact's most common value (when at least two members have it); a member whose own
    // value differs, or that has a fact the shared value is not, lists it itself
    const shared = new Map<string, string>();
    for (const k of keys) {
      const counts = new Map<string, number>();
      for (const m of members) {
        const v = at(m, k);
        if (v !== undefined) counts.set(v, (counts.get(v) ?? 0) + 1);
      }
      const [best, n] = [...counts.entries()].sort((x, y) => y[1] - x[1])[0] ?? ['', 0];
      if (n >= 2) shared.set(k, best);
    }
    const out: string[] = [];
    if (shared.size > 0) out.push(`will apply (all ${members.length}): ${[...shared.values()].join(', ')}`);
    for (const m of members) {
      const own = m.facts.filter(f => shared.get(f[0]) !== f[1]).map(f => f[1]);
      // a member that LACKS a shared fact says so (the shared row would otherwise claim it for everyone)
      const lacks = [...shared.keys()].filter(k => at(m, k) === undefined);
      if (lacks.length > 0) own.push(`no ${lacks.join(' / ')}`);
      if (own.length > 0) out.push(`will apply (${safeName(m.name)}): ${own.join(', ')}`);
    }
    rows.unshift(...out);
  }
  return rows;
}

/**
 * The harness(es) and mode a call will actually use — the names a confirmation shows instead of "default
 * harness" / "default mode": the spec resolved the way the engine does (config default, alias, and for a
 * fan-out spec `all` / a list the detected harnesses), and the mode's default from config.
 */
export async function resolveRunTargets(
  config: DelegateConfig,
  harnessSpec: string | undefined,
  mode: string | undefined,
): Promise<{ harnesses: string[]; mode: string }> {
  const spec = harnessSpec || config.defaultHarness || 'claude';
  const resolvedMode = mode || config.defaultMode;
  // a name or an explicit list needs no probing (an uninstalled one is skipped at run time and reported then);
  // only `all` has to ask which harnesses are installed
  if (spec.trim().toLowerCase() !== 'all')
    return {
      harnesses: [
        ...new Set(
          spec
            .split(',')
            .filter(Boolean)
            .map(n => resolveHarnessName(n.trim().toLowerCase())),
        ),
      ],
      mode: resolvedMode,
    };
  const { resolved } = resolveHarnessList(spec, {
    knownHarnesses: HARNESS_NAMES,
    aliasOf: resolveHarnessName,
    isKnown: isKnownHarness,
    detection: await detectAll(),
  });
  return { harnesses: resolved, mode: resolvedMode };
}
