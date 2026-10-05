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
import { effectiveTemplateTier, isProjectTrusted } from './engine.ts';
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
}

/** `will apply (<harness>): …` for each harness — the resolved model, budget, timeout, transport and verify. */
export function effectiveRunLines(
  ctx: ExtensionContext,
  config: DelegateConfig,
  harnessNames: readonly string[],
  mode: string,
  call: EffectiveCall,
): string[] {
  const trusted = isProjectTrusted(ctx);
  return harnessNames.map(name => {
    const label = `will apply (${safeName(name)})`;
    const harness = getHarness(name);
    const template = loadTemplates(ctx.cwd, name, trusted).get(mode);
    if (!harness || !template) return `${label}: mode ${quoteFull(mode)} does not resolve for this harness`;
    const raw = call.model ?? template.model ?? config.harnesses[name]?.model ?? config.model;
    const model = resolveModelForHarness(config, name, call.model, template.model);
    const aliased = raw !== undefined && model !== undefined && raw !== model ? ` (alias ${quoteFull(raw)})` : '';
    const configured = template.maxBudgetUsd ?? config.maxBudgetUsd ?? config.harnesses[name]?.maxBudgetUsd;
    const budget =
      call.budgetUsd === undefined
        ? configured
        : call.budgetNarrowOnly === true && configured !== undefined
          ? Math.min(call.budgetUsd, configured)
          : call.budgetUsd;
    const timeoutMs = resolveRunTimeoutMs(
      config,
      name,
      template.timeoutSec,
      call.timeoutSec,
      call.timeoutMayRaise === true,
    );
    let transport: string;
    try {
      transport = resolveTransport(config, name, harness);
    } catch (err) {
      transport = `INVALID (${err instanceof Error ? err.message : 'error'})`;
    }
    const verify = resolveVerifyPlan(call.verify, template.verify, effectiveTemplateTier(name, template));
    const verifyText = !verify
      ? ''
      : `, verify ${quoteFull(verify.command)} (${call.verify ? 'typed' : 'from the template'}${verify.skip ? '; not run on a readonly tier' : '; runs on this machine after the harness exits'})`;
    return `${label}: model ${model === undefined ? 'harness default' : `${quoteFull(model)}${aliased}`}, budget ${budget === undefined ? 'none' : `$${budget}`}, timeout ${Math.round(timeoutMs / 1000)}s, transport ${transport}${verifyText}`;
  });
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
