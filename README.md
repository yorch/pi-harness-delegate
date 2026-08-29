# pi-harness-delegate

[![npm version](https://img.shields.io/npm/v/pi-harness-delegate?logo=npm&color=CB3837)](https://www.npmjs.com/package/pi-harness-delegate) [![CI](https://github.com/yorch/pi-harness-delegate/actions/workflows/ci.yml/badge.svg)](https://github.com/yorch/pi-harness-delegate/actions/workflows/ci.yml) [![Release](https://github.com/yorch/pi-harness-delegate/actions/workflows/release.yml/badge.svg)](https://github.com/yorch/pi-harness-delegate/actions/workflows/release.yml) [![Node](https://img.shields.io/badge/node-26.x-brightgreen?logo=node.js)](https://nodejs.org) [![Bun](https://img.shields.io/badge/bun-1.3.14-black?logo=bun)](https://bun.sh) [![Biome](https://img.shields.io/badge/Biome-2.5.10-60a5fa)](https://biomejs.dev) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Delegate work to **any harness** ([Claude Code](https://github.com/anthropics/claude-code), [Muse](https://github.com/openai/codex), [OpenCode](https://opencode.ai), [Amp](https://ampcode.com)) from the [pi coding agent](https://github.com/badlogic/pi-mono): code reviews, detailed plans, implementation, security audits, docs — or your own custom templates.

Each harness runs headless in your repo with a normalized permission (`readonly` / `edit` / `danger`). Results stream back live, and token/cost usage feeds into pi's footer stats. Templates are portable — prompt bodies live in `templates/shared/`, harness-specific frontmatter selects the native permission.

> Successor to `@yorch/pi-claude-delegate` (now a deprecated wrapper that re-exports the `claude` harness).

## Install

```bash
pi install npm:pi-harness-delegate
# or from git
pi install git:github.com/yorch/pi-harness-delegate
```

Requires at least one harness binary on PATH (`claude --version`, `codex --version`, `opencode --version`, `amp --version`). Restart pi (or `/reload`) to activate.

## Usage

The pi agent uses the `delegate` tool automatically when you ask for e.g. *"review this diff"*, *"make a plan for …"*.

Manual delegation:

```bash
/delegate review the new auth flow                      # default harness (claude)
/delegate codex review the new auth flow                # harness as first word
/delegate --harness=codex --mode=review --scope=diff … # explicit flags
/codex review the new auth flow                         # alias → delegate --harness=codex
/claude --mode=security-audit --scope=auth/ …          # alias → delegate --harness=claude
/opencode plan the cache migration
/amp implement the caching layer
```

Only the prompt is required. A **harness as first word** and/or **mode as next word** selects them; every `--flag` is optional (harness defaults to `delegate.defaultHarness`, mode to `delegate.defaultMode`, scope to whole repo).

Some modes have **default tasks** when the prompt is omitted:
`/delegate review` reviews the current git diff (`scope: diff`), `/delegate security-audit` audits the repo. Modes without a default (`plan`, `implement`, `docs`, `general`) print a hint asking for a prompt.

The `delegate` tool takes: `harness`, `task`, `mode`, `scope` (`diff` = git diff, `pr` = PR diff, path list, or whole repo), `model`, `maxBudgetUsd`, `allowDangerous`, `sessionId`, `pr`. (`verify` is deliberately *not* a tool parameter — see below.)

`claude_delegate` remains as a deprecated alias for `delegate{harness:claude}`.

### Fan out to multiple harnesses

`harness` also accepts `all` or a comma-separated list — the same task runs on every harness **concurrently**, up to `maxConcurrent`, and comes back as one comparison report instead of one report per harness:

```bash
/delegate all review the auth flow                 # every *detected* harness
/delegate claude,codex plan the migration          # just these two
delegate({ harness: "all", mode: "review", scope: "diff" })   # tool call form
```

- `all` resolves to whatever's actually installed (`detectAll()`) — an uninstalled harness is skipped and named in the report, it doesn't fail the run. An explicit list is validated the same way; an unknown name is also reported rather than aborting the rest.
- Each harness's run goes through the same `delegate()` engine as a single-harness call and writes its own transcript to its own `~/.pi/agent/delegate/outputs/<harness>/`. Runs are launched together and execute in parallel, bounded by `maxConcurrent` (default `4`, one slot per supported harness) — a run beyond the cap queues for a free slot instead of failing, and the cap is enforced across pi processes, not just this one. **This means fan-out spend is genuinely simultaneous**: with the default cap, a 4-harness fan-out can bill all four at once instead of one after another — budget accordingly (`maxBudgetUsd` still applies per run).
- The synthesized report is always ordered by the resolved harness list (e.g. `claude, codex, opencode`), regardless of which harness actually finishes first — it groups each harness's metrics + output and a total spend line (unknown-cost runs called out separately, same as `/delegate status`), assembled mechanically, not by asking a model to summarize.
- A single-harness call (`harness: "claude"`, or omitted) behaves exactly as before, including the concurrency guard: it still fails fast with "another delegate run is already in progress" at capacity rather than queueing. Fan-out is opt-in by typing `all`/a list.
- `/delegate all …` batches successful completions into one notification instead of one per harness; a failure is never delayed or folded into the batch — it surfaces immediately.
- In the TUI, a fan-out shows **one overlay for the whole run** — a compact row per harness (spinner/✓/✗, elapsed, current tool activity) — rather than one popup per harness or an interleaved feed you can't attribute to a harness:
  ```
  ╭─ ⠋ delegate all · review · 1/4 · ⏱ 0:42──────────────────╮
  │ ✓ claude   0:38  done                                    │
  │ ⠹ codex    0:41  ▶ Bash: bun test                        │
  │ ⠹ opencode 0:12  ✍ Looking at the auth middleware next…  │
  │ … amp      queued                                        │
  │ esc cancel all · m minimize                               │
  ╰────────────────────────────────────────────────────────────╯
  ```
  Double-ESC cancels every in-flight (and still-queued) run at once; `m` minimizes; the status bar chip shows aggregate state across every status plus elapsed and spend so far (e.g. `● 1✓ 1✗ 1▶ 1… · ⏱ 0:42 · $0.175` — done, failed, running, queued; zero status counts are omitted, so it reads `● 4▶ · ⏱ 0:05` while all four are in flight; the spend segment itself only appears once a run has actually reported a cost). A harness that fails keeps its failure reason on its row rather than blanking, so the overlay still says *why*. Once every row is done or failed, the overlay lingers ~3s on the finished board before closing (Esc or `m` dismisses it immediately) so glancing back after a fan-out still shows the final state instead of an empty screen. Single-harness runs keep the original one-run overlay unchanged, including its live activity feed showing a `+N earlier` marker instead of silently dropping older entries once the feed outgrows the visible window.

## Harnesses

| Harness | Binary | Permission mapping | Notes |
| --- | --- | --- | --- |
| `claude` | `claude` | `readonly→plan`, `edit→acceptEdits`, `danger→bypassPermissions` | Full stream-json, cost + context%. Schema-verified against Claude Code 2.1.247. |
| `codex` | `codex` | `readonly→read-only`, `edit→workspace-write`, `danger→danger-full-access` | `codex exec --json`. Schema-verified against codex-cli 0.149.1; cost is always unmeasured (`null`) on ChatGPT-plan auth. |
| `opencode` | `opencode` | `readonly→read-only`, `edit→allow-edit`, `danger→danger` | `opencode run --format json`. Schema-verified against opencode 1.18.16. |
| `amp` | `amp` (`omp` alias) | `readonly→read-only`, `edit→workspace`, `danger→danger` | `<binary> -p --mode json`, resolves whichever of `amp`/`omp` is actually on `PATH`. Schema-verified against omp 17.2.9 (Sourcegraph's real Amp CLI is unverified). |

Detect availability: `delegate` checks `harness --version` at startup; missing harnesses hint install instructions.

## Modes (templates)

| Mode | Permission | Purpose |
| --- | --- | --- |
| `review` | `readonly` | Code review, cites `file:line`, prioritized findings |
| `plan` | `readonly` | Detailed implementation plan with steps + risks |
| `implement` | `edit` | Implements a task, runs checks, reports changes |
| `security-audit` | `readonly` | Injection, auth, secrets, deserialization, supply chain |
| `docs` | `edit` | Generate/update docs matching repo style |
| `general` | `edit` | Any task |

Each mode is a markdown template with frontmatter:

```yaml
---
name: implement
description: Implement a task with file edits. Runs checks.
permission: edit          # normalized: readonly | edit | danger
model: sonnet             # or gpt-5 for codex, etc. Aliases resolved via modelAliases
verify: bun test          # optional — host-run check after the harness exits
---
You are a senior engineer delegated by the pi coding agent.
...
```

**Native escape hatch:** if you need a harness-specific permission not covered by the normalized set, use the native key (`permissionMode: dontAsk`, `sandbox: ...`) — it overrides `permission` for that harness.

**Verify:** `verify` is a shell command run **on the host** (never handed to the harness) right after it exits — e.g. `verify: bun test` on an `implement`/`docs`/`general` template turns "the harness says it's done" into an actual pass/fail. It's report-only: a failing verify is appended as its own section in the transcript and injected report, and surfaced in the tool result's `details.verify` (`{command, exitCode, ok}`), but it never changes whether the run itself is reported as an error — that stays whatever the harness reported. No template ships one by default — there's no universally-correct check command, so nothing is invented for you.

- **Sources, deliberately limited:** a verify command can only come from a template's `verify:` frontmatter, or a human typing `/delegate --verify="<cmd>"` (quotes needed for multi-word commands) — the call-level value wins over the template's. **It is not a parameter on the `delegate` tool** — that's on purpose, not an oversight: a tool param is set by the model, and the model's context includes repo content and delegated-harness output, both of which an attacker could influence, so a model-settable verify command would be a prompt-injection → arbitrary-host-command path. A model that wants verification simply picks a template that declares one.
- **Never runs on a `readonly` template.** `readonly` (`review`/`plan`/`security-audit`) guarantees no execution or modification — a verify command riding along on one would quietly break that guarantee. If a `readonly` template (or override) has a `verify` configured, it's recorded as skipped (`### Verify: \`cmd\`` / `⊘ skipped (readonly run)`) rather than run, and never silently dropped.
- A project-local template's `verify` command is gated by the same trust check (`PI_TRUSTED=1` / `.pi/trusted`) as the rest of the template.

**Template sources (later wins):**

- `templates/shared/*.md` — portable prompt bodies
- `templates/<harness>/*.md` — harness-specific frontmatter (built-ins)
- `~/.pi/agent/delegate/templates/<harness>/<name>.md` (global)
- `.pi/delegate/templates/<harness>/<name>.md` (project — when trusted)
- Legacy `~/.pi/agent/claude-delegate/templates/` and `.pi/claude-delegate/templates/` still loaded for migration

Custom templates are just files dropped in the above dirs — any registered name becomes a valid `mode`.

## How the main session consumes the output

- **Agent-driven (`delegate` tool)** — report is the tool result, flows into agent context.
- **Manual (`/delegate` / aliases)** — report is injected as a custom message on next `before_agent_start`, participates in LLM context; full transcript also in file.

## Inspecting what the harness is doing

- **Live activity feed** — `▶ Bash: ... ✓/✗`, `💭 thinking…`, text tail. `/delegate` shows a framed progress window (spinner, `danger` banner for `danger` permission, `esc`×2 cancels, `m` minimizes, `watch` re-opens).
- **Full transcript every run** — `~/.pi/agent/delegate/outputs/<harness>/<ts>-<mode>.md` (also legacy `claude-delegate/outputs/` for claude). Tool result ends with path.
- **Resume:** every run records a session id.

```bash
/delegate --resume=<session-id> follow up on the review
# or harness-specific alias:
/codex --resume=<session-id> fix the nits
```

Reveal thinking live with `"inspectThinking": true` in config (off by default).

## Config

In `~/.pi/agent/settings.json`:

```json
{
  "delegate": {
    "defaultHarness": "claude",
    "defaultMode": "general",
    "model": "sonnet",
    "timeoutMs": 600000,
    "allowDangerous": false,
    "inspectThinking": false,
    "maxBudgetUsd": 3,
    "autoDelegateHints": false,
    "modelAliases": { "economy": "haiku", "balanced": "sonnet", "max": "opus" },
    "maxConcurrent": 4,
    "maxTranscripts": 100,
    "harnesses": {
      "claude": { "model": "sonnet" },
      "codex": { "model": "gpt-5" },
      "opencode": { "model": "opencode-default" }
    }
  }
}
```

Legacy `claudeDelegate` is auto-migrated into `delegate.harnesses.claude` (deprecated).

- `modelAliases` — templates may use `economy|balanced|max` or any alias; resolution: call → template → harness → global.
- `maxConcurrent` — cap overlapping runs (default **`4`**, one slot per supported harness; may be `{global:4, perHarness:{claude:1}}`). Enforced across pi processes, not just the current one — a file-based registry under `~/.pi/agent/delegate/runs/` tracks active runs, so the slots available to you also depend on any other pi session running `delegate`. This is a **genuinely parallel** spend cap now, not just a "don't overlap" guard: a single-harness `/delegate` call still fails fast (`another delegate run is already in progress`) the moment it's at capacity, but `/delegate all …` fan-out queues for a free slot instead and can run up to `maxConcurrent` harnesses at once — meaning up to that many harnesses billing simultaneously. Lower it if you want fan-out to stay sequential/cheaper (`"maxConcurrent": 1` restores the old one-at-a-time behavior for everything, single runs included).
- `maxTranscripts` — oldest transcripts pruned beyond this count per harness (`0` disables).

`autoDelegateHints` is off by default — no system-prompt bias. When `true`, explicit markers (`@harness`, `with codex`, `delegate … to claude`) and imperative review/plan phrasing append a hint.

## Metrics recorded

Every run records in details + transcript: harness, mode, permission (normalized + native), cost, tokens (input/output/cache), context% (prompt ÷ window), model, turns, duration, TTFT, stop reason, session id. Token + cost feed pi's `Usage`.

Claude reports turns and cost on every run; Codex/OpenCode/Amp don't always. An unmeasured turn count or cost renders as `—`/`n/a` (never `0`/`$0.000`) everywhere it's shown — the transcript header, `formatMetrics`, tool results, and `/delegate history` — so an unmeasured run is never mistaken for a free one. `/delegate status` shows a per-harness spend rollup (e.g. `$1.234 over 12 run(s) (3 unknown)`); runs with unknown cost are counted separately rather than folded into the total as `$0`.

## Security model

- `readonly` — no edits (e.g. Claude `plan`, Codex `read-only`).
- `edit` — workspace writes auto-accepted (e.g. `acceptEdits`, `workspace-write`).
- `danger` — unrestricted, **only via `allowDangerous:true` on the call** — never a default. Shows `⚠ danger` banner. `review`/`plan`/`security-audit` templates stay `readonly`.

Review what the harness is asked to do before granting broad permissions.

## Migration from pi-claude-delegate

- `pi-claude-delegate` is now a deprecated wrapper. Install `pi-harness-delegate` instead.
- `claude_delegate` tool → `delegate{harness:claude}` (alias still works).
- `/claude` → `/delegate --harness=claude` (alias still works).
- Config `claudeDelegate` → `delegate` (auto-migrated; move your settings).
- Transcripts move from `~/.pi/agent/claude-delegate/outputs/` to `~/.pi/agent/delegate/outputs/<harness>/` (legacy dir still read).

## Development

```bash
bun install
bun run typecheck
bun test
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the project layout, the release dev-loop, and the npm publish gotchas. Agents working in this repo should read [AGENTS.md](AGENTS.md).

## License

MIT
