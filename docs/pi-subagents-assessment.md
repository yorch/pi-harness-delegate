# Assessment: `pi-subagents` and what `pi-harness-delegate` could learn from it

Research date: 2026-08-27. Package examined: `pi-subagents@0.58.0` (npm, published ~8h before this
research; `dist-tags.latest = 0.58.0`; 121 published versions, MIT). Source: `git+https://github.com/nicobailon/pi-subagents.git`
(maintainer `nicopreme` / Nico Bailon). Evidence for this document is the published npm tarball
(`npm pack pi-subagents`, unpacked to `package/`, 275 files / 4.4 MB unpacked) — its `README.md`, all nine
files under `docs/`, `package.json`, several `agents/*.md`, `prompts/*.md`, `skills/pi-subagents/SKILL.md`,
and `CHANGELOG.md`. I did not clone the GitHub repo or read `src/**/*.ts` beyond `index.ts` and the file
listing in `extension-api.md`'s "Runtime files" table — the docs are detailed enough to cite behavior
precisely, but internal implementation claims below are the package's own documentation, not verified
against its TypeScript source. Where I could not confirm something, it's called out explicitly rather than
inferred.

**Update (2026-08-29).** A follow-up pass read `pi-subagents@0.58.0`'s actual npm tarball TypeScript
source (not just its docs) for the live-display/inspection surfaces specifically: `src/tui/fleet.ts`
(1430 lines, full), `src/tui/fleet-status.ts` (846 lines, full), `src/tui/fleet-transcript.ts` (536
lines, partial), `src/tui/render.ts` (2329 lines, partial — the two subagent-result renderers plus the
exports list, not the ~2000 lines of formatting helpers between them), `src/workflows/chat-progress.ts`
(148 lines, full), `src/runs/background/notify.ts` (442 lines, full), and `src/shared/shortcuts.ts` (17
lines, full). §4 below is source-verified from that pass and says so inline; everything else in this
document is unchanged from the original documentation-only research above. Still not read, even in the
follow-up: `src/runs/background/completion-batcher.ts` (its debounce-timing logic itself — only its call
sites in `notify.ts`), `src/runs/foreground/execution.ts` (2,368 lines — the actual foreground
child-spawn loop that populates the state `fleet.ts`/`fleet-status.ts` read), and `src/inspectors/herdr/*`
(the external "Herdr" inspector `H` opens — the keybinding and its call site were confirmed, not what
Herdr itself renders).

## 1. What `pi-subagents` is

`pi-subagents` is "Pi extension for single-agent delegation and scripted multi-agent workflows" — a
sub**agent** system, not a harness-delegation system. It gives the parent Pi session a `subagent` tool that
spawns **child Pi processes** (`pi -p ...`-equivalent, same binary as the parent) running a named *agent*
(a markdown persona: system prompt + tool allowlist + model), and it also supports fenced non-Pi runners
(`claude-code`, `codex-exec`, `cursor-agent`) as an *adapter* mode layered on top of the same lifecycle.

Scale and maturity: `package.json` lists dependencies `acorn`, `jiti`, `typebox`, `yaml`; `devDependencies`
pin `@earendil-works/pi-agent-core@0.81.0`, `@earendil-works/pi-ai@0.81.0`, `@earendil-works/pi-tui@0.81.0`.
The `docs/` set alone is 3,221 lines across 9 files (`tool-reference.md` 385, `agents.md` 486,
`configuration.md` 504, `extension-api.md` 436, `workflows.md` 383, `models.md` 235, `observability.md` 262,
`watchdog.md` 176, `missions.md` 121). `CHANGELOG.md`'s `[0.58.0]` and `[0.57.0]` entries alone credit ~15
distinct external GitHub contributors by issue number, and 0.58.0 shipped hours after 0.57.0 — this is a
fast-moving, externally-contributed, production-grade extension, an order of magnitude larger in scope than
`pi-harness-delegate`.

## 2. How it works

