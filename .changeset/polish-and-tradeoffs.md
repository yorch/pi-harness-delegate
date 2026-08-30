---
"pi-harness-delegate": patch
---

Four polish fixes:

- `mapHarnessUsage`/`mapClaudeUsage` (`extensions/usage.ts`) now report real token counts with `cost.total: 0` when a harness (Codex, Devin) doesn't report a dollar cost, instead of returning `undefined` and dropping those harnesses' tokens out of pi's session totals entirely. This is a narrow, deliberate exception scoped to pi's own `Usage` mapping — transcripts, `formatMetrics`, and `/delegate status` still render unmeasured cost as `—`/`n/a`, never `$0`.
- `run-registry.ts` gets `acquireRunWithinLimits()`, closing the count-then-act race in the concurrency guard: it writes its own entry, then re-reads the registry to confirm the write didn't push the global or per-harness limit over the top, undoing it immediately if so. Over-admission (the cap standing exceeded for a run's whole lifetime) is now impossible by construction, not just unlikely.
- `/delegate status` now shows each harness's active-run count next to the cap that actually applies to it (e.g. `1/2`), so a `maxConcurrent: {global, perHarness}` override is visible per-row instead of only as raw JSON in the header.
- `/delegate list` and `/delegate history` now share one harness-filter resolver, so they agree on alias (`omp`→`amp`) and case handling and both report an unrecognized harness name (with the valid list) instead of one silently showing an unfiltered list and the other silently showing an empty one. `/delegate history`'s header now names the active filter when one is applied.
