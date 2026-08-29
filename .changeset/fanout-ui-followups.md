---
"pi-harness-delegate": patch
---

Fan-out overlay follow-ups from a source-verified `pi-subagents` UI assessment (`docs/pi-subagents-assessment.md` §4):

- The fan-out status chip (`formatFanoutChip`) now adds elapsed time and aggregate spend so far (once at least one run has reported a cost) alongside the existing per-status counts, e.g. `1✓ 1✗ 1▶ 1… · ⏱ 0:42 · $0.175`.
- The single-run overlay's activity feed shows a dim `+N earlier` marker when older entries scroll past the visible window instead of dropping them with no hint.
- The fan-out overlay now lingers ~3s on the finished board after the last run goes terminal instead of closing instantly, so a user who looked away still sees the final state — Esc/`m` dismiss it immediately, and the linger never delays the returned result or the injected report.
