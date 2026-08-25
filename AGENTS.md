# AGENTS.md

Guidance for AI coding agents working in this repository.

`pi-harness-delegate` is a [pi coding agent](https://github.com/badlogic/pi-mono) extension that delegates work to multiple harnesses (Claude Code, Muse, OpenCode, Amp) headlessly. It ships as an npm package (`pi-package` keyword), installable with `pi install npm:pi-harness-delegate`.

> `CLAUDE.md` is a symlink to `AGENTS.md` — keep them in sync.

## Commands

| Command | What it does |
| --- | --- |
| `bun run typecheck` | `tsc --noEmit` over `extensions/` (strict, `allowImportingTsExtensions`) |
| `bun test` | `node --experimental-strip-types --test tests/**/*.test.ts` (62 tests, node:test) |
| `bun run lint` | `biome check .` (tabs, 120 cols, single quotes) |
| `bun run lint:fix` | `biome check --write .` |
| `bun run verify` | `lint + typecheck + test` — CI and release both run this |
| `bun changeset` | Create a changeset `.md` (commit it); `--empty` for docs/CI-only |
| `bun run version-packages` | Changesets bump + CHANGELOG (run by release workflow) |
| `bun run release` | `typecheck + check-packables + changeset publish` (OIDC) |
| `pi -e <path> -p "…" --no-tools` | Load local package as temp extension; smoke-tests manifest + factory |

CI (`.github/workflows/ci.yml`) runs `verify` + `check-packables` + changeset presence on every push/PR. Release (`.github/workflows/release.yml`) is changesets + OIDC trusted publishing — no npm token.

## Architecture

- `extensions/index.ts` — entry. Registers `delegate` tool (primary) + `claude_delegate` alias, and `/delegate` command (primary) + `/claude`, `/codex`, `/opencode`, `/amp`, `/omp` aliases. Reads `delegate` config (with legacy `claudeDelegate` migration), builds prompts, writes partitioned transcripts, renders live feed. `delegate()` is the shared engine.
- `extensions/harnesses/types.ts` — normalized `NormalizedPermission = readonly|edit|danger`, `StreamedResult`, `ActivityEvent`, `ParseState`, `BuildArgsOpts`, `Harness` interface (`name`, `binary`, `detect()`, `buildArgs()`, `parseLine()`, `extractResult()`, `permissionMap`), `DEFAULT_TIMEOUT_MS`.
- `extensions/harnesses/claude.ts` — Claude Code runner: `claude -p --output-format stream-json --verbose` (+ `--no-session-persistence`/`--resume`), maps `readonly→plan`, `edit→acceptEdits`, `danger→bypassPermissions`.
- `extensions/harnesses/codex.ts` — Muse: `codex exec --json` + `--sandbox read-only|workspace-write|danger-full-access`, tolerant JSONL parser.
- `extensions/harnesses/opencode.ts` — OpenCode: `opencode run --format json`, similar.
- `extensions/harnesses/amp.ts` — Amp/Omp: `amp --output jsonl`, alias `omp→amp`.
- `extensions/harnesses/registry.ts` — `HARNESSES`, `ALIASES`, `getHarness()`, `detectAll()`, `isKnownHarness()`.
- `extensions/runner.ts` — generic `runHarness(harness, opts)` spawn+readline loop calling `harness.parseLine`/`extractResult`, handles timeout, AbortSignal, TTFT.
- `extensions/run-claude.ts` — deprecated wrapper around `runHarness(claudeHarness)` + `HarnessBuildOpts` compat.
- `extensions/stream-parse.ts` — deprecated wrapper around `parseClaudeLine`.
- `extensions/templates.ts` — template discovery + frontmatter (`permission: readonly|edit|danger` preferred, legacy `permissionMode`/`sandbox` as native escape hatch). Load order: `shared < builtin < user-global < project-local`, later wins on name collision. Partitioned per harness plus legacy dirs.
- `extensions/command.ts` — parser for `/delegate` + aliases: `--harness`, `--mode`, `--model`, `--scope`, `--budget`, `--resume`, `--pr`, plus harness/mode as first words.
- `extensions/config.ts` — `loadConfig()` reads `delegate` (and migrates legacy `claudeDelegate`), `outputsDir(harness)` partitioned (`~/.pi/agent/delegate/outputs/<harness>`), `resolveModelForHarness()`.
- `extensions/activity.ts` — formatters (`formatToolUse`), `buildTranscript(harness, permission, nativePermission)`, `parseTranscriptMeta` (now returns harness), `buildReportContent(harness,mode)`, `pruneOutputs`.
- `extensions/progress.ts` — progress-window overlay (spinner, double-ESC cancel, `m` minimize, `danger` banner).
- Subcommand UIs in `index.ts`: `/delegate list [harness]` and `/delegate history` (partitioned, with scrollable viewer + resume).
- Config surface: `modelAliases` (`economy/balanced/max`), `maxConcurrent` (global + per-harness), `maxTranscripts` (`pruneOutputs` per harness).
- `extensions/usage.ts` — maps harness usage/cost to pi `Usage` (cacheCreation folds into input).

## Conventions

- **Tabs**, single quotes, 120-col lines — enforced by Biome (`biome.json`: tab, 120, singleQuote, trailing all). Run `bun run lint:fix` if a diff looks unformatted.
- TypeScript strict; explicit types on exported functions.
- Relative imports **must include `.ts`** (`./runner.ts`) — jiti + `allowImportingTsExtensions`.
- **Templates live as .md files with frontmatter**, never as code strings. Frontmatter: `name, description, permission: readonly|edit|danger, model, maxBudgetUsd, skill, defaultTask, defaultScope`. Legacy `permissionMode`/`sandbox` preserved as native escape hatch.
- **Never default to `danger`.** Only path is explicit `allowDangerous:true` on a call. `review`/`plan`/`security-audit` stay `readonly`.
- Guard UI calls (`ctx.ui.*`) with `ctx.hasUI` — tools run in all modes.
- Scope `diff`/`pr` resolved in-process via `git diff HEAD` / `gh pr diff`; don't rely on harness running git.

## Release process (changesets + OIDC)

Changesets + OIDC trusted publishing. No manual `version` bump, no `npm publish`.

1. Edit code → `bun run verify`.
2. `bun changeset` (or `bun changeset --empty` for docs/CI) → commit `.changeset/*.md`.
3. PR → CI checks `changeset status --since=origin/main`.
4. Merge to `main` → Release workflow opens/updates `chore: version packages` PR (bumps `package.json` + `CHANGELOG.md`).
5. Review version numbers → Merge Version Packages PR → Release workflow runs `bun run release` (`typecheck + check-packables + changeset publish`), creates tag `vX.Y.Z` pinned to `$GITHUB_SHA` + one GitHub Release, verifies `latest` dist-tag.
6. On machines with the package installed: `pi update --extensions`.

Load-test a local change: `pi -e <repo path> -p "Reply with exactly: OK" --no-tools`. Engine can be exercised without pi: `node --experimental-strip-types --input-type=module -e "import {runHarness} from './extensions/runner.ts'; import {claudeHarness} from './extensions/harnesses/claude.ts'; …"`.

Load-test the release guard: `node scripts/check-packables.mjs` — must pass; fails on `0.0.0` or empty `extensions/`.

## Gotchas (each cost real time — don't rediscover them)

- Unscoped `pi-harness-delegate` — no `--access public` dance for scoped name; but keep `files: ["extensions","templates"]` so subdirs ship.
- `stream-json` requires `--verbose` for claude (do not drop).
- `--no-session-persistence` keeps claude runs from littering session files; other harnesses use their own session flags.
- Peer deps `"*"` (`pi-ai`, `pi-coding-agent`, `pi-tui`, `typebox`) — pi bundles them; never add to `dependencies`.
- Harness CLIs change args often — version-gate `detect()` and snapshot one real JSONL transcript before locking parser.
- **Bun for dev, npm for publish.** CI/release use `bun install`/`bun run` everywhere, but `bun run release` calls `changeset publish` which runs `npm publish --provenance` via npm (OIDC). No npm token in repo — `id-token: write` mints it. First publish of a new package must be local with 2FA (`bun run release`).

## Scope notes

- Do not add a second delegation mechanism — harnesses are the extension point; templates second.
- Prefer adding a template or harness over adding core code.
- Harness CLIs may not emit `stream-json` — parsers must be tolerant (plain text fallback) and `extractResult` must synthesize from `streamedText` if no `result` line.
