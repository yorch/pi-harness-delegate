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

**Status:** done ([#18](https://github.com/yorch/pi-harness-delegate/pull/18))

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

## 13. Devin as a fifth harness, general ACP transport

**Status:** done ([supersedes #20](docs/devin-acp-harness-design.md))

Scoped in [`docs/devin-acp-harness-design.md`](docs/devin-acp-harness-design.md), then built and
verified with real `devin 3000.6.7` runs (see the doc's §8 errata for what implementation corrected).

- **`extensions/acp-runner.ts`** — a sibling to `runner.ts` for harnesses whose `transport` is `'acp'`
  (Agent Client Protocol, https://agentclientprotocol.com — JSON-RPC 2.0 over stdio, bidirectional and
  stateful, unlike the stdout harnesses' one-way JSONL stream). Exposes the exact same
  `RunHarnessOptions`/`HarnessResult` shape as `runHarness`, so `delegate()` picks the runner from
  `harness.transport` and everything downstream (transcripts, `ToolCallIndex`, overlays, fan-out, spend)
  is unchanged. Drives `initialize` → `session/new`/`session/load` → `session/set_mode` →
  `session/prompt`, holds `stdin` open for the run's lifetime, mirrors `runner.ts`'s caps/timeout/abort
  handling, and answers server-initiated requests (permission prompts) defensively rather than
  auto-approving. Deliberately general — Devin is its first consumer, not a special case baked into it.
- **`extensions/harnesses/devin.ts`** — `transport: 'acp'`, maps `readonly→plan`, `edit→accept-edits`,
  `danger→bypass` (exact structural match to Claude's tiers), translates ACP `session/update` events
  into `ParseOutcome` with real `toolCallId` correlation. `totalCostUsd`/`numTurns` stay `null` — Devin
  reports neither over ACP. Schema-verified against `devin 3000.6.7 (260a97c8)`.
- **The four existing harnesses are untouched** — `transport` is optional on `Harness`, defaulting to
  the pre-existing `'stdout'` behavior; their 139 pre-existing tests pass unmodified.
- **Real-run findings that corrected the design note:** workspace trust does not gate `devin acp` (only
  `devin -p`/interactive `devin` — confirmed against directories `devin` had never seen), so no trust
  hint or bypass ships; resume via `session/load` works and is wired (`opts.resumeSessionId`); an ACP
  session doesn't exit on its own once a prompt turn completes, so the runner finishes and kills the
  process itself rather than waiting on it.
- `templates/devin/*.md` mirror `templates/claude/*.md` without `model:` frontmatter — no verified way
  to set Devin's model over this version's ACP surface.
- `all`/a comma-list fan-out picks up Devin automatically once `devin` is installed (`detectAll()`).

## 14. ACP support assessment (research, not shipped)

**Status:** done (research) — [`docs/acp-harness-assessment.md`](docs/acp-harness-assessment.md)

Real-run assessment of ACP support across all five harnesses, same standard as the Devin design note.
`claude`/`codex` confirmed to have no ACP surface (full `--help` sweep, not re-trusting an earlier
probe). `opencode acp` and `omp acp` are both real and were driven end-to-end with genuine captures
(`tests/fixtures/opencode-acp.jsonl`, `tests/fixtures/amp-acp.jsonl`) — `acp-runner.ts` already
handles both dialects without modification, since it sources the ACP mode id from the `Harness`'s own
`permissionMap`, never from `session/new`'s response. Reframed mid-assessment (per the user) from
"switch or don't switch" to **a configurable transport, selectable per harness**, stdout default and
fallback, ACP opt-in only where the permission-tier gate is clean: opencode is close (fidelity gains,
no tier-granularity loss versus what ships today, one closeable open question on `build`-mode write
behavior); amp/omp should not even have `transport: 'acp'` as a legal config value yet — its ACP mode
surface is structurally coarser than its stdout `--approval-mode` (2 tiers vs. 3), on top of live
tool-use/cost capture being blocked by account quota/credit exhaustion across three attempts in this
environment, not by the protocol. Also surfaced (not fixed here): a real `acp-runner.ts` bug sending
`session/set_mode` unconditionally despite it being spec-optional — didn't affect this assessment's
findings, but argues for a capability-aware handshake in any follow-up implementation.

---

## 15. ACP protocol/ecosystem research

**Status:** done (research, [`docs/acp-protocol-research.md`](docs/acp-protocol-research.md))

Read against schema `v1` release `1.21.0` (2026-08-20) and `@agentclientprotocol/sdk@1.4.0` — not the
old, now-superseded `@zed-industries/agent-client-protocol` npm name, which is ~11 months / dozens of
schema releases stale. Key findings:

- Wire `protocolVersion: 1` (as pinned in `acp-runner.ts`) is correct and durable — the schema has grown
  purely additively (1.0.0 → 1.21.0) without a wire bump; a v2 exists only as an unreleased, actively
  drafted breaking revision, and its own maintainers say v1 support isn't going away.
- **`acp-runner.ts` sends `session/set_mode` unconditionally**, but the method (and `session/new`'s
  `modes` field) is optional per spec. Invisible today because Devin implements modes; would fail the
  whole handshake against a mode-less ACP agent. Fixed in §16 below (capability-aware, hard error on no
  capability signal, not a silent downgrade).
- `initialize`'s negotiated `protocolVersion` is never checked against what we sent — harmless while only
  `1` exists, cheap insurance to add before a v2-speaking agent shows up. Fixed in §16 below.
- The `acp-runner.ts` (transport, tolerates unknown `_meta`/vendor methods) vs. `devin.ts` (interprets
  `cognition.ai/*`) split matches the spec's own extensibility model exactly — no seam change needed.
- Governance moved to a joint Zed/JetBrains model with a real registry (~40 agents, dozens of clients);
  ACP reads as an actively-invested cross-vendor standard, not a single-vendor feature.

---

## 16. Configurable per-harness transport (shipped)

**Status:** done — `HarnessConfig.transport`, `extensions/config.ts`'s `resolveTransport`, `Harness.supportsTransports`/`buildAcpArgs`/`parseAcpLine`/`acpPermissionMap`, `acp-runner.ts`'s `acpView`.

Turned §14's recommendation (configurable transport, not a switch) and §15's two flagged `acp-runner.ts`
bugs into shipped code, gated on a live run this PR itself ran:

- **opencode ships dual-transport** (`supportsTransports: ['stdout', 'acp']`, defaults to `stdout`) —
  closing §14's one open question with a real write prompt under `build` mode: it never calls
  `session/request_permission` (`tests/fixtures/opencode-acp-build-write.jsonl`), so `edit`/`danger`
  genuinely execute over ACP rather than silently no-op behind this project's auto-decline.
- **amp/omp stays `['stdout']` only** — its ACP mode surface has 2 tiers against the stdout CLI's
  genuine 3; not a legal `transport` value, by design, until a future omp ACP version exposes a third
  tier. **claude/codex stay `['stdout']`** — no ACP surface exists.
- `permissionMap` split into `permissionMap` (stdout CLI-flag fragments) and `acpPermissionMap` (ACP
  `session/set_mode` mode ids) — kept as two fields even where a harness's values coincide (opencode),
  since they're different vocabularies that would silently drift apart the moment a harness like omp
  needs both.
- `acp-runner.ts`'s `session/set_mode` is now capability-checked (via `session/new`/`session/load`'s
  `modes` field or a `configOptions` entry with `category: "mode"`) before being called, and a mode that
  can't be confirmed is a hard error, not a downgrade — every real agent captured so far advertises one
  of the two signals, so this never fires today, but it's the general, correct shape §15 called for.
  `protocolVersion` is checked against what was sent, same section.
- Config validated before `acquireSlot()`/spawn — misconfiguring `transport: 'acp'` for `claude` fails
  immediately with a clear message.

---

## 17. Extension config conventions research

**Status:** done (research) — [`docs/pi-extension-config-survey.md`](docs/pi-extension-config-survey.md)

Surveyed how popular pi extensions handle config (own file vs. a key in pi's `settings.json`), so the
concurrent `feat/config-ux` work follows the ecosystem instead of inventing something. **pi itself has no
official extension-config mechanism** — the host's `SettingsManager` is exported but is pi's own closed
`Settings` type, not reachable from `ExtensionContext`/`ExtensionAPI`; the only official guidance
(`docs/extensions.md`) is "read your own file under `.pi/<name>.json`." No dominant convention on
*placement* either (own file: `pi-mcp-adapter`, `pi-lens`, `@juicesharp/rpiv-ask-user-question`; a
`settings.json` key: `@yorch/pi-statusbar`; both, for different subsystems: `pi-subagents`) — this
project's placement (a `delegate` key in `settings.json`) is fine as-is given its config's size. But every
extension surveyed with a real config surface **logs/warns on a malformed file** and **never blindly
overwrites `settings.json` when it writes** — this project's `loadConfig()` is the only one that fails
completely silently (bare `catch {}`), and the only one with no writer/command at all (hand-edit-only).
Also flagged: the `claudeDelegate` legacy-migration branch (`extensions/config.ts:77-116`) returns early,
so a user still on the legacy key silently never sees any newer `delegate`-only field.

**Separate, more urgent finding surfaced by the same research (doc §5): this project's project-template
trust gate (`isTrusted()`, `extensions/templates.ts:143`) diverges from pi's real trust model in the
dangerous direction, confirmed, on two independent paths — not just non-standard, exploitable.** pi's
`ctx.isProjectTrusted()` (confirmed present on `ExtensionContext` at this repo's own resolved peer-dep
version, `@earendil-works/pi-coding-agent@0.84.3`) is backed by `~/.pi/agent/trust.json` — a decision
store *outside* the project directory, keyed by canonical path, writable only via an interactive prompt,
the user's own `defaultProjectTrust` setting, or a user/global-scope `project_trust` extension handler,
and with **no environment-variable override anywhere in pi's compiled trust code**. This project's
`isTrusted()` diverges on both of its own paths: the `<cwd>/.pi/trusted` file is read from *inside* the
project being evaluated, so a cloned repo can ship it pre-committed with `1` and self-declare trust with
no prompt at all — something pi's model cannot do by construction; and `PI_TRUSTED=1`/
`PI_DELEGATE_TRUSTED=1`, once set in a shell for one reviewed repo, blanket-trusts every directory
`cd`'d into afterward for the life of that session, a mechanism with zero analog in pi's own model. Either
path lets a hostile repo's `permission: danger` / `verify:`-carrying template load in a case pi itself
would have gated. Not changed here — a security gate needs its own change with its own tests — 
**fixed in §19 below**.

## 18. Config load provenance and `/delegate config`

**Status:** done ([#33](https://github.com/yorch/pi-harness-delegate/pull/33))

`loadConfig()` used to wrap everything in a bare `catch {}`, so an absent file, an absent `delegate` key
and an unparseable `settings.json` were indistinguishable — all silently yielded defaults. Every
comparable pi extension surveyed in §17 logs or warns; this repo was the only one that didn't.

- `loadConfigWithSource()` is now the single read/parse point, returning `{config, source}` with the file
  path, whether it exists, which key won (`delegate` / `claudeDelegate` / neither), any parse error, and
  the raw winning value. `loadConfig()` is a thin wrapper, so callers and the single-read behavior are
  unchanged.
- `/delegate status` leads with that provenance. `/delegate config` prints raw-vs-effective config as a
  paste-ready block; `/delegate config init` writes it — read-whole-file, replace only the `delegate` key,
  atomic `tmp` + `renameSync`, and **refuses** rather than clobbering an unparseable file.
- Corrects an earlier, wrong claim about the legacy key: `harnesses.<name>.transport` **does** migrate
  under `claudeDelegate`. Only `defaultHarness` and a top-level `model` are genuinely unreachable there.
  `/delegate config init` is the one-command fix, and never touches `claudeDelegate` itself.

## 19. Security: project-local templates could self-declare trust

**Status:** done ([#34](https://github.com/yorch/pi-harness-delegate/pull/34))

`templates.ts`'s `isTrusted(cwd)` read `<cwd>/.pi/trusted` — **the trust anchor lived inside the content
it was gating** — and honored `PI_TRUSTED` / `PI_DELEGATE_TRUSTED`, which have no analog in pi's own trust
model and blanket-trust every directory for a shell session.

Confirmed by working repro: a repo committing `.pi/trusted` = `1` gets its `.pi/delegate/templates/`
loaded, **overriding a builtin** — an override of `review` widened `permission: readonly` to `edit`, and
`resolveVerifyPlan` only skips `verify` at `readonly`, so the template's `verify:` string executed
host-side via `sh -c`. Net: cloning a hostile repo and running `/delegate review` — a command users
reasonably read as read-only — gave arbitrary host command execution.

- `loadTemplates(cwd, harness?, trusted = false)` now **receives** trust instead of deciding it, defaulting
  to untrusted, so a call site that forgets to pass it fails closed. `isTrusted()` deleted; both env vars
  removed.
- `index.ts` resolves trust once via a defensive `ctx.isProjectTrusted()` wrapper (pi's own store lives in
  `~/.pi/agent/trust.json`, outside any project, resolved by walking upward) and threads it through every
  call site. `/delegate status` reports when project templates were skipped and how to grant trust.
- Behavior break, deliberate: `.pi/trusted` and `PI_TRUSTED` no longer grant trust. Use pi's `/trust` or
  `defaultProjectTrust`.
- The regression test was verified to **fail against the pre-fix implementation**, not merely pass against
  the fixed one.

## Future

- Devin's `model` isn't wired over ACP — no verified way to set it on this version's ACP surface (`session/new`'s request has no model field; `configOptions` only appears in responses). Revisit if a `session/set_config_option`-shaped request turns up.
- See [`docs/pi-subagents-assessment.md`](docs/pi-subagents-assessment.md) for the researched comparison against `pi-subagents` and its prioritized candidates. Its "clearly worth doing" display/inspection items shipped in §12 above. Its "questionable" bucket (per-template memory, tool-description verbosity, refine-style auto-tuning) stays parked pending observed need; its "not applicable" bucket (session fork, live steering, workflow sandbox, missions, per-child drill-in transcript viewer, steering) is blocked upstream on the harness CLIs, not on this repo.

---

## In-flight / TODO

- [x] Live integration tests against real binaries — `tests/live.test.ts`, opt-in via `PI_DELEGATE_LIVE=1`, never runs in CI (#30).
- [ ] Re-capture fixtures on each harness CLI upgrade — the shipped binary is the contract, not its docs. Both broken-args bugs would have been caught by one real run per harness.