**Delegation model.** The parent Pi session calls the `subagent` tool. Most execution goes through a single
primitive: `workflowScript`, a JavaScript statement body run in a sandboxed evaluator (dependency: `acorn`
for parsing) that calls `await runs.run(key, { agent, task, ... })` for one child and
`await runs.all([{ key, agent, task }, ...])` for parallel fanout (`docs/tool-reference.md`,
`docs/workflows.md`). Legacy declarative `chain`/`tasks`/`parallel` JSON inputs were removed in a "hard
cutover" (`docs/workflows.md` "Migrating old chain shapes") in favor of this scripted form. `runs.steer(key,
message, options)` sends a live message into an already-running keyed child. There is no separate
`runs.start`/`runs.next`/`runs.collect` API — ordinary `Promise.race`/`Promise.all` over stored `runs.run`
promises covers rolling/staged fanout.

**Agents.** An agent is one markdown file: YAML frontmatter (`name`, `tools`, `model`, `thinking`,
`systemPromptMode`, `inheritProjectContext`, `inheritSkills`, `acceptance`, `memory`, ~25 more fields) over a
system-prompt body (`docs/agents.md`). Six builtins ship in the package (`agents/scout.md`,
`researcher.md`, `worker.md`, `reviewer.md`, `oracle.md`, `delegate.md`) plus adapter-profile agents for
external CLIs (`claude-code(-writer)`, `codex-exec(-writer)`, `cursor-agent(-writer)`). Discovery order
(lowest to highest priority) is builtin → installed-package (`package.json` `pi-subagents.agents` or
`pi.subagents.agents`) → user (`~/.pi/agent/agents/**/*.md`) → project (`agents/**/*.md`), with `agentScope`
to narrow it and project always winning name collisions. Agents can be `eject`ed (copy builtin to an
editable file that shadows it), `disable`d/`enable`d, `reset`, or given non-destructive `refine` overlays
(auto-generated, validated, project-local prompt patches layered on top of an unmodified agent file, driven
by evidence from that agent's recent run history).

**Runner types.** `runner.type` in agent frontmatter is `native-pi` (default: a real child Pi process,
sharing protocol/session format with the parent), `external-cli` (a one-shot local command over stdin, no
install dependency, async-only, no steer/resume/fork/tool-budget support), or `external-job` (a
provider-registered long-running advisor job, e.g. Surf's ChatGPT-web bridge). The `claude-code`/
`claude-code-writer`, `codex-exec`/`codex-exec-writer`, `cursor-agent`/`cursor-agent-writer` profiles are
`external-cli`-flavored adapters with hardcoded, non-overridable argv (`docs/agents.md`) — this is the part
of `pi-subagents` that most resembles `pi-harness-delegate`'s job, but it is explicitly a secondary,
bolted-on mode: "External CLI agents use their own runner contract," strictly less capable than native
children (no model override, no structured output, no fork context, no steering, no acceptance gates).

**Concurrency and isolation.** `runs.all` gives ordinary parallel fanout; `worktree: true` on a `runs.run`/
`runs.all` item gives that child its own managed git worktree (branch from clean HEAD, capture a patch +
handoff manifest, auto-cleanup) — `docs/workflows.md` "Worktree isolation". A recursion guard caps nesting
depth (default 2 levels) via `maxSubagentDepth`/`PI_SUBAGENT_MAX_DEPTH`; only agents whose resolved tool
allowlist explicitly includes `subagent` may spawn further children at all.

**Sessions and context.** `context: "fresh"` vs `"fork"` — fork means a literal branched child session file
from the parent's current leaf (not a prompt-injected summary), gated on the parent session actually being
persisted. `forkContext.mode: "pruned"` (0.5x series feature) keeps a fork inside a 64 KiB budget by having a
configured model produce short JSON summaries of spilled items, with raw content kept in a private `0600`
sidecar. Retained (completed but not yet garbage-collected) workflow children can be resumed by `runId`.

**Persistence.** Every async run writes machine-readable lifecycle artifacts (`status.json`,
`events.jsonl`, `output-<n>.log`, plus debug artifacts per child) under a scoped temp/session/project
directory (`docs/observability.md`). "Missions" (`docs/missions.md`) are a separate durable layer *above*
runs — `~/.pi/agent/missions/projects/<project-hash>/` — recording objective, linked run ids, decisions,
labels, and delivery receipts (PR/CI/deploy links as *evidence*, never anything the extension acts on).
Missions can be `goal: true` with a token budget, in which case an idle goal mission proactively nudges the
parent with a "next ready action" notice after each turn. "Schedules" (also `docs/missions.md`) are a
separate durable cron-lite layer: fixed-interval (`m/h/d/w`) or one-shot (`at: "+30m"`) workflow launches
stored per-project under `.pi/subagents/schedules/<id>/`, with `schedule.run-due` letting an *external*
launcher trigger due work so `pi-subagents` itself never needs to be a daemon.

**Permissions.** Tool access per agent is a strict allowlist (`tools: read, grep, ...`) resolved before the
child's first model turn — a missing provider fails the launch with concrete guidance rather than letting the
child run without the tool. An opt-in native permission gate (`permissions.rules` in
`~/.pi/agent/extensions/subagent/config.json`, or per-agent `permission:` frontmatter) can mark individual
non-bash tools `allow`/`ask`/`deny`; `ask` routes through a one-call arbiter that is the *child watchdog*
model itself (approve/deny only, no notify-parent path). `bash` is explicitly out of scope for this gate —
"install and configure `pi-guard`" is the documented answer for command-level policy. A separate opt-in
adversarial **watchdog** reviews the repo diff at `agent_end` boundaries (own model, ideally a *different,
strong* model from whichever the main/child session uses), can track "scope drift" against accumulated user
prompts, and can run TypeScript/JavaScript LSP diagnostics on changed files before its review.

**Model/cost/observability surfacing.** Builtins inherit the parent's current model rather than pinning one,
layered with `subagents.defaultModel` → `agentOverrides.<name>.model` → per-run override, plus fuzzy model-id
matching, `fallbackModels` for provider outage, a `modelScope` allow-list enforcement mode, and a documented
4-tier model-routing recipe (fast workhorse / standard / deep-but-bounded / "taste and intent") in
`docs/models.md`. FleetView (a persistent, navigable TUI panel below or above the editor) and the async
under-editor widget show live per-child state, elapsed time, and both "window" (latest turn's input+cache
tokens) and "spent" (cumulative input+output) token figures; `/subagents-fleet` opens a full inspector with
transcript tailing, live steering, and stop controls.

## 3. UX/UI patterns catalogue

Concrete enough to reimplement, in the order a user would encounter them:

1. **Ask-in-plain-language-first, no config required.** The README's whole "Try this first" section is four
   natural-language example prompts ("Use reviewer to review this diff.") with zero slash-command or JSON
   syntax shown. The model, not the user, decides whether/how to call `subagent`. Slash commands and direct
   `subagent({...})` calls exist but are explicitly secondary ("most users ask naturally or use slash
   commands instead" — `docs/tool-reference.md` line 3).

2. **Role catalogue with a one-line "use it when" table**, not a mode/permission table. `scout` / `researcher`
   / `worker` / `reviewer` / `oracle` / `delegate`, with an explicit recommended loop printed in prose:
   `clarify → scout → worker → fresh reviewers → worker`.

3. **A single scripting primitive (`workflowScript`) instead of a growing menu of shapes.** One vs. sequential
   vs. parallel vs. rolling/staged fanout are all just "more JavaScript," not four different tool parameters.
   The tradeoff is real complexity for the *caller* (the LLM has to write correct async JS), which the package
   compensates for with `{ action: "validate" }` (static syntax/structure check, no execution) and a
   restrictive-but-documented subset (no nested `async function`/arrow helpers, because those break child-launch
   tracking across the Node/Bun boundary).

4. **Two-tier live progress: compact always-on chrome + a full-screen inspector for detail.** A persistent
   FleetView strip below the editor (`2 active agents · 1 pane · ↓ 3.1k window · 4.2k spent`) is always
   visible; `↓`/`←` expands it in place into a tree roster, `Enter` on a roster row opens `Ctrl+Alt+F`'s
   dedicated full-screen inspector (`/subagents-fleet`) focused on that child, and *inside* the inspector
   `x`/`X`/`Ctrl+O` toggles a selected child's tool output between collapsed and full detail — three
   separate keys for three separate steps, not one "expand to full streaming detail" keystroke (corrected
   from an earlier draft of this document against source — see §4).

   The inspector has its own keybindings beyond that toggle (`↑↓/jk` select, `s` compose a
   steer/follow-up/auto message, `D` stop-with-confirmation, `H` open in an external pane inspector).

5. **Foreground vs. background is a first-class run property, not a side effect of tool-call return.**
   `async: true/false` decides whether the parent's turn blocks. Background runs persist status/events/logs
   to disk and notify the *originating session only* on completion, with **smart batching**: several
   successful sibling completions finishing within a short debounce window collapse into one quiet grouped
   notification (`completionBatch` config) — but a failure or a needs-attention state always fires
   immediately, never gets held. This is a genuinely nice detail: "don't spam me with N separate 'reviewer
   finished' pings when N reviewers finish 200ms apart, but never delay bad news."

6. **Steering vocabulary that distinguishes delivery from compliance.** `steer` (interrupt now), `follow_up`
   (queue for next turn boundary), `auto` (queue during an active turn, deliver between turns) are three
   named modes with a bounded 20-message FIFO and an explicit receipt state machine
   (`queued`/`delivered`/`missed`/`failed`) — "`delivered` means Pi accepted the user message, not model
   compliance" is stated outright in the docs, which is the right way to set expectations for an async
   nudge.

7. **Acceptance gates as inferred-by-default, escalatable evidence policy**, not a manual checkbox. A plain
   run infers a level (`none`/`attested`/`checked`/`verified`) from task shape (read-only vs. writer vs.
   async/risky), and callers can either write a full `acceptance: { level, criteria, evidence, verify }`
   object or use a one-line `gate: "npm test"` shorthand that's sugar for `{ level: "verified", verify:
   [{ command }] }` — with **verification result memoization** keyed to unchanged workspace state, so
   re-running the same gate against an untouched tree is free.

8. **A dedicated child→parent question channel, not overloaded tool results.** `contact_supervisor` (child
   side) / `subagent_supervisor({action:"reply"})` (parent side) is a first-class, always-available
   coordination tool distinct from returning task output — with three enumerated `reason`s
   (`need_decision`/`interview_request`/`progress_update`) so children have a documented vocabulary for "I'm
   stuck" vs. "here's a status update" instead of improvising it in prose.

9. **Self-diagnosis as a slash command.** `/subagents-doctor` (also `{action:"doctor"}`) — "if something feels
   off, run this" is printed in the README itself, not buried in a troubleshooting doc.

10. **In-tool discoverable documentation, versioned to the installed package.** `{action:"guide", topic:
    "workflows"}` / `/subagents-guide workflows` reads the *installed* package's own `docs/<topic>.md` file —
    so the model can self-serve accurate, version-matched reference docs mid-conversation instead of relying
    on training data about the tool's own API.

11. **Config knobs default to the safe/quiet choice and are individually named**, not grouped into one big
    settings blob the user has to understand holistically — e.g. `waitTool.enabled`, `asyncByDefault`,
    `forceTopLevelAsync`, `fleetView`, `fleetViewPlacement` are each independently togglable, each documented
    with its own default and failure mode.

12. **Provenance in the transcript, not just in logs.** Every run records model/thinking/fallback-attempts,
    tool budget, acceptance ledger, and a "Mission: `<id>` (`<status>`)" trailer on the human-readable output
    — cross-referencing into the separate durable mission/receipt record without requiring the user to go
    find it themselves.

## 4. Live display and inspection surfaces (source-verified)

Everything in this section comes from the follow-up source-reading pass described in the update note
above, not from `pi-subagents`' documentation. It's scoped narrowly to what's actually on screen while
children run, N-concurrent handling, drill-in views, and failure/cancel/completion/persistence signalling
— not architecture, permissions, or workflow scripting, which §1–§2 above already cover from docs and
which this pass found no contradictions with wherever it could cross-check them (the update note at the
top of this document lists exactly what was and wasn't read this time around).

**Three separate, separately-registered surfaces, not one:**

- **(a) Inline in the main conversation.** `renderSubagentResult`/`renderSubagentSummary` (`render.ts`)
  render the `subagent` tool call's own result block like any other tool result would: collapsed to one
  line (`✓ reviewer · completed`), or expanded into one row per child with a live `⎿ <activity>` line
  while running. This scrolls with the transcript — it is not an overlay.
- **(b) The persistent FleetView strip** (`fleet-status.ts`), placed above or below the editor, refreshed
  every 500ms and content-hashed so it only repaints on an actual change. Collapsed, it's the one-liner
  already described in §3 item 4; `↓`/`←` expands it in place into a tree roster, capped at
  `MAX_AGENT_ROWS = 6` visible rows with `↑ N more`/`↓ N more` overflow bars rather than silent truncation.
- **(c) The full-screen inspector** (`fleet.ts`, opened by `Ctrl+Alt+F` or `/subagents-fleet`), a
  two-pane layout (roster left, detail right) refreshed every 750ms. This is the real drill-in: selecting
  a child auto-loads its parsed transcript (assistant/user/tool events, tool output collapsed to 7 lines
  unless expanded) whenever a transcript file resolves, falling back to a flat key/value block otherwise.

**Keybindings** — all in the full-screen inspector (`DEFAULT_FLEET_KEYBINDINGS`, `fleet.ts:33-48`, every
one overridable) unless noted:

| Key(s) | Action |
| --- | --- |
| `Esc`, `Ctrl+C`, `q` | close the inspector |
| `↑`/`k`, `↓`/`j`, `Home`, `End` | move/jump the roster selection |
| `K`/`J`, `PageUp`/`PageDown` | scroll/page the detail pane |
| `r`/`R` | force refresh |
| `s` | steer — opens a draft input; `Tab` cycles `steer`/`follow_up`/`auto` delivery mode |
| `D` | stop, with a confirm step; footer copy explicitly separates "stop" from a resumable "interrupt" |
| `H` | open the external "Herdr" pane inspector (not traced further — see the update note above) |
| `x`/`X`/`Ctrl+O` | toggle a *selected child's* tool output between collapsed and full detail |
| `p` | Prompt Audit (live foreground children only) — authored / runtime-additions / final-effective prompt views |

The strip (b) has its own, separate nav, not shared with the inspector: `↓`/`←` expand, `↑`/`↓`/`j`/`k`
move (pressing `↑` on the first row collapses back to the one-liner rather than wrapping), `Esc` collapse,
`Enter` open the full inspector focused on that row.

**Failure.** A failed child's row does not disappear from the full inspector — `orderFleetAsyncRuns()`
keeps every terminal run (newest-first, up to `MAX_RECENT_ASYNC_RUNS = 20`) alongside the still-active
ones, so a failed run stays selectable with its transcript and an `Error:` line intact. But the
*always-on strip* (b) filters to `running`/`queued`/`pending` only (`isActiveState`) — a failed child
vanishes from the persistent chrome the instant it goes terminal, whether it succeeded or failed, and
survives only in the on-demand inspector and the injected completion message described below.

*Deliberate divergence, not a gap this repo should close:* `extensions/progress-multi.ts`'s fan-out rows
freeze on failure — `RunRow.activity` keeps the failure reason instead of blanking it — rather than
dropping the row. That is the better behavior of the two; `pi-subagents`' always-visible surface is worse
here, not better, and this is noted so nobody "fixes" this repo's freeze-on-failure behavior to match it.

**Cancellation.** `D` in the inspector stops exactly the selected child, with a confirm step. No bulk
"stop all children" was found anywhere in the files read — every stop/steer call targets one row; a
workflow fan-out has to be stopped child-by-child.

*Also a deliberate divergence:* this repo's shared `AbortController` plus one double-`Esc`
(`runFanoutConcurrent` in `extensions/index.ts`) cancels every in-flight *and* still-queued run in a
fan-out with one gesture — a bulk-cancel capability `pi-subagents` doesn't have. Worth keeping as-is, not
narrowing to a per-child-only model.

**Completion** is not a UI event at all — it's an injected chat message
(`pi.sendMessage({ customType: "subagent-notify", ... }, { triggerTurn })`), the same "inject on the next
turn boundary" mechanism this repo already uses for its own report. Several simultaneous completions fold
into one digest, but the batching gate is explicit and matches §3 item 5's claim — now confirmed against
source rather than docs alone: only `status === "completed"` results go through the debounce batcher;
`failed`/`paused`/`stopped` always fire immediately, bypassing it.

**Persistence** has a hard edge the docs alone didn't surface: the inspector's `asyncDetail()` reads a
run's on-disk `status.json`, and once that file is pruned/GC'd, only bare identifiers remain in memory —
nothing richer can be shown. No on-disk equivalent of this repo's `/delegate history` turned up in the
files read; the closest thing, the inspector's own roster, is session-scoped and bounded
(`MAX_RECENT_ASYNC_RUNS`/`MAX_FLEET_HISTORY_CANDIDATES`), not a standalone cross-session browser. That's a
genuine difference from `/delegate history`, which reads persisted `.md` transcripts directly from disk
regardless of session (`readAllHistory()` in `extensions/index.ts`). Missions (`docs/missions.md`, still
out of this section's scope) are `pi-subagents`' durable cross-session layer instead.

## 5. Side-by-side with `pi-harness-delegate`

| Dimension | `pi-harness-delegate` | `pi-subagents` |
| --- | --- | --- |
| What gets spawned | A separate external CLI process (`claude`, `codex`, `opencode`, `amp`) speaking its own JSONL protocol | Mostly another **Pi process** (native child), same binary/protocol as the parent; external CLIs are a secondary adapter mode |
| Primary interaction | `delegate` tool call *or* `/delegate` + harness aliases, prompt-first | `subagent` tool call, natural language first; slash commands secondary |
| Task shape | One task → one harness run → one permission → one report | `workflowScript`: arbitrary JS composition of any number of typed children, steering, retained-child resume |
| Definitions | Markdown templates (`permission`, `model`, `defaultTask/Scope`) selecting a **mode** | Markdown agents (persona + tool allowlist + model + ~25 more fields) selecting a **role**, with eject/refine/override layers |
| Concurrency | `maxConcurrent` caps overlapping runs, default **1** (global, optional per-harness) | Native parallel fanout (`runs.all`), worktree-per-child isolation, session-wide and per-run spawn caps, active-async-run caps |
| Permission model | Normalized `readonly/edit/danger` mapped per-harness native flag; `danger` only via explicit `allowDangerous:true` | Per-tool allowlist + optional `allow/ask/deny` gate arbitrated by a watchdog model; bash is explicitly out of scope for the gate |
| Live progress | Framed progress window: spinner, tool-activity feed, elapsed timer, `esc`×2 cancel, `m` minimize, danger banner (`extensions/progress.ts`) | Persistent FleetView strip + full-screen inspector, live token "window"/"spent" figures, per-child steer/stop from the inspector |
| Result delivery | Tool result (agent-driven) or injected message on next `before_agent_start` (manual); full markdown transcript on disk | Tool result / FleetView; JSON lifecycle artifacts (`status.json`, `events.jsonl`); optional Gist session share |
| Resumability | `--resume=<session-id>`, harness-native session resume | Resume revives a **new** child process from a persisted `.jsonl` session file; steer (live) vs resume (revive) are distinct |
| Verification / quality gates | None — output is prose the calling agent must judge | Acceptance levels + `gate`/`verify` commands with memoized re-verification; optional adversarial watchdog review |
| Durable state beyond one run | Transcript files only, pruned by `maxTranscripts` | Missions (objective/decision/receipt ledger), goal-driven continuation nudges, cron-lite schedules |
| Cost/model routing | `modelAliases` (economy/balanced/max), per-harness model config | Multi-tier precedence chain, fuzzy model matching, fallback models, `modelScope` allow-list enforcement, a documented 4-tier routing recipe |
| Isolation | None beyond the invoking repo's working tree | Optional per-child git worktree (`worktree: true`) |
| Extension surface for other extensions | None documented | RPC event bus, structured delegation API, capability-ceiling registration, background-work provider registry, external-job provider registry |

**Where they genuinely overlap:** both exist to get a second (or third, or fourth) model's work or opinion
into a session without the primary agent doing it all itself; both normalize permission into a small enum;
both write durable transcripts; both let the user resume a prior run; both have a `doctor`/health-check
concept implicitly (this repo's harness-detection-at-startup vs. `/subagents-doctor`).

**Where each is stronger:** `pi-subagents` is stronger everywhere the child is *another Pi process* — fork
context, steering, structured acceptance, mission/goal continuity, worktree isolation, extension-to-extension
APIs — because a Pi child shares the parent's protocol and can be paused, resumed, and talked to mid-run.
`pi-harness-delegate` is stronger, and arguably *the only tool that does this at all*, at treating genuinely
different coding-agent products (Claude Code's plan-mode reasoning, Codex's sandboxing, OpenCode's and Amp's
own strengths) as interchangeable, normalized backends for the same task — pi-subagents' `claude-code`/
`codex-exec`/`cursor-agent` adapters are explicitly a bolted-on, capability-reduced special case ("External
CLI agents use their own runner contract... Foreground/clarify, steer/resume/interrupt-as-pause, nested
subagents, and fallback models are also unsupported" — `docs/agents.md`), not a first-class model of the
problem the way it is for this repo.

**Where the two models of the world genuinely differ, and flattening them would be a mistake:** a `pi-subagents`
native child is a *cooperative peer process running the same software* — it can be steered mid-turn because
Pi's own protocol has a place to inject a message; it can fork a session because both processes read/write
the same session-file format; it can be resumed because "resume" means "start a new Pi process pointed at
the old session file," which is exactly what Pi already knows how to do. An external CLI harness in this
repo's model is an *opaque subprocess speaking a foreign, harness-specific streaming JSON protocol*
(`extensions/harnesses/claude.ts` parses Claude Code's `stream-json`; `codex.ts`, `opencode.ts`, `amp.ts`
each parse a different, "best-effort"/"tolerant" shape per `AGENTS.md`'s scope notes). There is no shared
session format to fork into, no standard way to inject a live message into a running non-interactive `claude
-p` invocation, and "resume" already means something different and weaker (harness-native `--resume`, not a
Pi-level session fork). Most of `pi-subagents`' most powerful primitives — fork context, steer, retained-child
resume, acceptance-report JSON parsing tuned to a Pi child's output shape — depend on the child being a Pi
process and don't transfer to this repo's actual problem. The things that *do* transfer are the ones that
are properties of *the task*, not the child's runtime: parallel fanout, worktree isolation, gate/verify
commands, batched completion notifications, per-run budget policy, mission-style continuity.

## 6. Assessment: candidate improvements for `pi-harness-delegate`

Ordered by priority within each bucket.

### Clearly worth doing

**1. Multi-harness comparison fanout ("ask N harnesses the same question").** This is the one idea from
`pi-subagents` that plays *to this repo's actual differentiator* rather than against it: nothing else in the
ecosystem lets you ask Claude Code, Codex, OpenCode, and Amp to review/plan the same diff and get a synthesized
comparison. Sketch: add a `compareHarnesses?: string[]` (or reuse `harness: "all"`) input on the `delegate`
tool in `extensions/index.ts`; when set, call the existing `delegate()` engine once per named harness with
`Promise.all` (respecting `maxConcurrent`), write one transcript per harness under
`outputsDir(harness)` as today, and return a synthesized report (e.g. "3/4 harnesses flagged X; only Codex
flagged Y") as the tool result. This reuses `runHarness`/`runner.ts` unchanged — no new delegation mechanism,
just N calls to the existing one, which respects the `AGENTS.md` scope note "do not add a second delegation
mechanism." Effort: medium (mostly in `index.ts`'s orchestration and report synthesis; the harness/runner
layer needs no changes). Risk: cost — running 4 harnesses for one task is 4x spend; should default off and
require explicit opt-in, and should respect `maxConcurrent` per harness so it doesn't silently ignore the
existing concurrency cap.

**2. Optional post-run verification command (`gate`/`verify`), modeled on pi-subagents' `gate` shorthand.**
Templates with `permission: edit` (`implement`, `docs`, `general`) currently return prose claiming success
with nothing checking it. Add an optional `verify?: string` (or array) field to template frontmatter and/or
the `delegate` tool call, executed via the same in-process `git diff`/`gh pr diff` pattern `AGENTS.md`
already uses for `scope: diff`/`pr` (i.e., host-run, not harness-run — "don't rely on harness running git").
Append pass/fail + output tail to the transcript built by `buildTranscript`/`buildReportContent`
(`extensions/activity.ts`). Skip pi-subagents' full acceptance-level taxonomy (`auto`/`none`/`attested`/
`checked`/`verified`) and JSON acceptance-report parsing — that machinery exists because native Pi children
can be prompted to emit a structured report; an external harness's final text is much less reliably
parseable that way, and a simple pass/fail command result is more honest here. Effort: small-medium. Risk:
low — purely additive, opt-in.

**3. Batched/quiet completion notification for manual `/delegate` runs**, per pi-subagents'
`completionBatch` (debounce successful completions briefly, never delay failures). Only relevant once
`maxConcurrent` > 1 is actually exercised (today's default of 1 makes this low-value in practice), so this
should land *after* or *alongside* #1. Effort: small once concurrent runs exist. Risk: low.

### Interesting but questionable

**4. Per-harness/per-mode persistent memory** (pi-subagents' `MEMORY.md` injection, `docs/agents.md` "Per-agent
persistent memory"). Sketch: an optional `memory: true` template frontmatter flag; on run, prepend the first
N lines of `~/.pi/agent/delegate/memory/<harness>/<mode>.md` to the built prompt (`extensions/index.ts`
prompt-building path), and for `edit`/`danger` permission runs, instruct the harness to append dated notes.
Mechanically similar to pi-subagents' approach and would let e.g. a `security-audit` template accumulate
project-specific false-positive notes across runs. Why questionable: value is speculative until observed —
this repo has no evidence yet that the same template repeatedly stumbles on the same issue the way
pi-subagents motivates `refine` overlays with "recent run evidence shows what to correct." Worth revisiting
if a template accumulates known recurring failure modes; not worth building speculatively. Effort: small.

**5. Configurable tool-description verbosity** (pi-subagents' `toolDescriptionMode: full|compact|custom`).
Low effort, but the payoff (shorter system-prompt tool description) only matters once the `delegate` tool's
description grows large; today's description in `extensions/index.ts` is a small fraction of what
pi-subagents' packed `subagent` description covers (dozens of actions, acceptance gates, workflow scripting).
Worth doing opportunistically if/when the description grows, not now.

**6. Refine-style auto-tuning of templates from run history.** Pi-subagents' `refine`/`refine.show`/
`refine.rollback` (evidence-gathering child proposes a validated, revertable prompt patch) is a genuinely
interesting pattern, but it's a meaningful chunk of new machinery (a proposal-generation run, a validation
pass rejecting edits that touch safety/policy/tool sections, revision history, rollback) for a benefit that's
speculative without observed template drift. Track as a "if templates start needing hand-tuning across many
projects" idea, not a near-term item.

### Deliberately not applicable

**In-process JS orchestration sandbox (`workflowScript`).** This exists in pi-subagents because its children
are cooperating Pi processes with a shared protocol the sandbox can safely drive. Building an equivalent
sandbox to orchestrate opaque external-CLI subprocesses would be a large, separate piece of machinery
(argument-parsing per harness, protocol translation, a security review of the JS sandbox itself) that
duplicates functionality the calling pi agent already has by simply making multiple `delegate` tool calls in
sequence or in parallel. `AGENTS.md`'s own scope note — "do not add a second delegation mechanism" — argues
directly against this.

**Session fork / live steering of a running harness.** Requires a shared session-file format and a live
input channel into the child process. None of the four supported harnesses' non-interactive/headless modes
(`claude -p`, `codex exec`, `opencode run`, `amp`) expose that (per `AGENTS.md`'s own description of each as
one-shot `--output-format`/`--json` invocations). This is a real capability gap versus pi-subagents, but it's
a property of the harness CLIs, not something this extension can add without the harnesses themselves
exposing a steering channel — worth revisiting only if a harness CLI adds one.

**Adversarial watchdog reviewer / scope-drift monitoring.** Interesting concept, but it's deep host-hook
machinery (`agent_end` boundary detection, a second always-on model call per edit, LSP diagnostic
integration) built for a host where the extension can observe the *parent's own* turn boundaries. This
repo's existing `review`/`security-audit` templates already cover "get a second model's opinion on a diff" —
adding an automatic, always-on second reviewer would be a materially different (and more expensive/intrusive)
product decision than "delegate on request," not an incremental improvement to it.

**Missions / cron-lite schedules.** A durable objective-tracking and scheduled-recurring-run layer is a
reasonable idea in the abstract, but it implies this extension becoming a persistent-state system with its
own recovery/pruning/global-index concerns (`docs/missions.md`'s `missions.directory`, `retainTerminal`,
`globalIndex`) that goes well beyond "delegate work to a harness and report back." Out of scope for this
repo's stated architecture; if wanted, better as a separate extension built on top of `delegate`, not inside
it.

**RPC/extension-to-extension API surface, capability ceilings, background-work provider registry.** These
solve "let *other* Pi extensions compose with subagents programmatically." Nothing in `pi-harness-delegate`'s
current scope suggests other extensions need to drive harness delegation; premature to build.

## 7. Open questions / what I could not verify

- **`pi-subagents`' actual TypeScript implementation.** I read `index.ts` (10 lines, a thin re-export guard)
  and the `extension-api.md` "Runtime files" table's file list/purposes, but did not read `src/**/*.ts`
  itself. All behavioral claims above are the package's own documentation, which I have no reason to doubt
  (it's detailed, changelog-consistent, and internally cross-referenced) but have not cross-checked against
  source.
- **Whether `pi-subagents` and `pi-harness-delegate` can coexist in one Pi install.** Plausible — they
  register differently-named tools (`subagent` vs. `delegate`) — but not tested here.
- **Community/comparative landscape.** The task suggested a search for sibling `pi-package`-keyword
  extensions; I found `pi-mcp-adapter` and `pi-web-access` (both also by `nicopreme`/Nico Bailon, and both
  referenced as optional dependencies from within `pi-subagents`' own docs — e.g. `researcher`'s web tools
  require `pi-web-access`) but did not do a deeper survey beyond the first page of `npm search
  keywords:pi-package`. No other delegation/subagent extension besides `pi-subagents` turned up in that first
  page.
- **The actual "pi coding agent" this repo targets** (`badlogic/pi-mono`, per `AGENTS.md`) versus the
  `earendil-works/pi` repo `pi-subagents` targets — I could not determine from package metadata alone whether
  these are the same project under a renamed/moved npm scope, a fork, or two related-but-distinct efforts;
  `@earendil-works/pi-coding-agent`'s maintainer list includes `badlogic`, which suggests continuity, but I
  did not confirm the relationship (e.g. via the GitHub repos' own READMEs) beyond what npm metadata shows.
