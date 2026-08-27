# AGENTS.md

Guidance for AI coding agents working in this repository.

`pi-harness-delegate` is a [pi coding agent](https://github.com/badlogic/pi-mono) extension that delegates work to multiple harnesses (Claude Code, Muse, OpenCode, Amp) headlessly. It ships as an npm package (`pi-package` keyword), installable with `pi install npm:pi-harness-delegate`.

> `CLAUDE.md` is a symlink to `AGENTS.md` — keep them in sync.

## Commands

| Command | What it does |
| --- | --- |
| `bun run typecheck` | `tsc --noEmit` over `extensions/` (strict, `allowImportingTsExtensions`) |
| `bun test` | `bun test` (86 tests, bun:test — node:test compatible) |
| `bun run lint` | `biome check .` (2 spaces, 120 cols, single quotes) |
| `bun run lint:fix` | `biome check --write .` |
| `bun run verify` | `lint + typecheck + test` — CI and release both run this |
| `bun changeset` | Create a changeset `.md` (commit it); `--empty` for docs/CI-only |
| `bun run version-packages` | Changesets bump + CHANGELOG (run by release workflow) |
| `bun run release` | `typecheck + check-packables + changeset publish` (OIDC) |
| `pi -e <path> -p "…" --no-tools` | Load local package as temp extension; smoke-tests manifest + factory |

CI (`.github/workflows/ci.yml`) runs `verify` + `check-packables` + changeset presence on every push/PR. Release (`.github/workflows/release.yml`) is changesets + OIDC trusted publishing — no npm token.

## Architecture

- `extensions/index.ts` — entry. Registers `delegate` tool (primary) + `claude_delegate` alias, and `/delegate` command (primary) + `/claude`, `/codex`, `/opencode`, `/amp`, `/omp` aliases. Reads `delegate` config (with legacy `claudeDelegate` migration), builds prompts, writes partitioned transcripts, renders live feed. `delegate()` is the shared engine.
- `extensions/harnesses/types.ts` — normalized `NormalizedPermission = readonly|edit|danger`, `StreamedResult` (`numTurns`/`totalCostUsd` are `number | null` — `null` means the harness's payload didn't report the field, not a measured 0), `ActivityEvent` (`tool_input`/`tool_result` carry an optional `id` used to attribute a result to its originating call in a parallel batch), `ParseState`, `BuildArgsOpts`, `Harness` interface (`name`, `binary`, `detect()`, `buildArgs()`, `parseLine()`, `extractResult()`, `permissionMap`), `DEFAULT_TIMEOUT_MS`.
- `extensions/harnesses/claude.ts` — Claude Code runner: `claude -p --output-format stream-json --verbose` (+ `--no-session-persistence`/`--resume`), maps `readonly→plan`, `edit→acceptEdits`, `danger→bypassPermissions`. Wires `tool_use.id`/`tool_result.tool_use_id` into `ActivityEvent.id`. Schema verified against Claude Code 2.1.247.
- `extensions/harnesses/codex.ts` — Muse: `codex exec --json` + `--sandbox read-only|workspace-write|danger-full-access` (resume is the `codex exec resume <id> <prompt>` subcommand, not a flag — codex-cli dropped `--ask-for-approval` and `--thread-id` from `exec` entirely; `exec` is non-interactive by design so sandbox alone governs approval). Wires `item.id` (shared by `item.started`/`item.completed`) into `ActivityEvent.id`; `item.type` (e.g. `command_execution`) doubles as the tool name since items don't carry a `name` field. `turn.completed.usage` (`input_tokens`/`cached_input_tokens`/`cache_write_input_tokens`/`output_tokens`) is the real final-usage event — this codex-cli version never reports a `$` cost (ChatGPT-plan auth), so `totalCostUsd` stays `null`; `numTurns` is a genuine count of `turn.started` events, not a field the payload reports. Schema verified against codex-cli 0.149.1 — see `tests/fixtures/codex.jsonl`.
- `extensions/harnesses/opencode.ts` — OpenCode: `opencode run <prompt> --format json --agent plan|build[ --auto]` (this CLI version has no `--permission` or `--add-dir` flag at all — permission tiers map onto opencode's built-in agents instead: `plan` read-only, `build` full-access, `--auto` for danger-tier auto-approval; `addDirs` is silently unsupported). Wires `part.callID` into `ActivityEvent.id` — each tool call arrives as one already-resolved `tool_use` event (no separate pending/start line), so `tool_input`+`tool_result` are synthesized together from it. `step_finish.part.cost`/`.tokens` report *per-step* deltas, not a running total, so `totalCostUsd`/`usage`/`numTurns` are accumulated across every `step_finish` seen in the stream. Schema verified against opencode 1.18.16 — see `tests/fixtures/opencode.jsonl`.
- `extensions/harnesses/amp.ts` — Amp/Omp: `<binary> -p --mode json --approval-mode always-ask|write|yolo`, alias `omp→amp`. **`omp` here is "Oh My Pi", a `pi`-framework-based CLI — not a drop-in rebrand of Sourcegraph's Amp** (confirmed via `omp --help`: entirely different flag surface, e.g. `--mode`/`--approval-mode` vs. the real Amp CLI's assumed `--output`/`--permission`). It's simply the only binary of this harness installed on the capture machine, and its JSONL envelope (`session`/`turn_end`/`agent_end`/…) is what got captured and wired; behavior against the real Sourcegraph `amp` CLI is unverified. `binary` resolves to whichever of `amp`/`omp` actually exists on `PATH` at module load (`resolveAmpBinary`) — previously it was hardcoded to `'amp'`, so a machine with only `omp` installed could never actually spawn this harness despite `detect()` reporting it as available. Wires `toolCallId` into `ActivityEvent.id`. `message.usage.cost.total`/`.input`/`.output` on `turn_end` are per-turn, not cumulative (confirmed: three real turns each reported similar-magnitude token counts, not compounding ones) — accumulated across every `turn_end` for a genuine session total; `agent_end` reads the same accumulator rather than re-deriving from `o.message` (which doesn't exist on `agent_end` — it's `o.messages`, an array — a bug that silently nulled out the final result before this fix). Schema verified against omp 17.2.9 — see `tests/fixtures/amp.jsonl`.
- `extensions/harnesses/registry.ts` — `HARNESSES`, `ALIASES`, `getHarness()`, `detectAll()`, `isKnownHarness()`.
- `extensions/runner.ts` — generic `runHarness(harness, opts)` spawn+readline loop calling `harness.parseLine`/`extractResult`, handles timeout, AbortSignal, TTFT.
- `extensions/run-claude.ts` — deprecated wrapper around `runHarness(claudeHarness)` + `HarnessBuildOpts` compat.
- `extensions/stream-parse.ts` — deprecated wrapper around `parseClaudeLine`.
- `extensions/templates.ts` — template discovery + frontmatter (`permission: readonly|edit|danger` preferred, legacy `permissionMode`/`sandbox` as native escape hatch). Load order: `shared < builtin < user-global < project-local`, later wins on name collision. Partitioned per harness plus legacy dirs.
- `extensions/command.ts` — parser for `/delegate` + aliases: `--harness`, `--mode`, `--model`, `--scope`, `--budget`, `--resume`, `--pr`, plus harness/mode as first words.
- `extensions/config.ts` — `loadConfig()` reads `delegate` (and migrates legacy `claudeDelegate`), `agentDir()`, `outputsDir(harness)` partitioned (`~/.pi/agent/delegate/outputs/<harness>`), `resolveModelForHarness()`.
- `extensions/run-registry.ts` — file-based active-run registry (`acquireRun`/`releaseRun`/`countActiveRuns`) under `<agentDir>/delegate/runs/`, one JSON file per active run, so the concurrency guard and `/delegate status` active count are accurate across pi processes, not just the current one. Best-effort (never throws); stale entries from dead pids *and* entries with a corrupt/non-numeric `pid` are cleaned up on read (`process.kill(pid, 0)`, treating `EPERM` as alive). `delegate()` combines it with the pre-existing in-process counters via `Math.max` as a fallback. **`maxConcurrent` is a best-effort cap, not a hard mutex** — `countActiveRuns()` (read) and `acquireRun()` (write) are separate, unlocked steps, so two pi processes starting at the same instant can both observe a count under the limit and both proceed.
- `extensions/activity.ts` — formatters (`formatToolUse`), `ToolCallIndex` (matches a `tool_result` to its originating `tool_input` by id, falling back to "last entry" when no id — shared by the transcript log and the live-feed builders), `collectActivityLog`, `buildTranscript(harness, permission, nativePermission)`, `parseTranscriptMeta` (now returns harness; `cost` is `number | null`), `buildReportContent(harness,mode)`, `aggregateSpend`/`formatSpend` (pure cost/run-count rollup used by `/delegate status`), `pruneOutputs`.
- `extensions/progress.ts` — progress-window overlay (spinner, double-ESC cancel, `m` minimize, `danger` banner). `FeedEntry`'s `tool` variant carries an optional `id` for the same result-attribution matching.
- Subcommand UIs in `index.ts`: `/delegate list [harness]`, `/delegate history` (partitioned, with scrollable viewer + resume, legacy dir filtered for `-partial` transcripts same as the partitioned dirs), and `/delegate status` (per-harness spend rollup via `aggregateSpend`, e.g. `$1.234 over 12 run(s) (3 unknown)` — unknown-cost runs are never folded into the total silently).
- Config surface: `modelAliases` (`economy/balanced/max`), `maxConcurrent` (global + per-harness), `maxTranscripts` (`pruneOutputs` per harness).
- `extensions/usage.ts` — maps harness usage/cost to pi `Usage` (cacheCreation folds into input). `mapHarnessUsage`/`mapClaudeUsage` return `undefined` when cost is unknown rather than reporting a fake $0 into pi's session totals — callers must handle the `Usage | undefined` result.

## Conventions

- **2 spaces**, single quotes, 120-col lines — enforced by Biome (`biome.json`: 2 spaces, 120, singleQuote, trailing all). Run `bun run lint:fix` if a diff looks unformatted.
- TypeScript strict; explicit types on exported functions.
- Relative imports **must include `.ts`** (`./runner.ts`) — jiti + `allowImportingTsExtensions`.
- **Templates live as .md files with frontmatter**, never as code strings. Frontmatter: `name, description, permission: readonly|edit|danger, model, maxBudgetUsd, skill, defaultTask, defaultScope`. Legacy `permissionMode`/`sandbox` preserved as native escape hatch.
- **Never default to `danger`.** Only path is explicit `allowDangerous:true` on a call. `review`/`plan`/`security-audit` stay `readonly`.
- Guard UI calls (`ctx.ui.*`) with `ctx.hasUI` — tools run in all modes.
- Scope `diff`/`pr` resolved in-process via `git diff HEAD` / `gh pr diff`; don't rely on harness running git.
- **Unmeasured metrics are `null`, never a fake `0`.** `numTurns`/`totalCostUsd` on `StreamedResult` and `cost` on `parseTranscriptMeta` are `number | null` — `null` means the harness's payload didn't report the field. Render `null` as `—`/`n/a` (`formatMetrics`, `buildTranscript`, `/delegate status`, `/delegate history`), never `0`/`$0.000` — a real `$0` run and an unmeasured run must stay visually distinct.

## Release process (changesets + OIDC)

Changesets + OIDC trusted publishing. No manual `version` bump, no `npm publish`.

1. Edit code → `bun run verify`.
2. `bun changeset` (or `bun changeset --empty` for docs/CI) → commit `.changeset/*.md`. **Important:** `package.json:files` includes `README.md` (and `templates/` for this repo), so even README/docs-only PRs are considered a package change — `ci: Changeset present` (`changeset status --since=origin/main`) will fail without a changeset. For docs-only that should not bump the version, run after `bun install`:
   ```bash
   bun install
   ./node_modules/.bin/changeset add --empty   # creates .changeset/*.md with ---/--- (no bump)
   git add .changeset/*.md && git commit
   ```
   This satisfies CI with `Packages to be bumped:` empty.
3. PR → CI checks `changeset status --since=origin/main`.
4. Merge to `main` → Release workflow opens/updates `chore: version packages` PR (bumps `package.json` + `CHANGELOG.md`).
5. Review version numbers → Merge Version Packages PR → Release workflow runs `bun run release` (`typecheck + check-packables + changeset publish`), creates tag `vX.Y.Z` pinned to `$GITHUB_SHA` + one GitHub Release, verifies `latest` dist-tag.
6. On machines with the package installed: `pi update --extensions`.

Load-test a local change: `pi -e <repo path> -p "Reply with exactly: OK" --no-tools`. Engine can be exercised without pi: `bun --input-type=module -e "import {runHarness} from './extensions/runner.ts'; import {claudeHarness} from './extensions/harnesses/claude.ts'; …"`.

Load-test the release guard: `node scripts/check-packables.mjs` — must pass; fails on `0.0.0` or empty `extensions/`.

## Gotchas (each cost real time — don't rediscover them)

- Unscoped `pi-harness-delegate` — no `--access public` dance for scoped name; but keep `files: ["extensions","templates"]` so subdirs ship.
- `stream-json` requires `--verbose` for claude (do not drop).
- `--no-session-persistence` keeps claude runs from littering session files; other harnesses use their own session flags.
- Peer deps `"*"` (`pi-ai`, `pi-coding-agent`, `pi-tui`, `typebox`) — pi bundles them; never add to `dependencies`.
- Harness CLIs change args often — version-gate `detect()` and snapshot one real JSONL transcript before locking parser. Confirmed the hard way: as of codex-cli 0.149.1 and opencode 1.18.16, the flags this repo previously assumed (`codex exec --ask-for-approval`, `codex exec --thread-id`, `opencode run --permission`, `opencode run --add-dir`) are all rejected outright by those CLIs — every codex/opencode delegation would fail before emitting a single JSONL line. Re-verify flags against `<binary> <subcommand> --help` whenever bumping a pinned harness version, not just the JSONL schema.
- `amp`/`omp` isn't one CLI with two names — `omp` ("Oh My Pi") has a completely different flag surface from the real Sourcegraph Amp CLI it's aliased to. Its `resolveAmpBinary()` PATH probe (in `amp.ts`) only picks whichever binary is actually present; it doesn't validate that binary's schema matches what's wired.
- **Bun for dev, npm for publish.** CI/release use `bun install`/`bun run` everywhere, but `bun run release` calls `changeset publish` which runs `npm publish --provenance` via npm (OIDC). No npm token in repo — `id-token: write` mints it. First publish of a new package must be local with 2FA (`bun run release`).

## Scope notes

- Do not add a second delegation mechanism — harnesses are the extension point; templates second.
- Prefer adding a template or harness over adding core code.
- Harness CLIs may not emit `stream-json` — parsers must be tolerant (plain text fallback) and `extractResult` must synthesize from `streamedText` if no `result` line.
