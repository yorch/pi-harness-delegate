---
"pi-harness-delegate": minor
---

Add `delegate.harnesses.<name>.transport` — a per-harness config knob choosing between the existing `stdout` transport (default) and `acp` (Agent Client Protocol). `opencode` now ships dual-transport (`stdout` default, `acp` opt-in) after a live-verified finding that its `build` permission mode executes writes over ACP without ever calling `session/request_permission`. `devin` stays ACP-only; `claude`/`codex`/`amp` stay `stdout`-only (amp/omp's ACP mode surface has fewer permission tiers than its stdout CLI, so it is not offered as a legal transport value). Configuring an unsupported transport now fails immediately with a clear message, before any process spawns.

Also hardens `acp-runner.ts`: `session/set_mode` is now capability-checked before being called (hard error, not a silent downgrade, when an agent can't confirm mode support), and the negotiated `protocolVersion` from `initialize` is validated against what was sent.
