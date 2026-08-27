# Working / Tracking Doc — pi-harness-delegate

Working document for planned and in-flight work. Forked from pi-claude-delegate. Statuses: `done` · `in progress` · `todo` · `future`.

---

## 1. Harness abstraction (Phase 0–1)

**Status:** done (0.6.0)

Extract `Harness` interface (`NormalizedPermission`, `detect`, `buildArgs`, `parseLine`, `extractResult`), generic `runHarness`, `registry`, `config` with `delegate` + `claudeDelegate` fallback, partitioned outputs `~/.pi/agent/delegate/outputs/<harness>/`.

**Done:**
- `extensions/harnesses/types.ts`, `extensions/runner.ts`, `extensions/harnesses/registry.ts`
- `extensions/config.ts` (new key `delegate`, legacy `claudeDelegate` migration)
- `extensions/templates.ts` normalized `permission` + native escape hatch, shared < harness < user < project load order
- `extensions/index.ts` `delegate()` harness-aware, `delegate` tool + `claude_delegate` alias, `/delegate` + aliases `/claude|codex|opencode|amp|omp`, concurrency Map per harness + global, partitioned transcripts, hint/progress/usage generalized
- Shims `run-claude.ts`, `stream-parse.ts` for compat
- `templates/shared` + `templates/<harness>` (claude/codex/opencode/amp) with normalized frontmatter

## 2. Claude harness (faithful port)

**Status:** done (0.6.0)

`extensions/harnesses/claude.ts` — exact port of `run-claude` + `stream-parse`, args `claude -p --output-format stream-json --verbose ... --permission-mode <mapped>`, detects via `claude --version`, permissionMap readonly→plan, edit→acceptEdits, danger→bypassPermissions.

## 3. Codex harness

**Status:** done (0.6.0)

`extensions/harnesses/codex.ts` — `codex exec --json <prompt> --sandbox <level>`, tolerant JSONL + plain-text fallback, synthesizes result if needed, detects via `codex --version`, permissionMap read-only/workspace-write/danger-full-access.

**Known gap:** Codex CLI args drift; `--thread-id` for resume, `maxBudgetUsd` not natively supported (ignored). Needs live capture of real JSONL to refine parser.

## 4. OpenCode harness

**Status:** done (0.6.0)

`extensions/harnesses/opencode.ts` — `opencode run --format json <prompt>`, tolerant parser, detects via `opencode --version`, permission not yet CLI-flagged (gated upstream). Placeholder parser — refine with real transcript.

## 5. Amp harness (omp alias)

**Status:** done (0.6.0)

`extensions/harnesses/amp.ts` — `amp --output jsonl <prompt>`, tolerant parser, detects via `amp --version` (fallback `omp`), alias `omp:amp`. Placeholder — refine with real transcript.

## 6. Tests for harness layer

**Status:** done (0.6.0)

- `tests/harness.test.ts` — claude/codex/opencode/amp parsers, buildArgs permission mapping, registry aliases
- `tests/config.test.ts` — delegate vs claudeDelegate precedence, legacy migration, outputsDir partitioning
- `tests/templates-harness.test.ts` — permission normalized, legacy fallback, native escape hatch
- `tests/command-harness.test.ts` — `parseDelegateCommand` harness as first word, --harness flag, omp alias

Updated `tests/activity.test.ts`, `tests/metrics.test.ts` for harness-aware transcript/report.

## 7. Docs & package rename

**Status:** done (0.6.0)

- `package.json` name `pi-harness-delegate` (unscoped), description, repo `yorch/pi-harness-delegate`, keywords, version 0.6.0
- `README.md` rewritten for harness table, `/delegate` primary + aliases, migration guide, config with `harnesses` per-harness models and `maxConcurrent` object
- `AGENTS.md` rewritten for new architecture
- `CLAUDE.md` symlink kept
- Templates partitioned; `files` still ships `templates/` recursively (covers shared + harness subdirs)

## 8. Future

- Capture real JSONL for codex/opencode/amp to tighten parsers (tool/activity extraction heuristics currently heuristic)
- `maxConcurrent` per-harness UI + tests for object shape
- `/delegate list --harness=...` and `history` harness filter polish, `detectAll` health command
- Keep `pi-claude-delegate` as deprecated wrapper (re-export) — publish once with deprecation notice
- Consider `pi install npm:pi-harness-delegate` name availability check and `--access public` (unscoped default private? verify)
- See [`docs/pi-subagents-assessment.md`](docs/pi-subagents-assessment.md) for a researched comparison against `pi-subagents` (in-process Pi child delegation) and prioritized candidate improvements — top pick: multi-harness comparison fanout

---

## In-flight / TODO

- [ ] Publish 0.6.0 to npm (verify unscoped name not taken, `npm view pi-harness-delegate` 404 → publish)
- [ ] `pi install npm:pi-harness-delegate` smoke test, `pi -e ./pi-harness-delegate -p "/delegate claude review hi" --no-tools`
- [ ] Publish deprecated `pi-claude-delegate@0.5.4` with deprecation notice pointing to new package
- [ ] Real harness integration tests (requires binaries, mocked otherwise)

