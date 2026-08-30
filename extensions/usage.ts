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
 * Map harness usage/cost into pi's `Usage` shape so delegated runs appear in the pi footer
 * token/cost stats and /session totals.
 *
 * Deliberate, bounded exception to the "never fake a number" rule: `Usage.cost.total` is
 * mandatory (unlike `StreamedResult.totalCostUsd`, which stays `number | null` everywhere else
 * in this codebase — the transcript still renders `cost: —` and `/delegate status`'s
 * `aggregateSpend` still tracks unknown-cost runs separately). Codex and Devin genuinely report
 * no dollar cost, so treating "cost unknown" as "usage unknown" here would drop 2 of 5 harnesses'
 * tokens out of pi's session totals entirely. Reporting `$0` under-reports spend by a knowable
 * amount (bounded: it's exactly the missing harnesses' true cost, never a guess); reporting no
 * usage at all loses real token counts outright. Between those two errors, under-reporting spend
 * is the lesser one — but this exception applies ONLY to this pi-`Usage` mapping. Do not
 * generalize a `null -> 0` fallback to any other cost/spend path in the codebase.
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
      total: u.totalCostUsd ?? 0,
    },
  };
}

export function mapClaudeUsage(u: ClaudeUsage): Usage {
  return mapHarnessUsage(u);
}
