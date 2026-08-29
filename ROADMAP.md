# Working / Tracking Doc — pi-harness-delegate

Working document for planned and in-flight work. Forked from pi-claude-delegate. Statuses: `done` · `in progress` · `todo` · `future`.

Current release: **0.3.0** (npm `latest`). Sections 1–7 describe the fork/rename work that shipped in this package's initial release; they were originally drafted against `pi-claude-delegate`'s version numbering, which this package never adopted (its own line is 0.1.0 → 0.3.0).

---

## 1. Harness abstraction (Phase 0–1)

**Status:** done (initial release)

Extract `Harness` interface (`NormalizedPermission`, `detect`, `buildArgs`, `parseLine`, `extractResult`), generic `runHarness`, `registry`, `config` with `delegate` + `claudeDelegate` fallback, partitioned outputs `~/.pi/agent/delegate/outputs/<harness>/`.

**Done:**
- `extensions/harnesses/types.ts`, `extensions/runner.ts`, `extensions/harnesses/registry.ts`
- `extensions/config.ts` (new key `delegate`, legacy `claudeDelegate` migration)
- `extensions/templates.ts` normalized `permission` + native escape hatch, shared < harness < user < project load order
- `extensions/index.ts` `delegate()` harness-aware, `delegate` tool + `claude_delegate` alias, `/delegate` + aliases `/claude|codex|opencode|amp|omp`, concurrency Map per harness + global, partitioned transcripts, hint/progress/usage generalized
- Shims `run-claude.ts`, `stream-parse.ts` for compat
- `templates/shared` + `templates/<harness>` (claude/codex/opencode/amp) with normalized frontmatter

## 2. Claude harness (faithful port)

**Status:** done (initial release)

`extensions/harnesses/claude.ts` — exact port of `run-claude` + `stream-parse`, args `claude -p --output-format stream-json --verbose ... --permission-mode <mapped>`, detects via `claude --version`, permissionMap readonly→plan, edit→acceptEdits, danger→bypassPermissions.

## 3. Codex harness

**Status:** done (initial release)

`extensions/harnesses/codex.ts` — `codex exec --json <prompt> --sandbox <level>`, tolerant JSONL + plain-text fallback, synthesizes result if needed, detects via `codex --version`, permissionMap read-only/workspace-write/danger-full-access.

**Known gap:** Codex CLI args drift; `--thread-id` for resume, `maxBudgetUsd` not natively supported (ignored). Needs live capture of real JSONL to refine parser.

## 4. OpenCode harness

**Status:** done (initial release)

`extensions/harnesses/opencode.ts` — `opencode run --format json <prompt>`, tolerant parser, detects via `opencode --version`, permission not yet CLI-flagged (gated upstream). Placeholder parser — refine with real transcript.

## 5. Amp harness (omp alias)

**Status:** done (initial release)

`extensions/harnesses/amp.ts` — `amp --output jsonl <prompt>`, tolerant parser, detects via `amp --version` (fallback `omp`), alias `omp:amp`. Placeholder — refine with real transcript.

## 6. Tests for harness layer

**Status:** done (initial release)

- `tests/harness.test.ts` — claude/codex/opencode/amp parsers, buildArgs permission mapping, registry aliases
- `tests/config.test.ts` — delegate vs claudeDelegate precedence, legacy migration, outputsDir partitioning
- `tests/templates-harness.test.ts` — permission normalized, legacy fallback, native escape hatch
- `tests/command-harness.test.ts` — `parseDelegateCommand` harness as first word, --harness flag, omp alias

Updated `tests/activity.test.ts`, `tests/metrics.test.ts` for harness-aware transcript/report.

## 7. Docs & package rename

**Status:** done (initial release)

- `package.json` name `pi-harness-delegate` (unscoped), description, repo `yorch/pi-harness-delegate`, keywords
- `README.md` rewritten for harness table, `/delegate` primary + aliases, migration guide, config with `harnesses` per-harness models and `maxConcurrent` object
- `AGENTS.md` rewritten for new architecture
- `CLAUDE.md` symlink kept
- Templates partitioned; `files` still ships `templates/` recursively (covers shared + harness subdirs)

