# pi-harness-delegate

## 0.3.0

### Minor Changes

- [#13](https://github.com/yorch/pi-harness-delegate/pull/13) [`2c15022`](https://github.com/yorch/pi-harness-delegate/commit/2c150222ec1b0fe4d619289ccaefdd651fcd77f8) Thanks [@yorch](https://github.com/yorch)! - Fix codex/opencode delegation (entirely broken) and add post-run verify, multi-harness fan-out, and batched notifications:
  
  - **codex and opencode delegations were completely broken** on current CLI versions — `codex exec` rejected `--ask-for-approval`/`--thread-id` and `opencode run` rejected `--permission`/`--add-dir` outright, so every delegation to those harnesses failed before emitting a single line of output. Both harnesses' `buildArgs` are fixed and schema-verified against real captured JSONL (codex-cli 0.149.1, opencode 1.18.16). `amp`'s binary resolution (`amp`/`omp`) and final-result reading were also fixed; tool-call ids are now wired for all four harnesses so parallel tool-result attribution works everywhere, not just Claude.
  - **Post-run verify**: templates (or a human-typed `/delegate --verify=` override) can name a host-run shell command (e.g. `bun test`) that runs after the harness exits to check its work. Report-only — appended as its own section in the transcript and injected report, surfaced in `details.verify`, and never flips `isError`. Deliberate security boundary: `verify` is **not** a `delegate` tool parameter (a model-settable command would be a prompt-injection → arbitrary-host-command path), and it never actually runs on a `readonly` template (recorded as skipped instead, to avoid a permission-tier bypass).
  - **Multi-harness fan-out**: `harness: "all"` or a comma list (e.g. `"claude,codex"`) — on the `delegate` tool and `/delegate` command — runs the same task on every *detected* harness sequentially through the existing engine and returns one mechanically-synthesized comparison report with a total spend rollup. Uninstalled/unknown harnesses are skipped and reported rather than failing the run. A single-harness call is unaffected.
  - **Batched notifications**: `/delegate all …` batches successful per-harness completions into one notification instead of spamming one per harness; failures are never delayed or batched.

### Patch Changes

- [#11](https://github.com/yorch/pi-harness-delegate/pull/11) [`1c96a4c`](https://github.com/yorch/pi-harness-delegate/commit/1c96a4c6baf10a76ea7fde33b6e8f3708c7a8fb9) Thanks [@yorch](https://github.com/yorch)! - Fix five observability gaps:
  
  - Tool-result checkmarks in the transcript activity log and live progress feed are now attributed to the correct row by tool-call id (Claude), instead of always landing on the last row for parallel tool-call batches. A failing tool in a batch now marks the right row.
  - `numTurns`/`totalCostUsd` are now `number | null` — `null` means the harness didn't report the field, not a measured 0. Unknown metrics render as `—`/`n/a` instead of `0 turn(s)`/`$0.000` in the transcript header, `/delegate` tool result, and `/delegate history`. `mapHarnessUsage` no longer feeds a fake `$0` into pi's session cost totals when cost is unknown.
  - `maxConcurrent` is now enforced across pi processes via a small file-based run registry (`~/.pi/agent/delegate/runs/`), not just in-process state.
  - `/delegate status` now shows a per-harness spend rollup (e.g. `$1.234 over 12 run(s) (3 unknown)`), with unknown-cost runs counted separately rather than silently read as `$0`.
  - `/delegate history`'s legacy-directory listing now filters out `-partial` transcripts, matching the partitioned-directory listing.

## 0.2.2

### Patch Changes

- [#7](https://github.com/yorch/pi-harness-delegate/pull/7) [`b61c55d`](https://github.com/yorch/pi-harness-delegate/commit/b61c55d7e7cabd46360e066e17c662c08fb100bd) Thanks [@yorch](https://github.com/yorch)! - fix: tighten harness parsers with live JSONL fixtures (opencode step_finish, amp message_update, codex error)

## 0.2.1

### Patch Changes

- [#6](https://github.com/yorch/pi-harness-delegate/pull/6) [`9fe2808`](https://github.com/yorch/pi-harness-delegate/commit/9fe2808e0d13beb3e6d318f0d16311070cb1fc26) Thanks [@yorch](https://github.com/yorch)! - chore: support Node 22,24,26
  
  Support Node 22, 24 and 26 via engines "22 || 24 || 26" and @types/node 22.15.32. CI now matrix 22/24/26, release stays on 26.

## 0.2.0

### Minor Changes

- [`ae49b9c`](https://github.com/yorch/pi-harness-delegate/commit/ae49b9cba563cbb607e1faee435338bd1e5be976) Thanks [@yorch](https://github.com/yorch)! - feat: Health & UX — /delegate status health check, per-harness detectAll UI, history/list filters by harness

## 0.1.1

### Patch Changes

- [#1](https://github.com/yorch/pi-harness-delegate/pull/1) [`9a4169b`](https://github.com/yorch/pi-harness-delegate/commit/9a4169ba165cdbcc25d06c6e3630aa3c2aeb54ea) Thanks [@yorch](https://github.com/yorch)! - chore: migrate to Bun + Node 26 + Biome + changesets release
  
  Update dependencies to latest: @earendil-works/* 0.84.3, @biomejs/biome 2.5.10, @changesets/cli 3.0.1, @changesets/changelog-github 1.0.0, @types/node 26.3.0, typescript 7.0.2, typebox 1.3.18. Switch formatter to 2-space indentation.
