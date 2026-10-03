---
"pi-harness-delegate": minor
---

`/delegate --allow-dangerous` (and the `/claude`, `/codex`, … aliases): a human can now run a `permission: danger` template — or escalate any other template to `danger` — from the command path, which previously always failed with "requires danger permission". The flag (also `--allow-dangerous=true`; any other value is off) applies to that one invocation only, is never read from config, and always asks for interactive confirmation naming the harness(es), mode, and that the run has full, unrestricted permissions — a fan-out gets a single prompt covering every harness. A decline runs nothing; a non-interactive session refuses it outright. The `delegate` tool's `allowDangerous` parameter and its own confirmation are unchanged. The danger-refusal error now names both opt-ins.