## 8. Observability & metric honesty

**Status:** done (0.3.0, [#11](https://github.com/yorch/pi-harness-delegate/pull/11))

- `ToolCallIndex` (`extensions/activity.ts`) attributes a `tool_result` to its originating `tool_input` by id, fixing ✓/✗ marks landing on the wrong row for parallel tool batches.
- `numTurns`/`totalCostUsd` are `number | null` — `null` means the harness didn't report the field, rendered `—`/`$—`, never a fake `0`. `mapHarnessUsage` returns `undefined` rather than feeding pi's session totals a fake `$0`.
- `extensions/run-registry.ts` — cross-process active-run registry so the concurrency guard and `/delegate status` are accurate across pi processes.
- `aggregateSpend`/`formatSpend` rollup in `/delegate status`; unknown-cost runs counted separately, never folded in as `$0`.

## 9. Real harness schemas + CLI arg fixes

**Status:** done (0.3.0, [#13](https://github.com/yorch/pi-harness-delegate/pull/13))

Captured real JSONL from every installed CLI and wired parsers from it. **codex and opencode delegation was entirely broken** — `codex exec` rejected `--ask-for-approval`/`--thread-id`, `opencode run` rejected `--permission`/`--add-dir`, so every delegation to those harnesses failed before emitting a line. Fixtures in `tests/fixtures/*.jsonl`; each parser records the CLI version its schema was verified against.

- codex (codex-cli 0.149.1): real id `item.id`, usage on `turn.completed`, no cost reported under ChatGPT-plan auth (stays `null`).
- opencode (1.18.16): real id `part.callID`; permission tiers map onto built-in agents (`plan`/`build`/`build --auto`); per-step usage now accumulated rather than last-step-only.
- amp/omp: `omp` is **not** a renamed Sourcegraph Amp CLI but a different tool; binary resolved dynamically (`amp` then `omp`); real id `toolCallId`; fixed nested `usage.cost.total` and `agent_end` clobbering the good `turn_end` result.

## 10. Verify, fan-out, notifications

**Status:** done (0.3.0, [#13](https://github.com/yorch/pi-harness-delegate/pull/13))

- **Post-run verify** — optional `verify:` template frontmatter / `--verify=` flag, run host-side after the harness exits. Report-only: never flips `isError`. Deliberate security boundary: **not** a `delegate` tool param (would be model-settable, and the model's context includes attacker-influenceable repo/harness output), and **never runs on a `readonly` permission** (would be a permission-tier bypass) — recorded as skipped instead.
- **Multi-harness fan-out** — `harness: "all"` or a comma list; `all` resolves against `detectAll()`, skipping uninstalled. Runs sequentially through the existing `delegate()` engine (its concurrency guard rejects rather than queues, so a loop is the only way to respect `maxConcurrent` without touching it). One synthesized comparison report, no second model call.
- **Batched notifications** — successful fan-out completions debounce into one message; failures never batched.

## 11. Parallel fan-out, `maxConcurrent` default raised

**Status:** done ([#15](https://github.com/yorch/pi-harness-delegate/pull/15))

- **`acquireSlot({wait})`** (`extensions/concurrency.ts`) — the concurrency guard factored out of `delegate()` and made testable on its own. `wait: false` is the unchanged single-run fail-fast behavior; `wait: true` polls for a free slot instead of throwing. This *is* the bounded pool — no separate worker-pool abstraction needed.
- **Fan-out is now concurrent** — both `runFanoutTool` and `runFanoutCommand` launch every resolved harness's `delegate()` call at once (`waitForSlot: true`), bounded by `maxConcurrent` (including the cross-process count from the run registry). A fan-out no longer runs one harness at a time.
- **`maxConcurrent` default raised from `1` to `4`** — one slot per supported harness, now that fan-out is genuinely parallel and the cross-process registry makes the cap accurate across pi processes.
- **Deterministic report ordering** — `orderFanoutResults()` (`extensions/activity.ts`) reorders concurrent, out-of-order completions back to the resolved harness list before `buildFanoutReport()` runs, so the same fan-out produces the same report regardless of which harness finishes first.
- **One multi-run overlay for fan-out** (`extensions/progress-multi.ts`) — a compact row per harness (status, elapsed, current activity) instead of N stacked overlays or an interleaved single feed. Single-harness runs still use the original `progressWindow` unchanged. Double-ESC cancel aborts every in-flight and still-queued run via one shared `AbortController`.

## 12. Fan-out UI follow-ups

**Status:** done

Source-verified follow-up to `docs/pi-subagents-assessment.md`'s "clearly worth doing" bucket (a second
research pass that read `pi-subagents@0.58.0`'s actual TypeScript source for its live-display surfaces,
not just its docs — see the doc's §4).

- **Richer fan-out chip** — `formatFanoutChip()` (`extensions/progress-multi.ts`) now takes an explicit
  elapsed-ms and adds `⏱ <elapsed>` plus `$<total spend>` (once at least one run has reported a cost) to
  the existing per-status counts. Zero-count omission unchanged.
- **`+N earlier` overflow marker** — `progress.ts`'s feed (`truncateFeed()`) shows a dim marker line
  instead of silently dropping entries past `MAX_VISIBLE_ENTRIES`. The multi-run overlay has no analogous
  truncation point (one row per harness, never sliced), so nothing to change there.
- **Fan-out overlay lingers ~3s after the last row goes terminal** (`FANOUT_LINGER_MS`,
  `runFanoutConcurrent` in `extensions/index.ts`) instead of tearing down the instant the promise
  settles, so a user who looked away still sees the final board. Doesn't delay the returned outcomes or
  the injected report — the linger runs detached after `runFanoutConcurrent` returns. Esc/`m` during the
  linger dismiss immediately (`isFanoutComplete()` gates this in `multiProgressWindow`); an explicit
  double-Esc cancel also skips the linger.
- Source reading confirmed this repo already does two things `pi-subagents` does *worse*, not better —
  recorded in the assessment doc (§4) so they don't get "fixed" to match it later: its always-on strip
  drops a failed child the instant it goes terminal (this repo's fan-out rows freeze with the failure
  reason instead), and it has no bulk stop-all (this repo's double-Esc cancels every in-flight and queued
  run in a fan-out with one gesture).

## 13. Future

- Codex runs contribute **no tokens** to pi's session totals — `mapHarnessUsage` returns `undefined` when cost is unknown, and codex reports no cost under ChatGPT-plan auth. Revisit if pi ever accepts tokens-without-cost.
- Verify codex's resume path against a captured resume transcript (currently derived from `--help` only).
- Verify whether `--add-dir` exists on omp (absent from its help; inert today since `addDirs` defaults empty).
- Run registry is count-then-acquire, so the cap is best-effort, not a hard mutex. Only worth hardening if the cap becomes a spend control — this also bounds `acquireSlot`'s `wait: true` polling: two waiters can still both observe a just-freed slot and both proceed.
- `maxConcurrent` per-harness UI + tests for the object shape.
- `/delegate list --harness=...` and `history` harness filter polish.
- See [`docs/pi-subagents-assessment.md`](docs/pi-subagents-assessment.md) for the researched comparison against `pi-subagents` and its prioritized candidates. Its "clearly worth doing" display/inspection items shipped in §12 above. Its "questionable" bucket (per-template memory, tool-description verbosity, refine-style auto-tuning) stays parked pending observed need; its "not applicable" bucket (session fork, live steering, workflow sandbox, missions, per-child drill-in transcript viewer, steering) is blocked upstream on the harness CLIs, not on this repo.

---

## In-flight / TODO

- [ ] Live integration tests against real binaries (fixtures cover parsing; nothing exercises a real spawn end-to-end).
- [ ] Re-capture fixtures on each harness CLI upgrade — the shipped binary is the contract, not its docs. Both broken-args bugs would have been caught by one real run per harness.
