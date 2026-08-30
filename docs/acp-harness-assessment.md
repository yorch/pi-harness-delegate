# Assessment — ACP support across the five harnesses

**Status:** research note · **Written against:** `pi-harness-delegate` 0.5.0 (`2248e95`), `claude 2.1.251`,
`codex-cli 0.150.1`, `opencode 1.18.16`, `omp 17.2.9`, `devin 3000.6.7 (260a97c8)`

Question: for each of the five harnesses, does it support [ACP](https://agentclientprotocol.com)
(Agent Client Protocol — JSON-RPC 2.0 over stdio, bidirectional), and should we switch it? Same
standard as `docs/devin-acp-harness-design.md`: verify by running it, not by reading docs. Two
harnesses shipped with `buildArgs` that were pure fiction until real captures exposed them (#13);
the Devin design note's own central warning turned out to be wrong (see its §8 errata). This note
follows the same discipline.

**Verdict, up front:** `claude` and `codex` have no ACP surface at all — confirmed by reading their
full `--help` output, not just re-trusting an earlier probe. `opencode acp` and `omp acp` are both
real, and both were driven end-to-end with a genuine capture. `devin` already ships. Nothing here
recommends switching a working harness today — see §5.

## 1. Method and what was run

A scratch git repo outside all worktrees
(`/private/tmp/.../scratchpad/acp-probe/repo`, two files, one commit) plus a small
standalone JSON-RPC client (`probe.ts`/`probe-mode.ts`/`probe-resume-{a,b}.ts`/
`probe-setmode-only.ts`, not committed — throwaway scratch, not part of this repo's source) that
drives the same `initialize` → `session/new` → `session/set_mode` → `session/prompt` handshake
`acp-runner.ts` does, logging every JSON-RPC line in both directions. Deliberately independent of
`acp-runner.ts` itself, so the capture isn't shaped by what the runner already assumes.

Commands actually run (not read about):

- `claude --help` (full output, `grep -i acp` → no match)
- `codex --help`, `codex mcp-server --help`, `codex app-server --help`, `codex exec --help`
  (`grep -i acp` → no match on any)
- `opencode --help`, `opencode acp --help`
- `omp --help`, `omp acp --help`
- `strings -a ~/.opencode/bin/opencode | grep -i 'session/set'` — pulled the real JSON-RPC method
  table and zod parameter schemas straight out of the compiled binary, since the ACP spec site and
  `--help` don't document `session/set_config_option` at all (same class of gap Devin's
  `session/set_mode` was — see the design note's §8)
- Six live ACP sessions against `opencode acp` (billed): one full read-only capture with resume, one
  `plan`-mode write-block test, one bare `session/set_mode` validity check, and a two-process resume
  test (session created and taught a fact in process A, recalled from a fresh process B)
- Three live ACP attempts against `omp acp` (billed): default model, `--model sonnet`,
  `--model openrouter/z-ai/glm-5.2:free` — all three hit account-level failures (below), plus one
  bare `session/set_mode` validity check that needed no model completion

**What succeeded:** the full opencode capture (real tool calls, real cost, verified cross-process
resume, verified `plan`-mode enforcement). **What failed, and why, exactly:** every omp attempt that
needed a real model turn — see §2's omp section. Stopped after three attempts per instructions;
nothing here is fabricated to paper over that.

## 2. Per-harness findings

### claude — no ACP

`claude --help`'s full command list: `agents`, `attach`, `auth`, `auto-mode`, `doctor`, `gateway`,
`import`, `install`, `logs`, `mcp`, `plugin`, `project`, `respawn`, `rm`, `setup-token`, `stop|kill`,
`ultrareview`, `update`. No `acp`. `grep -i acp` over the complete `--help` text (all ~230 lines, not
just the head) returns nothing. Confirmed negative, `claude 2.1.251`.

### codex — no ACP; `app-server` is a different, codex-proprietary protocol

`codex --help`'s full command list: `agents`, `exec`, `review`, `login`, `logout`, `mcp`, `plugin`,
`mcp-server`, `app-server`, `remote-control`, `app`, `completion`, `update`, `doctor`, `sandbox`,
`debug`, `apply`, `resume`, `queue`, `archive`, `delete`, `migrate-rollouts`, `unarchive`, `fork`,
`cloud`, `exec-server`, `features`. No `acp`, and `grep -i acp` over the full text (and over
`exec --help` separately) finds nothing. Confirmed negative, `codex-cli 0.150.1`.

Two things in that list look ACP-adjacent but aren't:

- **`codex mcp-server`** — starts Codex itself as an MCP (Model Context Protocol) server over stdio.
  MCP and ACP are different specs with different message shapes (MCP has no `session/update`
  streaming notifications, no session modes); this exposes Codex's own tools to an MCP client, the
  inverse direction from what a harness needs.
- **`codex app-server`** — `[experimental]`, its own JSON-RPC control protocol over
  `stdio://`/`unix://`/`ws://`, with `daemon`/`proxy`/`generate-ts`/`generate-json-schema`
  subcommands and its own auth model (`--ws-auth capability-token|signed-bearer-token`). This is
  structurally comparable to ACP (bidirectional, JSON-RPC, session-shaped) but it is not ACP — no
  `session/new`/`session/prompt`/`session/update` vocabulary in its `--help`, and adopting it would
  mean reverse-engineering a second, codex-specific protocol from scratch, the same shape of problem
  ACP exists to avoid. Per the brief: not building anything against it, just naming what it is.

### opencode — real ACP, fully captured

`opencode acp --help` confirms the subcommand: *"start ACP (Agent Client Protocol) server"*.

**Handshake and capabilities** (`tests/fixtures/opencode-acp.jsonl:1-4`):

```
protocolVersion: 1
agentCapabilities: { loadSession: true, mcpCapabilities: {http:true, sse:true},
                      promptCapabilities: {embeddedContext:true, image:true},
                      sessionCapabilities: {close:{}, fork:{}, list:{}, resume:{}} }
authMethods: [{ id: "opencode-login", name: "Login with opencode",
                description: "Run `opencode auth login` in the terminal" }]
```

No separate ACP `authenticate` call was ever exercised — the machine's existing `opencode auth login`
state was enough for the handshake to proceed straight to `session/new`. Untested: a machine with no
prior `opencode` login (see §7).

**`session/new` does not use the spec's `modes` field at all.** The response
(`opencode-acp.jsonl:4`) has exactly two top-level keys: `sessionId` and `configOptions` — an array
of `{id, name, category, type, currentValue, options}` objects. Categories observed: `"model"` (a
~660-entry catalog, trimmed in the fixture) and `"mode"` (`build`/`plan`, `currentValue: "build"`).
No `modes: {availableModes, currentModeId}` field anywhere in the response, despite that being how
Devin (and, it turns out, omp — see below) advertise the same thing.

**But the standard `session/set_mode(sessionId, modeId)` method is real and works anyway.** This
isn't documented anywhere reachable from `--help` or the spec site's rendered page; it was confirmed
by `strings -a` on the compiled `opencode` binary itself, which contains the literal RPC method table
(`session_set_mode:"session/set_mode"`, `session_set_config_option:"session/set_config_option"`,
distinct methods) and the zod parameter schema for `session/set_mode`
(`{modeId: string, sessionId: string}`) — i.e. `configOptions`'s `"mode"` entry and the standard
mode-switching RPC are two independently-real things that happen to describe the same underlying
state. Live-tested: `session/set_mode({modeId: "plan"})` → `{}` (success); a bogus modeId →
`{code: -32602, message: "Invalid params: mode not found: not-a-real-mode-xyz"}` — hard rejection,
not silent acceptance.

**Permission-tier proof, not inference.** A session set to `plan` mode, then prompted to create a
new file, produced *zero* `tool_call` activity and this self-report
(`opencode-acp-plan.jsonl`, not committed — see below): *"I'm in plan mode (read-only), so I can't
create the file yet."* `ls` on the scratch repo afterward confirmed no file was created. `plan`
genuinely means read-only here, live-verified, not just per its config-option description string.

**`session/update` kinds and counts**, real read-only run (`opencode-acp.jsonl:5-28`):
`available_commands_update`(1), `agent_thought_chunk`(5), `tool_call`(3), `tool_call_update`(6),
`agent_message_chunk`(7), `usage_update`(1).

**Tool-call correlation is real**, same quality as Devin's: `toolCallId` (e.g.
`call_a7f2d7b02cb14d03b23fe9cf`, `opencode-acp.jsonl:12`) stays identical across its `tool_call` →
`tool_call_update(in_progress)` → `tool_call_update(completed)` sequence
(`opencode-acp.jsonl:12,13,15`).

**Cost and context window are both real, mid-stream.** `usage_update`
(`opencode-acp.jsonl:28`): `{"used": 71750, "size": 200000, "cost": {"amount": 0, "currency": "USD"}}`
— a genuine context-window figure (200000, same order as Devin's), and a genuine `cost` field (`$0`
here because the run happened to be on `opencode/big-pickle`, a $0-cost promotional model — the field
itself is populated, not absent). **This does not appear in the final `session/prompt` response**,
only in the `usage_update` *notification* mid-stream (`opencode-acp.jsonl:29`:
`{"stopReason": "end_turn", "usage": {...4 token counts...}, "_meta": {}}` — no `cost`, no `model`).
A harness would need to latch the last `usage_update`'s `cost`/`size` the same way Devin's
`translateUpdate` latches `contextWindow` from its own `usage_update` — same field names, even
(`size`/`used`).

**Resume, verified two ways.** Same-process `session/load` after the prompt replayed the whole turn
as `session/update` notifications (`opencode-acp.jsonl:31-39`) before returning a result with the
same `configOptions` shape as `session/new` — **no `sessionId` field of its own**
(`opencode-acp.jsonl:40`), exactly Devin's dialect. Then, independently, a genuine **cross-process**
test: process A created a session and was told a fact ("the secret passphrase is
`violet-otter-42`"), then was killed; a completely fresh process B called `session/load` with that
session id and, after replaying process A's turn, was asked to recall the fact — and answered
`"violet-otter-42"` correctly. Resume is real, not merely advertised.

**No `model` or `numTurns` anywhere in any response observed** — the final result reports
`stopReason` and `usage` only; the model that ran is only ever the `configOptions`'s `"model"`
*requested* value from `session/new`, never confirmed back the way Devin's
`_cognition.ai/agent_stopped.stats.modelLabel` confirms what actually ran.

Fixture: `tests/fixtures/opencode-acp.jsonl` (40 lines — the full read-only run plus the
cross-session `session/load` replay). The `plan`-mode write-block capture and the two-process resume
capture aren't separately fixture-committed (each is a narrower, single-purpose repro of a claim
already evidenced structurally in the main fixture); their raw output is quoted above and in this
session's tool transcript, not fabricated after the fact.

### amp / omp — real ACP protocol, live tool-use capture blocked by account limits

`omp acp --help` confirms the subcommand: *"Run Oh My Pi as an ACP server over stdio."* (`amp` itself
isn't installed on this machine — only `omp`, same situation `amp.ts`'s binary-resolution comment
already documents for the stdout harness.)

**Handshake and capabilities** (`tests/fixtures/amp-acp.jsonl:2`):

```
protocolVersion: 1
agentInfo: { name: "oh-my-pi", title: "Oh My Pi", version: "17.2.9" }
authMethods: [{ id: "agent", name: "Use existing local credentials",
                description: "Authenticate via the provider keys/OAuth state already configured under ~/.omp." }]
agentCapabilities: { loadSession: true, mcpCapabilities: {http:true, sse:true},
                      promptCapabilities: {embeddedContext:true, image:true},
                      sessionCapabilities: {list:{}, fork:{}, resume:{}, close:{}} }
```

Same local-credentials pattern as opencode and Devin — no separate ACP `authenticate` round-trip
needed on an already-logged-in machine.

**`session/new` *does* return the spec's standard `modes` field** (`amp-acp.jsonl:4`), unlike
opencode:

```json
"modes": {
  "availableModes": [
    { "id": "default", "name": "Default", "description": "Standard ACP headless mode" },
    { "id": "plan", "name": "Plan", "description": "Read-only planning mode that drafts a plan to a markdown file before any code changes" }
  ],
  "currentModeId": "default"
}
```

— alongside the *same* `configOptions` shape opencode uses (`mode`/`model`/`thinking` categories,
`amp-acp.jsonl:4`). The RPC method table pulled from `~/.opencode/bin/opencode`'s `strings` output
(`session_set_config_option`, `session_set_mode`, `session_set_model`, identical zod schemas for
config options, modes, and `usage_update`) and omp's own advertised `authMethods`/`agentCapabilities`
shape being near-identical to opencode's is strong circumstantial evidence that **omp and opencode
share the same underlying ACP protocol implementation** — not two independent implementations that
happen to converge.

Only two modes exist: `default`, `plan` — same 2-tier ceiling as opencode, just advertised through
the spec's own field instead of only through `configOptions`.

`session/set_mode` live-tested the same way as opencode: `modeId: "plan"` → `{}` (success); a bogus
modeId → **rejected**, but with a looser error shape than opencode's:
`{code: -32603, message: "Internal error", data: {details: "Unsupported ACP mode: not-a-real-mode-xyz"}}`
(-32603 is the generic JSON-RPC "Internal error" code, not -32602 "Invalid params" — a minor spec
sloppiness, but the practical outcome is the same: hard rejection, not Devin's silent acceptance of
an unrecognized modeId).

**Live tool-use, usage, and cost capture failed on all three attempts — an account/billing problem
in this environment, not a protocol problem:**

1. Default model (`opencode-go/deepseek-v4-flash`) → agent surfaced, as plain response text (not a
   JSON-RPC error): *"429 Monthly usage limit reached. Resets in 11 days."*
   (`tests/fixtures/amp-acp.jsonl:8`)
2. `--model sonnet` → fuzzy-matched to `openrouter/~anthropic/claude-sonnet-latest`. This `omp`
   profile routes **every** Anthropic model through OpenRouter rather than this machine's own
   already-authenticated `claude` OAuth session (confirmed: no bare `anthropic/*` provider entry
   exists in the model catalog, only `openrouter/anthropic/*` ones) → *"402 This request requires
   more credits... visit https://openrouter.ai/settings/credits"*
3. `--model openrouter/z-ai/glm-5.2:free` → `session/prompt` simply timed out after 90s with no
   response at all.

Stopped after three attempts, per instructions. **What the failed runs still proved, honestly:** the
JSON-RPC round-trip itself worked correctly all three times (`session/prompt` got a real
`{"stopReason": "end_turn"}` response for attempts 1–2, `amp-acp.jsonl:11`); `usage_update` fired
even on the quota-rejected turn — `{"size": 1000000, "used": 72757}` (`amp-acp.jsonl:9`, no `cost`
field this time, though the shared schema supports one); `session/load` resume replayed the prior
(error) turn correctly (`amp-acp.jsonl:12-14`, same no-`sessionId`-in-result dialect as opencode and
Devin). None of that is a substitute for seeing a real `tool_call`/`tool_call_update` pair or a
non-zero `cost` from omp specifically — that remains unverified (§7).

Fixture: `tests/fixtures/amp-acp.jsonl` (14 lines — the first, most complete of the three failed
attempts; the model catalog inside its `configOptions` is trimmed for size, same as opencode's).

## 3. Comparison table

| Harness | transport | tool-call ids | cost | contextWindow | modes/tiers | resume |
| --- | --- | --- | --- | --- | --- | --- |
| claude | stdout | real | ✅ | ✅ | n/a (no ACP) | n/a |
| codex | stdout | `item.id` | ❌ null | ❌ null | n/a (no ACP) | n/a |
| opencode (stdout, current) | stdout | `part.callID` | partial | ❌ null | 2 (`plan`/`build`, CLI agent) | via `--session` |
| opencode (ACP, this capture) | acp | real, verified | **real** (`$0` observed, field genuine) | **real** (200000) | 2 (`plan`/`build`, same as stdout) | **verified cross-process** |
| amp/omp (stdout, current) | stdout | `toolCallId` | partial | ❌ null | 3 (`always-ask`/`write`/`yolo`) | via `--resume` |
| amp/omp (ACP, this capture) | acp | **unverified** (no successful turn) | **unverified** | 1000000 (seen once, on a failed turn) | **2** (`default`/`plan` — fewer than stdout's 3) | protocol verified, not cross-process for omp specifically |
| devin | acp | real, shipped | ❌ null | ✅ 200000 | 5 (exact match to normalized tiers) | verified, shipped |

## 4. Permission-tier analysis — the gating question

This is the section that decides everything else. "Readonly must genuinely mean readonly" — verified
here, not assumed.

**opencode ACP:** `readonly → plan` is **live-verified faithful** — a real write attempt under `plan`
produced zero tool calls and a self-aware refusal, with a genuine `-32602` rejection backing up any
bogus mode id. `edit` and `danger` both have nowhere to go but `build` (opencode's own description:
*"The default agent. Executes tools based on configured permissions"* — meaning opencode's own
internal permission config, not something this harness controls from outside). **This is not a
regression** — the *current* stdout `opencode.ts` already collapses `edit` and `danger` onto the same
native token (`AGENT_MAP: {edit: 'build', danger: 'build'}`, only distinguished by the stdout-only
`--auto` flag). The one real open question: does `build` mode ever call back with
`session/request_permission` for a write — which this project's ACP client (both `acp-runner.ts` and
the probe used here) answers by auto-declining? That was never exercised, because the only write
attempt tested was under `plan` (where it correctly never got that far). If `build` does ask and gets
auto-declined, the `edit`/`danger` tiers would silently do nothing over ACP — a real, closeable, but
currently open gap.

**omp ACP:** `readonly → plan` is **structurally verified** (accepted, invalid ids hard-rejected) but
**not behaviorally verified** — no live run ever got far enough to attempt a write under any mode,
so whether `plan` actually blocks a write for omp specifically (as opposed to inferred from
opencode's identical mechanism) is untested. `edit` and `danger` both have nowhere to go but
`default` — and unlike opencode, this **is** a real regression: the current stdout amp/omp harness
has three genuine tiers (`always-ask`/`write`/`yolo` via `--approval-mode`), and ACP's mode surface
offers only two. Switching would merge the stdout `edit` tier's "ask before every write" semantics
into the same bucket as full auto-execute, with the actual runtime behavior of that bucket unverified
in either direction.

**Bottom line:** opencode's tier story is *no worse than what already ships*, with one specific,
narrow, closeable unknown (`build`-mode write behavior). omp's tier story is *worse than what already
ships* (3 tiers → 2) on top of being largely unverified live. Per the brief's own standard, neither
is safe to switch today; opencode is closer.

## 5. Recommendation per harness

- **claude — don't switch.** No ACP surface exists. Nothing to evaluate.
- **codex — don't switch.** No ACP surface exists; `app-server` is a different, codex-proprietary
  protocol and building against it would mean reverse-engineering a second protocol from scratch, the
  exact problem ACP exists to avoid. Revisit only if Codex ships real ACP support upstream.
- **opencode — switch *conditionally*, not yet.** Real, verified fidelity gain (cost, a 200k context
  window, and cross-process resume — all currently `null`/step-accumulated-only over stdout) with no
  permission-tier granularity loss versus what ships today. Gated on exactly one more live run:
  attempt a real edit under `build` mode and confirm it isn't silently swallowed by the ACP client's
  defensive `session/request_permission` auto-decline. Effort: medium — a new `harnesses/opencode.ts`
  ACP path (or a sibling file) shaped like `devin.ts`, close in size since the `session/update`
  vocabulary (`tool_call`/`tool_call_update`/`agent_message_chunk`/`agent_thought_chunk`/
  `usage_update`) and even field names (`size`/`used` for context window) already match Devin's.
  Risk: medium, specifically because this **replaces a working, fixture-verified harness** rather
  than adding a new one — higher bar than Devin's from-scratch addition, per the brief's own framing.
- **amp/omp — don't switch.** Real fidelity gain would likely be similar in shape (cost, context
  window, resume) but the ACP mode surface is *coarser* than the stdout CLI's own `--approval-mode`
  (2 tiers vs. 3), and — separately from that granularity loss — no live run in this environment ever
  got far enough to observe real tool-call correlation, real cost, or real write-blocking behavior for
  omp specifically. Both problems need to close before this is safe to even prototype: the tier
  collapse is a permanent property of the surface (not fixable by retrying), and the live-behavior gap
  needs a working, non-rate-limited model in this account to close. Revisit when both are addressed.
- **devin — no change.** Already the best-instrumented harness; this research incidentally
  reinforces that `acp-runner.ts`'s general, harness-agnostic shape (mode id sourced from the
  `Harness`'s own static `permissionMap`, not parsed out of `session/new`'s response — see §6) was the
  right call, since two more real agents now use meaningfully different `session/new` dialects
  (`modes` field vs. `configOptions` vs. both) that it already handles without modification.

## 6. If we switch: what changes in the code

**The good news, source-verified:** `acp-runner.ts`'s handshake does **not** need to change for
either opencode's or omp's dialect. The mode id it sends to `session/set_mode` is never parsed out of
`session/new`'s response at all:

```ts
// extensions/acp-runner.ts, the handshake IIFE
const modeId = opts.nativePermission ?? opts.harness.permissionMap?.[opts.permission]?.[0] ?? opts.permission;
```

It comes straight from the `Harness` object's own static `permissionMap` — so opencode's
`configOptions`-only response (no `modes` field) and omp's `modes`-field response are both already
handled identically, for free, because the runner never looks at either. This is exactly the kind of
dialect difference the brief asked to check for, and the answer is: `acp-runner.ts` already
generalizes past it.

What a real switch would touch:

- **A new ACP-transport harness file** per agent (e.g. `harnesses/opencode.ts` gaining
  `transport: 'acp'` and an ACP `buildArgs`/`parseLine`, or a sibling file if stdout and ACP paths
  need to coexist during the transition — recommended, given §5's open question, so the existing
  fixture-verified stdout path keeps working while the ACP path is proven out). Shape: near-identical
  to `devin.ts`'s `translateUpdate` — same `session/update` kind vocabulary, same `toolCallId`
  correlation pattern, same `size`/`used` field names for context window off `usage_update`. The one
  addition over Devin's translator: reading `usage_update.cost.amount` into `totalCostUsd` (Devin
  never reports cost; opencode/omp do, at least structurally).
- **`permissionMap`**: `{readonly: ['plan'], edit: ['build'], danger: ['build']}` for opencode (same
  collapse the stdout `AGENT_MAP` already has); `{readonly: ['plan'], edit: ['default'],
  danger: ['default']}` for omp (a real narrowing from stdout's three distinct native tokens, and the
  reason §5 says don't build this yet).
- **`registry.ts`**: either replace the existing `opencode: opencodeHarness` entry outright (risky per
  §5 — this is the "switching a working harness" case, not "adding a fifth") or introduce it under a
  distinct name for side-by-side testing before flipping the default — recommended given the one open
  behavioral question.
- **Fixtures**: `tests/fixtures/opencode-acp.jsonl` (added this session, 40 lines) is a real starting
  point; closing §4's open question needs a second fixture capturing a genuine `build`-mode edit.
  `tests/fixtures/amp-acp.jsonl` (added this session, 14 lines) documents the protocol shape honestly
  but contains no real tool-call/usage/cost data — not sufficient on its own to build a parser against;
  needs a working, non-rate-limited omp model to recapture before any implementation work.
- **Templates** (`templates/opencode/*.md`): unaffected structurally — normalized `permission`
  frontmatter is unchanged; only the harness's own binary/args/parser change underneath it.
- **`extensions/harnesses/amp.ts`**: no changes recommended at all right now — see §5.

## 7. Open questions / what could not be verified

- **opencode `build` mode's actual write-permission behavior.** Does it silently auto-execute a
  write, or does it call back `session/request_permission` (which this project's defensive ACP client
  would auto-decline, silently neutering the `edit`/`danger` tiers)? Only `plan` mode was tested
  against a write attempt; `build` mode was only ever exercised with read-only prompts. This is the
  single blocking unknown for §5's opencode recommendation.
- **omp's real tool-call correlation, cost population, and write-blocking behavior — all
  unverified live**, purely due to account/billing exhaustion in this environment (monthly quota on
  the default model, insufficient OpenRouter credits on the Anthropic-routed fallback, a timeout on a
  free-tier fallback). Everything claimed about omp beyond the raw JSON-RPC handshake and
  `session/set_mode` validity is inferred from opencode's behavior plus the shared-implementation
  evidence in §2, not independently observed for omp itself.
- **The ACP `authenticate` method** was never exercised for either agent — both machines here already
  had valid local credentials (`opencode auth login`, omp's `~/.omp` state), so the handshake never
  needed it. Unverified: what a cold machine with no prior login sees.
- **`numTurns` semantics** — never observed populated in any opencode or omp response (stayed absent
  throughout). Devin doesn't report it either; whether that's a shared spec gap or two independent
  implementation choices wasn't checked against the spec text itself.
- **codex `app-server`'s protocol in any depth** — deliberately not explored past `--help`, per the
  brief ("do not build anything on that; just say what it is").
- **omp's model catalog and Anthropic routing are OpenRouter-only in this account's config** — worth
  independently confirming whether that's this account's specific setup or omp's general default,
  since it directly caused two of the three failed captures.
