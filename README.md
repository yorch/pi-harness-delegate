# pi-harness-delegate

[![npm version](https://img.shields.io/npm/v/pi-harness-delegate?logo=npm&color=CB3837)](https://www.npmjs.com/package/pi-harness-delegate) [![CI](https://github.com/yorch/pi-harness-delegate/actions/workflows/ci.yml/badge.svg)](https://github.com/yorch/pi-harness-delegate/actions/workflows/ci.yml) [![Release](https://github.com/yorch/pi-harness-delegate/actions/workflows/release.yml/badge.svg)](https://github.com/yorch/pi-harness-delegate/actions/workflows/release.yml) [![Node](https://img.shields.io/badge/node-26.x-brightgreen?logo=node.js)](https://nodejs.org) [![Bun](https://img.shields.io/badge/bun-1.3.14-black?logo=bun)](https://bun.sh) [![Biome](https://img.shields.io/badge/Biome-2.5.10-60a5fa)](https://biomejs.dev) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Delegate work to **any harness** ([Claude Code](https://github.com/anthropics/claude-code), [Muse](https://github.com/openai/codex), [OpenCode](https://opencode.ai), [Amp](https://ampcode.com), [Devin](https://devin.ai)) from the [pi coding agent](https://github.com/badlogic/pi-mono): code reviews, detailed plans, implementation, security audits, docs — or your own custom templates.

Each harness runs headless in your repo with a normalized permission (`readonly` / `edit` / `danger`). Results stream back live, and token/cost usage feeds into pi's footer stats. Templates are portable — prompt bodies live in `templates/shared/`, harness-specific frontmatter selects the native permission.

> Successor to `@yorch/pi-claude-delegate` (now a deprecated wrapper that re-exports the `claude` harness).

## Install

```bash
pi install npm:pi-harness-delegate
# or from git
pi install git:github.com/yorch/pi-harness-delegate
```

Requires at least one harness binary on PATH (`claude --version`, `codex --version`, `opencode --version`, `amp --version`, `devin --version`). Restart pi (or `/reload`) to activate.

**Devin setup note:** `devin` refuses to run interactively (`devin`, `devin -p`) in a directory you haven't trusted yet — but this extension runs Devin over `devin acp` (see below), and live testing found that transport is **not** gated by workspace trust in the tested version (`3000.6.7`): a fresh, never-touched directory worked over ACP with no refusal and no prompt. This extension never sets Devin's `skip_workspace_trust` config key on your behalf either way — that stays a decision you make interactively, if you ever need it for `devin` itself.

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
/devin review the new auth flow
```

Only the prompt is required. A **harness as first word** and/or **mode as next word** selects them; every `--flag` is optional (harness defaults to `delegate.defaultHarness`, mode to `delegate.defaultMode`, scope to whole repo).

| Flag | Meaning |
| --- | --- |
| `--harness=<name>` | `claude`, `codex`, `opencode`, `amp` (`omp`), `devin`, `all`, or a comma list (fan-out, below) |
| `--mode=<template>` | Any template name (`review`, `plan`, `implement`, `security-audit`, `docs`, `general`, or your own) |
| `--model=<model>` | Model or alias (`economy`/`balanced`/`max`, see `modelAliases`) |
| `--scope=<scope>` | `diff` (current `git diff HEAD`), `pr` (`gh pr diff` for the current branch), or a path list |
| `--pr=<pr>` | A specific PR to scope to: a number, an http(s) PR URL (`https://<host>/<owner>/<repo>/pull/<n>`, no `user@`), or `owner/repo#123` (implies the PR diff as scope) |
| `--budget=<usd>` | Per-run spend cap in USD (same as the tool's `maxBudgetUsd`) |
| `--timeout=<sec>` | Harness timeout for this run in whole seconds (plain digits), `10`–`7200`; replaces the template's `timeout:` and the config, up or down. Out of range is an error, not ignored. (The tool's `timeoutSec` can only *lower* it — see [Security model](#security-model)) |
| `--add-dir=<path>` | Extra directory the harness may access; repeatable (`--add-dir=../shared --add-dir=/opt/lib`) |
| `--resume=<session-id>` | Continue a previous delegated session (single harness only — not with a fan-out) |
| `--verify="<cmd>"` | Host-run check after the harness exits (see [Verify](#modes-templates)) |
| `--allow-dangerous` | Run this one invocation with `danger` (unrestricted) permission — required for a `permission: danger` template, and escalates any other template to `danger`. Always asks you to confirm first (one prompt for a whole fan-out); refused in a non-interactive session. Never read from config. `--allow-dangerous=true` also works; any other value is off. See [Security model](#security-model) |

Extra directories (`--add-dir`, the tool's `addDirs`, and template `addDirs:`) are merged, resolved against the working directory, and passed as each harness's native option where one exists: `--add-dir` for `claude`, `codex` (fresh runs only — `codex exec resume` has no such flag), and `amp`/`omp`; `additionalDirectories` on the ACP session for `devin`/`opencode` over ACP. `opencode run` (stdout) has no equivalent, so they're ignored there. On the `delegate` **tool**, `addDirs` entries that resolve (after `..` and symlinks) outside the working directory ask you to confirm interactively and are refused in a non-interactive session — the model alone can't widen a run to arbitrary host paths. Template `addDirs:` and `/delegate --add-dir` (both set by you) are not gated.

Flag values may be quoted (`--verify="bun test && bun run lint"`). `--resume`, `--model`, and `--pr` values are validated before anything runs — e.g. a value starting with `-` is rejected, so it can never be smuggled into a harness's command line as a flag.

**Subcommands** (work on `/delegate` and on every alias, where the alias pins the harness filter):

| Subcommand | What it does |
| --- | --- |
| `/delegate list [harness]` | Available modes/templates (all harnesses, or one) |
| `/delegate history [harness]` (alias `logs`) | Past transcripts, newest first; open one to read it (and see its resume hint) |
| `/delegate status [harness]` (aliases `health`, `doctor`, `check`) | Config provenance, project trust, per-harness detection/version/templates/active-vs-cap, spend rollup |
| `/delegate config` | What was read from `settings.json` and the effective config (print-only) |
| `/delegate config init` | Write the effective config into `settings.json`'s `delegate` key (the only write this extension does) |
| `/delegate watch` (alias `show`) | Re-open a minimized progress overlay |

Some modes have **default tasks** when the prompt is omitted:
`/delegate review` reviews the current git diff (`scope: diff`), `/delegate security-audit` audits the repo. Modes without a default (`plan`, `implement`, `docs`, `general`) print a hint asking for a prompt.

The `delegate` tool takes: `harness`, `task`, `mode`, `scope` (`diff` = git diff, `pr` = PR diff, path list, or whole repo), `model`, `maxBudgetUsd`, `timeoutSec` (whole seconds, `10`–`7200`; can only shorten the timeout the template/config gives the run, never lengthen it), `allowDangerous`, `sessionId`, `pr`, `addDirs`. (`verify` is deliberately *not* a tool parameter — see below.) Setting `allowDangerous` from the tool always asks you to confirm interactively, and is refused outright in a non-interactive session — see [Security model](#security-model).

`claude_delegate` remains as a deprecated alias for `delegate{harness:claude}`. A read-only `delegate_modes` tool lets the model list the available modes, their permission tier per harness and the installed harnesses before it delegates (see [Discovering modes](#modes-templates)).

### Fan out to multiple harnesses

`harness` also accepts `all` or a comma-separated list — the same task runs on every harness **concurrently**, up to `maxConcurrent`, and comes back as one comparison report instead of one report per harness (on `/delegate` and the `delegate` tool alike, the spec is case-insensitive and empty elements are dropped, so `claude,` is a plain single `claude` run, not a one-harness fan-out; a spec with no harness in it at all, like `,`, is an error rather than the default harness):

```bash
/delegate all review the auth flow                 # every *detected* harness
/delegate claude,codex plan the migration          # just these two
delegate({ harness: "all", mode: "review", scope: "diff" })   # tool call form
```

- `all` resolves to whatever's actually installed (`detectAll()`) — an uninstalled harness is skipped and named in the report, it doesn't fail the run. An explicit list is validated the same way; an unknown name is also reported rather than aborting the rest. With all five harnesses installed, `all` means five runs.
- Each harness's run goes through the same `delegate()` engine as a single-harness call and writes its own transcript to its own `~/.pi/agent/delegate/outputs/<harness>/`. Runs are launched together and execute in parallel, bounded by `maxConcurrent` (default `4`) — a run beyond the cap queues for a free slot instead of failing (so a 5-harness `all` runs four at once and the fifth when a slot frees), and the cap is enforced across pi processes, not just this one. **This means fan-out spend is genuinely simultaneous**: up to `maxConcurrent` harnesses can bill at once instead of one after another — budget accordingly (`maxBudgetUsd` still applies per run, not to the fan-out as a whole).
- `--resume`/`sessionId` can't be combined with a fan-out — a session id belongs to exactly one harness — and is rejected up front with a message saying so.
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
| `opencode` | `opencode` | `readonly→plan`, `edit→build`, `danger→build --auto` | `opencode run --format json` (stdout, default) or `opencode acp` ([ACP](https://agentclientprotocol.com), opt-in via `transport: "acp"` — see Config). Schema-verified against opencode 1.18.16. |
| `amp` | `amp` (`omp` alias) | `readonly→always-ask`, `edit→write`, `danger→yolo` | `<binary> -p --mode json`, resolves whichever of `amp`/`omp` is actually on `PATH`. Schema-verified against omp 17.2.9 (Sourcegraph's real Amp CLI is unverified). `omp acp` is real but not offered as a `transport` option — its ACP mode surface only has 2 tiers against this CLI's genuine 3. |
| `devin` | `devin` | `readonly→plan`, `edit→accept-edits`, `danger→bypass` | Runs `devin acp` — [Agent Client Protocol](https://agentclientprotocol.com) over stdio, not stdout JSONL (see `acp-runner.ts`). Real tool-call ids, a genuine context-window %, and a working `sessionId`/resume via `session/load`. Reports no `$` cost (stays `null`) and no turn count. `model` is wired via `devin acp --model <MODEL>` (fuzzy names, e.g. `opus`); the reported `model` is read back from Devin's own `_cognition.ai/agent_stopped` event rather than echoed from the request, so it reflects what actually ran. Schema-verified against `devin 3000.6.7 (260a97c8)`. |

Detect availability: `delegate` checks `harness --version` at startup; missing harnesses hint install instructions.

### Transport

Every harness runs over its native CLI's stdout (`stdout`, the default and only option for `claude`/`codex`/`amp`). `opencode` and `devin` also speak [ACP](https://agentclientprotocol.com) (Agent Client Protocol — bidirectional JSON-RPC over stdio): Devin ships ACP-only (no stdout mode exists), and `opencode` supports both — `stdout` stays the default, `transport: "acp"` is opt-in per harness in config (see below). ACP gives `opencode` a genuine `contextWindow` (`null` over stdout) and a server-side running cost total (stdout reports cost too, summed from each step's `step_finish` — `null` only if no step reported one), plus a resume path independently proven to recall cross-process state; the tradeoff is `model`/`numTurns` staying unmeasured (`null`) either way. `amp`/`omp` has a real `acp` subcommand too, but isn't offered as a `transport` value — its ACP mode surface has only 2 permission tiers against the stdout CLI's genuine 3, a real regression, not just an unverified one. Configuring a transport a harness doesn't support fails immediately with a clear error, before anything spawns.

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

All frontmatter keys (one `key: value` per line; only `name` is required):

| Key | Meaning |
| --- | --- |
| `name` | The mode name used to select it (`--mode=`/`mode`) |
| `description` | Shown by `/delegate list` and the `delegate_modes` tool (sanitized, as data) |
| `permission` | `readonly` \| `edit` \| `danger` (default `edit`). Any other value is treated as a native permission string |
| `permissionMode` / `sandbox` | Legacy tier keys, only read when `permission` is absent (see below) |
| `model` | Default model for this mode (call → template → harness → global) |
| `maxBudgetUsd` | Default per-run spend cap in USD (a call's `maxBudgetUsd`/`--budget` wins) |
| `skill` | Appends `Use the "<skill>" skill.` to the prompt |
| `defaultTask` | Task used when the prompt is omitted (e.g. `review` → review the current diff) |
| `defaultScope` | Scope used with `defaultTask` (e.g. `diff`) |
| `verify` | Host-run check command (see below) |
| `addDirs` | Comma-separated extra directories the harness may access (merged with the call's `addDirs`/`--add-dir`) |
| `harness` | Informational: which harness a template targets (shown by `/delegate list`) |
| `harnesses` | Default harness(es) for this mode, used **only when no harness is given** (comma list, e.g. `codex` or `claude, codex`). See below |
| `timeout` | Per-run harness timeout in whole seconds, `10`–`7200`. See below |

**Native escape hatch:** if you need a harness-specific permission not covered by the normalized set, put the native value in `permission:` (e.g. `permission: ask` in a `devin/` template) — it is passed to that harness as-is. Legacy `permissionMode:`/`sandbox:` keys only map onto the normalized tiers, and only when `permission:` is absent (`permission:` always wins; a legacy key that disagrees with it — or legacy keys that disagree with each other — is ignored but flagged with a `⚠` warning — for a native `permission:` value, such as `permission: plan` next to `sandbox: workspace-write`, the check happens at run time against what that value means on the harness actually running it, e.g. `⚠ template "x": permission: "plan" (readonly on claude) overrides sandbox: "workspace-write" (ignored)`, so it appears on the run rather than in `/delegate list`). Both keys accept both vocabularies, case-, whitespace- and `_`/`-`-insensitively: Claude's `plan` and Codex's `read-only` → `readonly`; `acceptEdits`/`dontAsk`/`auto`/`manual` and `workspace-write` → `edit`; `bypassPermissions` and `danger-full-access` → `danger` (gated behind `allowDangerous` / `--allow-dangerous` like any danger template). The three permission key names (`permission`, `permissionMode`, `sandbox`) are themselves case-insensitive (`Sandbox: read-only` counts, and warnings name the key as you wrote it); if a key appears more than once, or both legacy keys are set, the least permissive tier wins. An **unrecognized** legacy value fails closed: the template still loads, but as `readonly` (so it cannot write, and any `verify:` is skipped), with a `⚠ unrecognized sandbox: "…"` warning prefixed to its description in `/delegate list` and repeated on every run (a notification, a `- warning:` transcript line, and a prefix on the returned result). It is not dropped, because a dropped override would let a same-named builtin (e.g. `implement`, which is `edit`) run in its place, and that can be wider than what the author meant.

Native values are checked against a per-harness **allowlist** of readonly/edit-equivalent modes; anything else — the harness's own danger mode *or a value not on the list* — is treated as `danger` and needs `allowDangerous` / `--allow-dangerous` (fail closed). Once confirmed, an unlisted value still runs as declared rather than being swapped for the harness's danger mode. Matching is case-insensitive (`Plan` is claude's `plan`), and an allowlisted value always reaches the harness in its canonical spelling (e.g. `acceptEdits`); a case variant of a danger mode (`Yolo`, `BYPASSPERMISSIONS`) is still danger. A native value that is genuinely read-only on its harness (**bold** below) runs as the `readonly` tier: it is recorded as `readonly` and a `verify:` command on it is skipped, exactly like `permission: readonly`.

| Harness | Native values treated as non-danger |
| --- | --- |
| `claude` | **`plan`**, `acceptEdits`, `manual`, `default` (`auto`, `dontAsk`, `bypassPermissions` → danger) |
| `codex` | **`read-only`**, `workspace-write` |
| `opencode` | **`plan`**, `build` (custom agents, `build --auto` → danger) |
| `amp`/`omp` | `always-ask`, `write` (`always-ask` stays `edit`: what `-p` does with an unanswerable ask is undocumented) |
| `devin` | **`plan`**, `accept-edits`, `ask` (`smart`, `bypass` → danger) |

**Verify:** `verify` is a shell command run **on the host** (never handed to the harness) right after it exits — e.g. `verify: bun test` on an `implement`/`docs`/`general` template turns "the harness says it's done" into an actual pass/fail. It's report-only: a failing verify is appended as its own section in the transcript and injected report, and surfaced in the tool result's `details.verify` (`{command, exitCode, ok}`), but it never changes whether the run itself is reported as an error — that stays whatever the harness reported. No template ships one by default — there's no universally-correct check command, so nothing is invented for you.

- **Sources, deliberately limited:** a verify command can only come from a template's `verify:` frontmatter, or a human typing `/delegate --verify="<cmd>"` (quotes needed for multi-word commands) — the call-level value wins over the template's. **It is not a parameter on the `delegate` tool** — that's on purpose, not an oversight: a tool param is set by the model, and the model's context includes repo content and delegated-harness output, both of which an attacker could influence, so a model-settable verify command would be a prompt-injection → arbitrary-host-command path. A model that wants verification simply picks a template that declares one.
- **Never runs on a `readonly` template** — including a native read-only one (`permission: plan`, codex `read-only`; see the table above). `readonly` (`review`/`plan`/`security-audit`) guarantees no execution or modification — a verify command riding along on one would quietly break that guarantee. If a `readonly` template (or override) has a `verify` configured, it's recorded as skipped (`### Verify: \`cmd\`` / `⊘ skipped (readonly run)`) rather than run, and never silently dropped.
- A project-local template's `verify` command is gated by the same project-trust check as the rest of the template.

**Default harnesses (`harnesses:`):** consulted only when the caller names no harness — an explicit `--harness=`, harness-as-first-word, alias command (`/codex`, …) or the tool's `harness` param always wins. The template copy that decides is the `defaultHarness`'s own copy of the mode when it has one (only that copy — copies kept for other harnesses never mix in); a mode kept only under other harnesses' folders (e.g. `~/.pi/agent/delegate/templates/codex/x.md`) uses the first such copy, in harness order (claude, codex, opencode, amp, devin), that declares `harnesses:`. The same rule drives `/delegate`, the `delegate` tool and `delegate_modes`, which shows the result (or that a harness must be named). Project-local copies count only for a trusted project, as for a run (an untrusted project's template can never pick the harness).
- The list is used the same way by `/delegate <mode> …` and by the `delegate` **tool**: one name is a normal single run on that harness; several make it a normal [fan-out](#fan-out-to-multiple-harnesses): uninstalled/unknown names are skipped and reported, runs queue for `maxConcurrent` slots, a danger escalation (`--allow-dangerous` / the tool's `allowDangerous`) asks once naming every harness and is refused headless, the tool's out-of-cwd `addDirs` confirm covers every harness, and resuming (`--resume` / `sessionId`) is rejected (a session belongs to one harness — name it explicitly). The model sees each mode's default harnesses in `delegate_modes`, and can always pin one with `harness`.
- `all` is not accepted (name the harnesses), and anything that isn't a plain harness-shaped word is dropped; both are flagged with a `⚠` warning. A template can't change permission through this — every harness runs the mode at its own tier, with the usual gates.

**Timeout (`timeout:`):** whole seconds from `10` to `7200` (2 h). The harness timeout for a run is resolved most-specific first: the template's `timeout:` → the per-harness `harnesses.<name>.timeoutMs` → the global `timeoutMs`. A per-call timeout then applies: your `/delegate --timeout=<sec>` replaces it (up or down), while the tool's model-set `timeoutSec` can only lower it — a larger value has no effect. A call or template value never exceeds 7200 s. Every transcript records the timeout the run got (`- timeout: …s`). An invalid template value (out of range, fractional, `600s`, …) is ignored — the next level applies — and flagged with a `⚠` warning in `/delegate list`, `delegate_modes` and on every run (same places as a permission warning); an invalid per-call value is an error and nothing runs.

**Discovering modes:** `/delegate list [harness]` shows every mode with its permission tier on each harness, where it came from (`builtin`/`user`/`project`), its defaults and any warnings. The model gets the same data from the read-only **`delegate_modes`** tool (optional `harness` filter), so it can pick a mode before delegating: per-harness tier (danger and unlisted native modes are marked as needing `allowDangerous`), whether a default task/scope or a host-run check is configured, the `harnesses:`/`timeout:` defaults, and which harnesses are on `PATH`. It runs nothing (a `PATH` lookup, not a `--version` probe — so "on PATH" isn't a guarantee it works), lists project-local templates only for a trusted project, and never shows a `verify:` command, prompt body, `defaultTask`/`defaultScope` text or file paths. Template text is untrusted: names, descriptions, models and warnings are stripped of ANSI escapes, control, bidi, zero-width, private-use and other invisible characters (including Unicode tag characters used to smuggle hidden text, Hangul fillers and the blank Braille pattern), runs of combining marks are cut to two, everything is kept to one line and length-capped, and in the tool's output it is JSON-quoted, with descriptions labelled as data, not instructions. Mode and model names also have every non-ASCII character shown escaped (`revi\u{435}w`) with a warning, so a look-alike name can't pass for a real one like `review`. `/delegate list` gets the same sanitizing, so a hostile description can't drive your terminal. When harness-specific copies of a mode differ (model, timeout, `harnesses:`, host check, …), the listing says which fields differ and whose copy it shows. Modes are listed builtin first, then user, then project, at most 50 from each source (the overflow is counted per source) — so a project with many templates can't push the builtin modes out of the list. A permission warning that only makes sense on a chosen harness (a native `permission:` value overriding ignored legacy keys) appears on the run, not in discovery.

Templates have no variable substitution (`{{task}}` etc.) — the task and scope are always appended by the extension.

**Template sources (later wins):**

- `templates/shared/*.md` — portable prompt bodies
- `templates/<harness>/*.md` — harness-specific frontmatter (built-ins)
- `~/.pi/agent/delegate/templates/<harness>/<name>.md` (global)
- `.pi/delegate/templates/<harness>/<name>.md` (project — only when the project is trusted, see below)
- Legacy `~/.pi/agent/claude-delegate/templates/` and `.pi/claude-delegate/templates/` still loaded for migration

Custom templates are just files dropped in the above dirs — any registered name becomes a valid `mode`.

**Project trust:** project-local templates (`.pi/delegate/templates/`) load only when pi itself considers the current project trusted (`ctx.isProjectTrusted()`, backed by pi's own trust store outside the project — the same trust that gates other project-scoped behavior). Trust it via pi's own trust prompt (shown the first time you open an untrusted directory) or your `defaultProjectTrust` setting; `/delegate status` reports whether the current project is trusted and, if not, that project-local templates are being skipped. There is **no way to grant trust from inside the project** — no `.pi/trusted` file, no environment variable. Earlier versions supported both (`.pi/trusted` containing `1`, or `PI_TRUSTED=1`/`PI_DELEGATE_TRUSTED=1` in the environment); both were removed as a security fix — a repo could commit `.pi/trusted` and declare itself trusted, letting a cloned hostile repo's templates silently override a builtin (e.g. widening `review` from `readonly` to `edit` and attaching a `verify:` command that runs host-side). If you relied on either, switch to pi's trust prompt or `defaultProjectTrust`. **On upgrade this is otherwise silent** — a project override shares its name with the builtin it replaces, so the run just uses the builtin and looks fine — so a delegation in an untrusted project that actually has `.pi/delegate/templates/` now prints a one-time warning saying they were skipped, and points out a leftover `.pi/trusted` file if one is present (it no longer does anything and can be deleted).

## How the main session consumes the output

- **Agent-driven (`delegate` tool)** — report is the tool result, flows into agent context.
- **Manual (`/delegate` / aliases)** — report is injected as a custom message on next `before_agent_start`, participates in LLM context; full transcript also in file.

## Inspecting what the harness is doing

- **Live activity feed** — `▶ Bash: ... ✓/✗`, `💭 thinking…`, text tail. `/delegate` shows a framed progress window (spinner, `danger` banner for `danger` permission, `esc`×2 cancels, `m` minimizes, `watch` re-opens).
- **Full transcript every run** — `~/.pi/agent/delegate/outputs/<harness>/<ts>-<mode>.md` (also legacy `claude-delegate/outputs/` for claude). Tool result ends with path. Transcripts contain your prompts, diffs, and the harness's full output, so they're written owner-only (directory `0700`, files `0600`).
- **Resume:** every run records a session id.

```bash
/delegate --resume=<session-id> follow up on the review
# or harness-specific alias:
/codex --resume=<session-id> fix the nits
```

Reveal thinking live with `"inspectThinking": true` in config (off by default).

## Config

In `~/.pi/agent/settings.json` (or `$PI_CODING_AGENT_DIR/settings.json` — `PI_CODING_AGENT_DIR`, pi's own agent-dir override, relocates everything this extension keeps under `~/.pi/agent`: settings, user templates, transcripts, and the active-run registry):

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
      "opencode": { "model": "opencode-default", "transport": "acp" }
    }
  }
}
```

Run `/delegate config` to see exactly what was read from `settings.json` (or why nothing was — no file, no `delegate` key, or a parse error), plus the effective config with defaults filled in, as a paste-ready JSON block for the `delegate` key. `/delegate status` shows the same provenance as one summary line.

`/delegate config init` writes the parts of that effective config that differ from the built-in defaults into `settings.json` under the `delegate` key (an unmodified setup writes `{}`) — defaults are deliberately *not* written, because a value present in the file is treated as your choice and would stop later releases' default changes (e.g. `maxConcurrent` 1 → 4) from reaching you — the only thing this extension ever writes there, and only on this explicit command. It reads the whole file, replaces only the `delegate` key, and preserves every other key (pi's `theme`/`defaultProvider`/`packages`/…, and a leftover `claudeDelegate`, verbatim). The write is atomic (temp file + rename in the same directory — no torn file if the process dies mid-write) and refuses outright if the existing file fails to parse, rather than clobbering whatever's actually in it. It also keeps the file's mode, writes through a symlinked `settings.json` rather than replacing the link, matches the file's trailing-newline convention, and takes pi's own `settings.json.lock` — if another pi session holds it, the command refuses and you retry; `/delegate config`'s paste-ready block is the fallback in that case.

Legacy `claudeDelegate` is auto-migrated into `delegate.harnesses.claude` (deprecated) — most fields migrate, including per-harness settings like `harnesses.<name>.transport`. Two things never migrate, though, and stay silently unreachable as long as `claudeDelegate` is your *only* key (no `delegate` key at all): `defaultHarness` (stays pinned to `claude`) and a top-level default `model` (only `claudeDelegate.model` → `harnesses.claude.model` migrates — there's no global fallback). Both `/delegate status` and `/delegate config` call this out when it's happening; fix it by renaming `claudeDelegate` to `delegate`, or by running `/delegate config init`, which writes an explicit `delegate` key (with the legacy values already correctly migrated) without touching `claudeDelegate` itself.

Config lives as a key inside pi's own `~/.pi/agent/settings.json` rather than a dedicated file — small enough that this fits comfortably, and pi's extension docs don't prescribe a convention either way for global (as opposed to project-local) preferences. If per-project overrides are ever wanted, pi's documented pattern for extension-owned project config is `.pi/<CONFIG_DIR_NAME>/pi-harness-delegate.json` (gated by project trust); not implemented today.

- `harnesses.<name>.transport` — `"stdout"` (default for every harness except `devin`, which is ACP-only) or `"acp"`. Only legal where the harness actually supports it — see [Transport](#transport) above; an unsupported value fails the run immediately with a clear message rather than being silently ignored or failing at spawn time.

- `modelAliases` — templates may use `economy|balanced|max` or any alias; resolution: call → template → harness → global.
- `maxConcurrent` — cap overlapping runs (default **`4`**, one slot per supported harness; may be `{global:4, perHarness:{claude:1}}`). Enforced across pi processes, not just the current one — a file-based registry under `~/.pi/agent/delegate/runs/` tracks active runs, so the slots available to you also depend on any other pi session running `delegate`. This is a **genuinely parallel** spend cap now, not just a "don't overlap" guard: a single-harness `/delegate` call still fails fast (`another delegate run is already in progress`) the moment it's at capacity, but `/delegate all …` fan-out queues for a free slot instead and can run up to `maxConcurrent` harnesses at once — meaning up to that many harnesses billing simultaneously. Lower it if you want fan-out to stay sequential/cheaper (`"maxConcurrent": 1` restores the old one-at-a-time behavior for everything, single runs included). `/delegate status` shows each harness's `active` count next to the cap that actually applies to it (e.g. `1/2`), so a `{perHarness: {...}}` override is visible per-row, not just the raw config JSON in the header; the summary line at the bottom shows the same for the global cap.
- `maxTranscripts` — oldest transcripts pruned beyond this count per harness (`0` disables).

`autoDelegateHints` is off by default — no system-prompt bias. When `true`, explicit markers (`@harness`, `with codex`, `delegate … to claude`) and imperative review/plan phrasing append a hint.

### Budgets (`maxBudgetUsd` / `--budget`)

A per-run cap, resolved call → template → global config → per-harness config. How it's enforced depends on the harness, and the outcome is always recorded (tool result `details.budget`, a `- budget:` line in the transcript):

- **Native** — `claude` gets `--max-budget-usd` and enforces it itself.
- **Host-enforced (best-effort)** — harnesses with no budget flag that *do* stream a running cost (`opencode`, `amp`/`omp`, and `opencode` over ACP): the host checks the reported total each time the harness reports one and kills the run once it's over the cap, recording `budget exceeded` (`stopReason: budget_exceeded`, a `⛔ budget exceeded … run stopped` line at the top of the result, `(host-enforced, best-effort)` in the transcript). This is **not a hard cap**: cost is only visible at the step/turn boundaries the harness reports, so spend already incurred within the step that crossed the line can't be prevented — a run can overshoot by up to one step/turn (more if a single step is expensive). Use a native-budget harness (`claude`) when the cap must be strict. For `opencode` over ACP the reported cost is a session running total, so on a resumed session only the spend since this run started counts against the cap, and the reported cost is just this run's share — or `—` (unmeasured) when the session didn't report its prior total before the new prompt, rather than an under-count.
- **Not enforceable** — `codex` (no `$` cost on ChatGPT-plan auth) and `devin` report no cost and have no flag, so a budget can't be applied; the run proceeds and the result starts with `⚠ maxBudgetUsd … was not enforced`, never silently.

## Run records

Every run (each member of a fan-out too, and a run that died after streaming output) writes a small JSON **sidecar** next to its transcript: `<transcript basename>.json`, mode `0600` in a `0700` directory. It is what `/delegate history` filters, `/delegate rerun` and fan-out resume read. Pruning (`maxTranscripts`) removes a transcript's sidecar with it, and orphaned sidecars are cleaned up too.

```jsonc
{
  "version": 1,
  "runId": "run_<16 hex>",          // random, unique
  "fanoutId": "fan_<16 hex>" | null, // shared by every member of one fan-out
  "harness": "claude", "mode": "review",
  "permission": "readonly|edit|danger", "nativePermission": null, "nativeClass": "none|safe|danger|unlisted",
  "model": null,                    // the model the harness actually ran, when known
  "sessionId": null, "resumed": false,
  "startedAt": "ISO", "endedAt": "ISO", "durationMs": 1234,
  "isError": false, "partial": false, "stopReason": null,
  "budget": { "limitUsd": 1, "enforcement": "native|host|unenforced", "exceeded": false } | null,
  "timeoutMs": 600000,
  "numTurns": null, "totalCostUsd": null, "usage": null,   // null = unmeasured, never 0
  "transcript": "<file name only>", "cwd": "/abs/project",
  "input": { "task": "…", "taskTruncated": false, "scope": null, "pr": null, "addDirs": [],
             "model": null, "budgetUsd": null, "timeoutSec": null, "hadVerify": false }
}
```

What is **never** stored: the `verify` command text (only `hadVerify`), `allowDangerous`, environment variables, secrets. `task` is capped at 20,000 characters and `scope` at 4,000 (a truncated task is flagged and is not rerunnable). Records are treated as untrusted data on read: a garbled file or an unknown `version` is skipped with a reason, never a crash; everything echoed to the terminal is sanitized; anything that reaches a command line is re-validated before use. Transcripts written before run records existed have no sidecar and still work everywhere (their metadata is parsed from the transcript header).

## Metrics recorded

Every run records in details + transcript: harness, mode, permission (normalized + native), cost, tokens (input/output/cache), context% (prompt ÷ window), model, turns, duration, TTFT, stop reason, session id. Token + cost feed pi's `Usage`.

Claude reports turns and cost on every run; Codex/OpenCode/Amp don't always. An unmeasured turn count or cost renders as `—`/`n/a` (never `0`/`$0.000`) everywhere it's shown — the transcript header, `formatMetrics`, tool results, and `/delegate history` — so an unmeasured run is never mistaken for a free one. `/delegate status` shows a per-harness spend rollup (e.g. `$1.234 over 12 run(s) (3 unknown)`); runs with unknown cost are counted separately rather than folded into the total as `$0`.

One deliberate, narrow exception: pi's own `Usage` (the footer/session token+cost stats) has no way to express "cost unknown" — its `cost.total` field is mandatory. Codex and Devin never report a `$` cost, so treating unknown-cost as unknown-usage there would drop those two harnesses' tokens out of pi's session totals entirely. `mapHarnessUsage`/`mapClaudeUsage` (`extensions/usage.ts`) report the real token counts with `cost.total: 0` in that one case — under-reporting spend by a bounded, knowable amount beats losing 40% of token accounting. This does not change anything above: transcripts, `formatMetrics`, and `/delegate status` still render unmeasured cost as `—`/`n/a`, never `$0`.

## Security model

- `readonly` — no edits (e.g. Claude `plan`, Codex `read-only`).
- `edit` — workspace writes auto-accepted (e.g. `acceptEdits`, `workspace-write`).
- `danger` — unrestricted, **only via an explicit per-call opt-in** — `allowDangerous:true` on the tool, or `--allow-dangerous` on `/delegate` — never a default (and never from config). Shows `⚠ danger` banner. `review`/`plan`/`security-audit` templates stay `readonly`.
- When the **model** sets `allowDangerous: true` on the `delegate` tool, the extension asks you to confirm it (`Allow dangerous delegation?`) before anything runs; declining aborts the call, and in a non-interactive session (no UI to ask) it is refused outright. The model alone can never grant `danger`.
- `/delegate --allow-dangerous` (and the `/claude`, `/codex`, … aliases) is the human-typed counterpart: it also asks you to confirm (`Allow dangerous delegation?`, naming the harness(es), mode, and that it runs with full, unrestricted permissions) — a fan-out gets one prompt covering every harness — and a decline runs nothing. In a non-interactive session it is refused outright, since there's no one to confirm with. It applies to that invocation only.
- **Model-set parameters can only narrow resource limits, never widen them.** The tool's `timeoutSec` can only shorten the timeout the template / your config gives a run — a prompt-injected model can't stretch a run (and its concurrency slot) past what you configured. `/delegate --timeout=` is yours and can raise it.
- Likewise, when the **model** passes `addDirs` on the `delegate` tool, entries that resolve (after `..` and symlinks) outside the working directory need your interactive confirmation (`Allow access outside the project?`) and are refused in a non-interactive session. Entries inside the working directory, template `addDirs:`, and `/delegate --add-dir` are not gated.
- Template values echoed back in a `⚠` warning (the offending `sandbox:`/`permissionMode:`/`permission:`/`timeout:`/`harnesses:` value and the template's name) are quoted, with the same control and invisible characters that mode discovery strips (see **Discovering modes** — C0/C1 incl. the 8-bit CSI, bidi overrides/isolates, zero-width, line separators, tag characters, private-use, …) escaped as `\uXXXX` instead, and capped, so a hostile template can't recolor, reorder or hide text in the warning while you still see what it wrote.
- Values that end up on a harness's command line (`sessionId`/`--resume`, `model`, `pr`) are validated first — notably, nothing starting with `-` is accepted, so a prompt-injected value can't masquerade as a CLI flag.
- External content in the delegated prompt — the `git diff` for `diff`, the `gh pr diff` body for `pr`/`--pr`, and `gh`'s error output if the PR can't be fetched — is wrapped in an **untrusted-data block**: a backtick fence longer than any backtick run inside it, between `BEGIN/END UNTRUSTED DATA <nonce>` markers with a fresh random nonce, plus an instruction that the content is data to analyze, not instructions. A malicious PR can't close the block early or forge its end marker, and the PR is named in the prompt only as `owner/repo#n`/`#n`, never by its raw URL. A free-text `--scope` (e.g. `src/a.ts, src/b`, or a template's `defaultScope`) is delimited the same way between `BEGIN/END SCOPE <nonce>` markers, but framed as a restriction the harness must honor — it can narrow the task, never add to it. Your own task text stays the instruction and isn't fenced. This is a mitigation, not a guarantee — models can still be swayed by injected text.

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
