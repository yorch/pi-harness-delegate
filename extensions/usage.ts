import type { Usage } from '@earendil-works/pi-ai';

export interface HarnessUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  totalCostUsd: number;
}

export type ClaudeUsage = HarnessUsage;

/**
 * Map harness usage/cost into pi's `Usage` shape so delegated runs appear
 * in the pi footer token/cost stats and /session totals.
 */
export function mapHarnessUsage(u: HarnessUsage): Usage {
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

export function mapClaudeUsage(u: ClaudeUsage): Usage {
  return mapHarnessUsage(u);
}
