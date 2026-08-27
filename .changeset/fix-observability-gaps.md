---
'pi-harness-delegate': patch
---

Fix five observability gaps:

- Tool-result checkmarks in the transcript activity log and live progress feed are now attributed to the correct row by tool-call id (Claude), instead of always landing on the last row for parallel tool-call batches. A failing tool in a batch now marks the right row.
- `numTurns`/`totalCostUsd` are now `number | null` — `null` means the harness didn't report the field, not a measured 0. Unknown metrics render as `—`/`n/a` instead of `0 turn(s)`/`$0.000` in the transcript header, `/delegate` tool result, and `/delegate history`. `mapHarnessUsage` no longer feeds a fake `$0` into pi's session cost totals when cost is unknown.
- `maxConcurrent` is now enforced across pi processes via a small file-based run registry (`~/.pi/agent/delegate/runs/`), not just in-process state.
- `/delegate status` now shows a per-harness spend rollup (e.g. `$1.234 over 12 run(s) (3 unknown)`), with unknown-cost runs counted separately rather than silently read as `$0`.
- `/delegate history`'s legacy-directory listing now filters out `-partial` transcripts, matching the partitioned-directory listing.
