# pi-harness-delegate

## 0.6.1

### Patch Changes

- [#36](https://github.com/yorch/pi-harness-delegate/pull/36) [`ecabc60`](https://github.com/yorch/pi-harness-delegate/commit/ecabc6052f582ffa429a9c1dc2973fe9d19e0f44) Thanks [@yorch](https://github.com/yorch)! - Warn when project-local templates are skipped for an untrusted project, instead of failing silently.
  
  The 0.6.0 security fix removed `.pi/trusted` and `PI_TRUSTED` as ways to grant trust. For anyone who relied on them, project-local templates stop loading on upgrade with no visible signal — an override shares its name with the builtin it replaces, so the delegation just uses the builtin and produces plausible output. `/delegate status` reported trust state, but nobody runs it until something already looks wrong.
  
  A delegation in an untrusted project that actually has `.pi/delegate/templates/` now prints a one-time notice saying they were skipped and how to grant trust, and flags a leftover `.pi/trusted` file as inert and deletable. Gated on the content existing, so users who never had project templates see nothing.

## 0.6.0

### Minor Changes

- [#33](https://github.com/yorch/pi-harness-delegate/pull/33) [`6dde641`](https://github.com/yorch/pi-harness-delegate/commit/6dde641dfce4e9c517c1c403e8b8f105562322da) Thanks [@yorch](https://github.com/yorch)! - Add `/delegate config` — prints exactly what was read from `~/.pi/agent/settings.json` (or why nothing was: no file, no `delegate` key, or a parse error), plus the effective config with defaults filled in, as a paste-ready JSON block.
  
  Add `/delegate config init` — writes that effective config into `settings.json` under the `delegate` key, the only thing this extension ever writes there and only on this explicit command. It's a read-modify-write: the whole file is read, only the `delegate` key is replaced, every other key (pi's own settings, a leftover `claudeDelegate`) is preserved verbatim, and the write is atomic (temp file + rename). It refuses outright rather than writing over a file that fails to parse.
  
  `/delegate status` now leads with the same provenance instead of jumping straight to resolved values. This surfaces a real gap: staying on the legacy `claudeDelegate` key (rather than renaming it to `delegate`, or running `/delegate config init`) silently blocks two settings from ever being reachable — `defaultHarness` (stays pinned to `claude`) and a top-level default `model` (only `claudeDelegate.model` migrates, to `harnesses.claude.model`) — both `status` and `config` now call this out.
  
  Internally, `loadConfig()` no longer swallows a malformed or unparseable `settings.json` into indistinguishable defaults — `loadConfigWithSource()` reports provenance (file existence, which key won, parse errors) alongside the resolved config, without a second file read and without ever throwing.

- [#27](https://github.com/yorch/pi-harness-delegate/pull/27) [`f2306ea`](https://github.com/yorch/pi-harness-delegate/commit/f2306ea5575497dca3ecca09f623733ecd887477) Thanks [@yorch](https://github.com/yorch)! - Add `delegate.harnesses.<name>.transport` — a per-harness config knob choosing between the existing `stdout` transport (default) and `acp` (Agent Client Protocol). `opencode` now ships dual-transport (`stdout` default, `acp` opt-in) after a live-verified finding that its `build` permission mode executes writes over ACP without ever calling `session/request_permission`. `devin` stays ACP-only; `claude`/`codex`/`amp` stay `stdout`-only (amp/omp's ACP mode surface has fewer permission tiers than its stdout CLI, so it is not offered as a legal transport value). Configuring an unsupported transport now fails immediately with a clear message, before any process spawns.
  
  Also hardens `acp-runner.ts`: `session/set_mode` is now capability-checked before being called (hard error, not a silent downgrade, when an agent can't confirm mode support), and the negotiated `protocolVersion` from `initialize` is validated against what was sent.

- [#34](https://github.com/yorch/pi-harness-delegate/pull/34) [`e5f42b7`](https://github.com/yorch/pi-harness-delegate/commit/e5f42b77c6435b422a75f9bca1ee5960d3196b07) Thanks [@yorch](https://github.com/yorch)! - Security fix: project-local delegate templates could self-declare trust from inside the very repo they came from.
  
  `loadTemplates()` decided whether to load `.pi/delegate/templates/` by reading `.pi/trusted` from the project itself (or an env var, `PI_TRUSTED=1` / `PI_DELEGATE_TRUSTED=1`, that leaked trust to every directory for the rest of a shell session). A cloned hostile repo could commit `.pi/trusted` containing `1` and its project-local templates would load with no prompt and no prior human trust decision — including a template overriding a builtin by name. In particular, an override of the builtin `review` template (permission: readonly) could declare `permission: edit` and attach a `verify:` command, which runs host-side via `sh -c` after the harness exits. Net effect: `git clone <hostile repo> && cd it`, then `/delegate review` — which a user reasonably expects to be read-only — could execute an arbitrary host command.
  
  Fixed: `loadTemplates()` now takes an explicit `trusted` boolean (default `false`, fail-closed) instead of reading anything from the project or the environment. In the extension, that boolean comes from pi's own `ctx.isProjectTrusted()` — a trust decision backed by pi's trust store outside the project, set only by pi's own trust prompt or `defaultProjectTrust`. `.pi/trusted` and the `PI_TRUSTED`/`PI_DELEGATE_TRUSTED` environment variables no longer grant trust at all — remove them if you were relying on them, and trust the project through pi's own trust prompt (or `defaultProjectTrust`) instead. `/delegate status` now reports whether the current project is trusted and, if not, that project-local templates were skipped.

### Patch Changes

- [#29](https://github.com/yorch/pi-harness-delegate/pull/29) [`311ca71`](https://github.com/yorch/pi-harness-delegate/commit/311ca7189687f9624e737000d3da417fa4ddcc6c) Thanks [@yorch](https://github.com/yorch)! - Four polish fixes:
  
  - `mapHarnessUsage`/`mapClaudeUsage` (`extensions/usage.ts`) now report real token counts with `cost.total: 0` when a harness (Codex, Devin) doesn't report a dollar cost, instead of returning `undefined` and dropping those harnesses' tokens out of pi's session totals entirely. This is a narrow, deliberate exception scoped to pi's own `Usage` mapping — transcripts, `formatMetrics`, and `/delegate status` still render unmeasured cost as `—`/`n/a`, never `$0`.
  - `run-registry.ts` gets `acquireRunWithinLimits()`, closing the count-then-act race in the concurrency guard: it writes its own entry, then re-reads the registry to confirm the write didn't push the global or per-harness limit over the top, undoing it immediately if so. Over-admission (the cap standing exceeded for a run's whole lifetime) is now impossible by construction, not just unlikely.
  - `/delegate status` now shows each harness's active-run count next to the cap that actually applies to it (e.g. `1/2`), so a `maxConcurrent: {global, perHarness}` override is visible per-row instead of only as raw JSON in the header.
  - `/delegate list` and `/delegate history` now share one harness-filter resolver, so they agree on alias (`omp`→`amp`) and case handling and both report an unrecognized harness name (with the valid list) instead of one silently showing an unfiltered list and the other silently showing an empty one. `/delegate history`'s header now names the active filter when one is applied.

- [#30](https://github.com/yorch/pi-harness-delegate/pull/30) [`b6a7af9`](https://github.com/yorch/pi-harness-delegate/commit/b6a7af978fcbf4142d791125ecdb1822199f233a) Thanks [@yorch](https://github.com/yorch)! - Live-verified codex's `exec resume` path end-to-end (a fresh process resuming a session genuinely recalls prior context, not just an echoed session id) and fixed two bugs the verification surfaced:
  
  - `codex.ts`: `buildArgs` no longer appends `--add-dir` when resuming — `codex exec resume` has no such flag and rejects it outright (`unexpected argument '--add-dir' found`).
  - `amp.ts`: a `turn_end`/`agent_end` whose failure only shows up as `message.stopReason === "error"` + `message.errorMessage` (observed live on a real 429 quota rejection, where `message.content` is an empty array) is now correctly reported as `isError: true` with the error message as the result text, instead of a silent, empty "successful" run.
  
  Also confirmed `omp`'s `--add-dir` is real and accepted (contrary to earlier research) — no change needed there — and added an opt-in `tests/live.test.ts` suite (`PI_DELEGATE_LIVE=1`) that spawns each detected harness for real and checks the basics a fixture can't: the process runs, a result comes back, `sessionId` is populated, and known-reported metrics are present. Never runs in CI or `bun run verify`.

## 0.5.0

### Minor Changes

- [#21](https://github.com/yorch/pi-harness-delegate/pull/21) [`11bd713`](https://github.com/yorch/pi-harness-delegate/commit/11bd713592c2ccf8c5b55a3eb2bf3c41c7601f3a) Thanks [@yorch](https://github.com/yorch)! - Add Devin as a fifth harness, over a new general Agent Client Protocol (ACP) transport.
  
  - `extensions/acp-runner.ts` — a sibling to `runner.ts` for harnesses whose `transport` is `'acp'` (bidirectional JSON-RPC over stdio, https://agentclientprotocol.com), exposing the same `RunHarnessOptions`/`HarnessResult` shape so `delegate()` and everything downstream (transcripts, `ToolCallIndex`, progress overlays, fan-out, spend rollup) is unchanged. Devin is its first consumer, not a special case baked into it.
  - `extensions/harnesses/devin.ts` — runs `devin acp`, maps `readonly→plan`, `edit→accept-edits`, `danger→bypass`, real `toolCallId` tool-call correlation, a genuine context-window %, and working resume via `session/load`. Reports no `$` cost (`null`) and no turn count — honest, not invented.
  - `templates/devin/*.md` mirror the other harnesses' templates.
  - The four existing harnesses (claude, codex, opencode, amp) are untouched — `transport` is optional and defaults to their existing behavior.
  - `harness: "all"` / a comma-list fan-out picks up Devin automatically once `devin` is installed.

### Patch Changes

- [#24](https://github.com/yorch/pi-harness-delegate/pull/24) [`ac87037`](https://github.com/yorch/pi-harness-delegate/commit/ac87037a76d91b6d8635727db4bd5e35d5d1fbf4) Thanks [@yorch](https://github.com/yorch)! - Fix four issues found in code review of the Devin ACP harness (`extensions/acp-runner.ts`, `extensions/harnesses/devin.ts`):
  
  - **Process leak**: a rejected handshake step (bad `session/set_mode` modeId, a JSON-RPC error, a handshake timeout) left the spawned `devin acp` process running indefinitely — every other exit path already killed it, only the handshake's `.catch` didn't. Confirmed live, both ways.
  - **Inflated context %**: Devin's `inputTokens` already includes `cachedReadTokens` as a subset, but `StreamedUsage.inputTokens` is supposed to exclude cache reads (Claude's convention) — the mismatch roughly doubled the reported context-window percentage. Fixed and covered by a fixture-driven test asserting the real percentage.
  - **Resume replayed the whole prior conversation**: `session/load` replays every prior turn as notifications before the new prompt's; nothing discarded them, so a resumed run's result had the entire previous session prepended. Fixed by gating streamed text/activity forwarding until the new `session/prompt` is actually sent. Verified live: a resumed run now returns only the new turn's answer, while still correctly recalling prior context.
  - **`model` echoed as used but silently dropped**: a requested model was written into the transcript as what ran, but was never passed to `devin acp`. `--model` is real (`devin acp --help`) and genuinely changes what runs — now wired, with the reported `model` read back from Devin's own `_cognition.ai/agent_stopped` event rather than echoed from the request, so it reflects what actually ran.

- [#23](https://github.com/yorch/pi-harness-delegate/pull/23) [`c731a90`](https://github.com/yorch/pi-harness-delegate/commit/c731a90a1690f689e14b091b4f3b266b6e19029e) Thanks [@yorch](https://github.com/yorch)! - Wire the `nativePermission` escape hatch through to stdout harnesses, and gate every harness's danger mode behind `allowDangerous`.
  
  - `permissionMode`/`sandbox` template frontmatter was parsed and documented but never passed to `runHarness()`, so the native escape hatch has silently never worked for claude/codex/opencode/amp.
  - Passing it revealed that the danger gate only recognised three hardcoded spellings. A template declaring `yolo` (amp) or `bypass` (devin) was filed as an unknown native with a normalized tier of `edit`, skipping the `allowDangerous` gate while running the harness unsandboxed. The gate now asks each harness for its own danger tokens.
  - An explicit `allowDangerous` escalation now wins over a template's native mode, which would otherwise silently downgrade the run.

## 0.4.1

### Patch Changes

- [#18](https://github.com/yorch/pi-harness-delegate/pull/18) [`0b23d22`](https://github.com/yorch/pi-harness-delegate/commit/0b23d22bd87b7e30ebd089f1088d6138ba13f751) Thanks [@yorch](https://github.com/yorch)! - Fan-out overlay follow-ups from a source-verified `pi-subagents` UI assessment (`docs/pi-subagents-assessment.md` §4):
  
  - The fan-out status chip (`formatFanoutChip`) now adds elapsed time and aggregate spend so far (once at least one run has reported a cost) alongside the existing per-status counts, e.g. `1✓ 1✗ 1▶ 1… · ⏱ 0:42 · $0.175`.
  - The single-run overlay's activity feed shows a dim `+N earlier` marker when older entries scroll past the visible window instead of dropping them with no hint.
  - The fan-out overlay now lingers ~3s on the finished board after the last run goes terminal instead of closing instantly, so a user who looked away still sees the final state — Esc/`m` dismiss it immediately, and the linger never delays the returned result or the injected report.

## 0.4.0

### Minor Changes

- [#15](https://github.com/yorch/pi-harness-delegate/pull/15) [`9abb7a1`](https://github.com/yorch/pi-harness-delegate/commit/9abb7a18d44ad091321f23b2fd90fe670858578b) Thanks [@yorch](https://github.com/yorch)! - Multi-harness fan-out (`/delegate all`, `harness: "claude,codex"`) now runs concurrently instead of one harness at a time, and `maxConcurrent` defaults to `4` instead of `1`.
  
  - **Concurrency guard refactor**: the `delegate()` concurrency check is factored into `acquireSlot()` (`extensions/concurrency.ts`), a single choke point that either fails fast at capacity (`wait: false` — unchanged behavior for a single-harness `/delegate` run) or queues for a free slot (`wait: true` — what fan-out uses). This *is* the bounded pool: fan-out launches every resolved harness's `delegate()` call at once and lets `acquireSlot` serialize the ones that don't fit under `maxConcurrent`, so a fan-out never exceeds the configured cap.
  - **`maxConcurrent` default raised from `1` to `4`** — one slot per supported harness (claude/codex/opencode/amp), now that fan-out is genuinely parallel and the cap is already enforced across pi processes via the run registry. This means fan-out spend can now be genuinely simultaneous: with the default cap, a 4-harness fan-out can bill all four harnesses at once. Set `"maxConcurrent": 1` to restore fully sequential behavior.
  - **Deterministic report ordering**: concurrent runs finish out of order, so results are reordered back to the resolved harness list (`orderFanoutResults()`) before the comparison report is assembled — the same fan-out always produces the same report regardless of completion order.
  - **New multi-run progress overlay** (`extensions/progress-multi.ts`) for `/delegate all …`: one overlay with a compact row per harness (status, elapsed, current activity) instead of N stacked overlays or an interleaved single feed. Double-ESC cancel aborts every in-flight and still-queued run. Single-harness runs are unchanged — same overlay, same fail-fast-at-capacity behavior as before.

### Patch Changes

- [#17](https://github.com/yorch/pi-harness-delegate/pull/17) [`803689d`](https://github.com/yorch/pi-harness-delegate/commit/803689d78972c5a43c273de7d22a83b8a8531e5b) Thanks [@yorch](https://github.com/yorch)! - Fan-out overlay polish: a failed harness row now keeps its failure reason (or last activity) instead of blanking at the moment that context matters most, and the status-bar chip reports every status (`1✓ 1✗ 1▶ 1…`) rather than counting only running runs — which rendered `0/4 running` when runs had actually failed or were queued behind the concurrency cap.

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
