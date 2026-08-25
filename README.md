# pi-harness-delegate

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

The `delegate` tool takes: `harness`, `task`, `mode`, `scope` (`diff` = git diff, `pr` = PR diff, path list, or whole repo), `model`, `maxBudgetUsd`, `allowDangerous`, `sessionId`, `pr`.

`claude_delegate` remains as a deprecated alias for `delegate{harness:claude}`.

## Harnesses

| Harness | Binary | Permission mapping | Notes |
|---|---|---|---|
| `claude` | `claude` | `readonly→plan`, `edit→acceptEdits`, `danger→bypassPermissions` | Full stream-json, cost + context% |
| `codex` | `codex` | `readonly→read-only`, `edit→workspace-write`, `danger→danger-full-access` | `codex exec --json`, best-effort JSONL |
| `opencode` | `opencode` | `readonly→read-only`, `edit→allow-edit`, `danger→danger` | `opencode run --format json` |
| `amp` | `amp` (`omp` alias) | `readonly→read-only`, `edit→workspace`, `danger→danger` | `amp --output jsonl` |

Detect availability: `delegate` checks `harness --version` at startup; missing harnesses hint install instructions.

## Modes (templates)

| Mode | Permission | Purpose |
|---|---|---|
| `review` | `readonly` | Code review, cites `file:line`, prioritized findings |
| `plan` | `readonly` | Detailed implementation plan with steps + risks |
| `implement` | `edit` | Implements a task, runs checks, reports changes |
| `security-audit` | `readonly` | Injection, auth, secrets, deserialization, supply chain |
| `docs` | `edit` | Generate/update docs matching repo style |
| `general` | `edit` | Any task |

Each mode is a markdown template with frontmatter:

```yaml
---
name: review
description: Code review of a scope. Read-only.
permission: readonly      # normalized: readonly | edit | danger
model: sonnet             # or gpt-5 for codex, etc. Aliases resolved via modelAliases
defaultTask: Review the current git diff
defaultScope: diff
---
You are a senior code reviewer delegated by the pi coding agent.
...
```

**Native escape hatch:** if you need a harness-specific permission not covered by the normalized set, use the native key (`permissionMode: dontAsk`, `sandbox: ...`) — it overrides `permission` for that harness.

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
    "maxConcurrent": 1,
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
- `maxConcurrent` — cap overlapping runs (default 1 global; may be `{global:1, perHarness:{claude:1}}`).
- `maxTranscripts` — oldest transcripts pruned beyond this count per harness (`0` disables).

`autoDelegateHints` is off by default — no system-prompt bias. When `true`, explicit markers (`@harness`, `with codex`, `delegate … to claude`) and imperative review/plan phrasing append a hint.

## Metrics recorded

Every run records in details + transcript: harness, mode, permission (normalized + native), cost, tokens (input/output/cache), context% (prompt ÷ window), model, turns, duration, TTFT, stop reason, session id. Token + cost feed pi's `Usage`.

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
npm install
npm run typecheck
npm test
```

See `AGENTS.md` for architecture. Release: bump `version` in `package.json`, `npm publish --access public`, `pi update --extensions`.

## License

MIT
