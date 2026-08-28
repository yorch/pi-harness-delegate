---
"pi-harness-delegate": minor
---

Multi-harness fan-out (`/delegate all`, `harness: "claude,codex"`) now runs concurrently instead of one harness at a time, and `maxConcurrent` defaults to `4` instead of `1`.

- **Concurrency guard refactor**: the `delegate()` concurrency check is factored into `acquireSlot()` (`extensions/concurrency.ts`), a single choke point that either fails fast at capacity (`wait: false` — unchanged behavior for a single-harness `/delegate` run) or queues for a free slot (`wait: true` — what fan-out uses). This *is* the bounded pool: fan-out launches every resolved harness's `delegate()` call at once and lets `acquireSlot` serialize the ones that don't fit under `maxConcurrent`, so a fan-out never exceeds the configured cap.
- **`maxConcurrent` default raised from `1` to `4`** — one slot per supported harness (claude/codex/opencode/amp), now that fan-out is genuinely parallel and the cap is already enforced across pi processes via the run registry. This means fan-out spend can now be genuinely simultaneous: with the default cap, a 4-harness fan-out can bill all four harnesses at once. Set `"maxConcurrent": 1` to restore fully sequential behavior.
- **Deterministic report ordering**: concurrent runs finish out of order, so results are reordered back to the resolved harness list (`orderFanoutResults()`) before the comparison report is assembled — the same fan-out always produces the same report regardless of completion order.
- **New multi-run progress overlay** (`extensions/progress-multi.ts`) for `/delegate all …`: one overlay with a compact row per harness (status, elapsed, current activity) instead of N stacked overlays or an interleaved single feed. Double-ESC cancel aborts every in-flight and still-queued run. Single-harness runs are unchanged — same overlay, same fail-fast-at-capacity behavior as before.
