---
"pi-harness-delegate": patch
---

Native permissions in template frontmatter now match a harness's allowlist case-insensitively (`permission: Plan` is claude's `plan`, no longer gated as an unlisted/danger mode) and always reach the harness in their canonical spelling; case variants of danger modes (`Yolo`, `BYPASSPERMISSIONS`) stay gated. The `delegate` tool's `harness` param is now normalized exactly like `/delegate`'s, so `harness: "claude,"` is a single run (fail-fast at capacity, single-run result) rather than a one-harness fan-out, and `omp` resolves to `amp`.
