import type { Usage } from '@earendil-works/pi-ai';

export interface HarnessUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  /** null when the harness didn't report cost — distinct from a measured $0. */
  totalCostUsd: number | null;
}

export type ClaudeUsage = HarnessUsage;

/**
 * Map harness usage/cost into pi's `Usage` shape so delegated runs appear
 * in the pi footer token/cost stats and /session totals. Returns undefined when cost
 * is unknown — `Usage.cost.total` is mandatory, so there's no honest number to put there,
 * and reporting a fake $0 would silently under-report spend in pi's session totals.
 */
export function mapHarnessUsage(u: HarnessUsage): Usage | undefined {
  if (u.totalCostUsd === null) return undefined;
  const input = u.inputTokens + u.cacheCreationInputTokens;
  const cacheRead = u.cacheReadInputTokens;
  const output = u.outputTokens;
  const totalTokens = input + output + cacheRead;
  return {
    input,
    output,
    cacheRead,
    cacheWrite: 0,
    totalTokens,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: u.totalCostUsd,
    },
  };
}

export function mapClaudeUsage(u: ClaudeUsage): Usage | undefined {
  return mapHarnessUsage(u);
}
