# Assessment — ACP support across the five harnesses

**Status:** research note · **Written against:** `pi-harness-delegate` 0.5.0 (`2248e95`), `claude 2.1.251`,
`codex-cli 0.150.1`, `opencode 1.18.16`, `omp 17.2.9`, `devin 3000.6.7 (260a97c8)`

Question: for each of the five harnesses, does it support [ACP](https://agentclientprotocol.com)
(Agent Client Protocol — JSON-RPC 2.0 over stdio, bidirectional)? Same standard as
`docs/devin-acp-harness-design.md`: verify by running it, not by reading docs. Two harnesses shipped
with `buildArgs` that were pure fiction until real captures exposed them (#13); the Devin design
note's own central warning turned out to be wrong (see its §8 errata). This note follows the same
discipline.

**Reframed mid-assessment, per the user:** the original brief asked "switch or don't switch" per
harness. A better framing surfaced partway through — for any harness that supports *both* a stdout
mode and ACP, **support both, selectable per harness via config**, rather than an all-or-nothing
replacement. "Switch" and "don't switch" become special cases of that (harnesses with only one
working transport have nothing to select between). §5 and §6 are written against this framing; §1–4
are the same evidence gathered under the original brief and stand unchanged.

**Verdict, up front:** `claude` and `codex` have no ACP surface at all — confirmed by reading their
full `--help` output, not just re-trusting an earlier probe. `opencode acp` and `omp acp` are both
real, and both were driven end-to-end with a genuine capture. `devin` already ships, ACP-only (no
stdout mode exists to select between). Nothing here recommends defaulting any dual-capable harness to
ACP today, but opencode is close to worth *offering* as an opt-in — see §5.

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

**Usage accumulates server-side, keyed by session — not per-process.** The same cross-process resume
run gives real evidence, not just an inference, on whether a harness would need to sum `usage_update`
across steps the way the current stdout `opencode.ts` sums `step_finish` events. Process A's turn
ended at `usage: {inputTokens: 70896, outputTokens: 12, totalTokens: 71164, cachedReadTokens: 256}`;
process B — a *completely separate process* — sent one small follow-up prompt and ended at
`{inputTokens: 275, outputTokens: 8, totalTokens: 71195, cachedReadTokens: 70912}`. The total grew by
only 31 tokens for a whole new prompt+response, and `cachedReadTokens` jumped to nearly all of process
A's total — i.e. the session's running token count lives server-side against the `sessionId`, not in
the spawned process, and each `usage_update`/prompt-result already *is* the running session total, not
a per-step delta. A harness translator would need to **latch the latest value, not sum a series** —
simpler than the current stdout accumulator, and a real behavioral difference worth stating as a
concrete "loss" if that accumulation logic were ported over unchanged (see §5).

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

(`transport` here means "what was captured/exists," not a recommendation — §5 covers what to
actually offer per harness.)

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

**Does it advertise `modes`?** This is now the single most important input to this section (per
parallel research into `acp-runner.ts` itself — see the callout below), since "no `modes` field"
does not mean "no permission model": **opencode does not** advertise the spec's `modes` field in
`session/new` at all (only its own `configOptions`, category `"mode"`) — **omp does**, the spec-
standard `{availableModes, currentModeId}` shape, *alongside* the same `configOptions` opencode uses.
Despite that difference, both agents were live-confirmed to implement the `session/set_mode` RPC
method correctly regardless of whether they advertise it via `modes` — see the callout.

> **Callout — a real bug in our own `acp-runner.ts`, and why it doesn't change any finding here.**
> Parallel research (not this session's) found that `acp-runner.ts` sends `session/set_mode`
> **unconditionally** during the handshake, but per spec `Agent.setSessionMode` is *optional* and
> `NewSessionResponse.modes` is nullable — an ACP agent that implements neither would have its whole
> run fail mid-handshake rather than degrade gracefully, and — since it happens before
> `session/prompt` — that failure would look exactly like "this agent's ACP doesn't work," when
> the bug is ours. **This did not affect anything in this document.** Every capture here was driven
> by a small standalone JSON-RPC client (§1), not by `acp-runner.ts` — deliberately, so the capture
> wasn't shaped by what the runner assumes — and, independently of that, both opencode and omp were
> *live-tested* calling `session/set_mode` directly and both accepted a valid modeId and rejected a
> bogus one (§2). So even had these captures gone through the real (buggy) runner, neither would have
> failed here. The bug is real and worth fixing (in its own PR, not this docs-only one — noted in §7),
> but it is not why any omp capture failed in this session; those failures were account/billing (§2).
> It does matter for §6's design sketch: a runner that probes `agentCapabilities`/`session/new`'s
> response before deciding whether to call `session/set_mode` at all is the more correct general
> shape, not just a fix for this one bug — the ACP spec has grown purely additively since 1.0 (still
> wire `protocolVersion: 1`), so cross-agent dialect gaps are much more likely to be *optional
> features one agent implements and another doesn't* than genuine incompatibilities.

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

## 5. Recommendation: a configurable transport, not a switch

Per the reframe (top of this note): for a harness that has a working transport today, ACP is best
treated as an **opt-in alternative selectable per harness in config**, not a replacement. That
dissolves most of the "switching a working, fixture-verified harness" risk the original brief warned
about — ACP becomes something a user turns on for one harness, with the verified stdout path staying
the default and the fallback, so a future dialect quirk degrades to "set it back to stdout" rather
than "the harness is broken." The permission-tier analysis in §4 still gates everything: **a harness
whose ACP tiers can't be mapped faithfully should not even be offered as a config option**, let alone
defaulted to — a configurable transport must not become a way to quietly opt into a weaker permission
model.

- **claude — nothing to configure.** No ACP surface exists.
- **codex — nothing to configure.** No ACP surface exists; `app-server` is a different,
  codex-proprietary protocol and building against it would mean reverse-engineering a second protocol
  from scratch, the exact problem ACP exists to avoid. Revisit only if Codex ships real ACP support
  upstream.
- **opencode — worth offering as an opt-in, not yet, not as default.**
  - **Gains from ACP** (concrete, all `null` or absent over stdout today): real `cost` per turn
    (structurally real even though `$0` was observed — see §2), a real 200k `contextWindow` (stdout
    reports `null`), and resume independently proven to genuinely recall cross-process state (stdout's
    `--session` flag has never been fixture-proven to actually recall anything — this is the first time
    either mechanism was proven end-to-end for this harness). Bonus: the ACP usage accounting is
    **simpler** to implement correctly, not just richer — it's a server-side running total keyed by
    session (§2's cross-process evidence), so a translator only ever needs to latch the latest
    `usage_update`, not sum a series the way `opencode.ts`'s `step_finish` accumulator does today.
  - **Losses from ACP, stated plainly, not just gains:** the stdout harness's own step-by-step
    accumulation (`hs.costAccum`, `hs.stepCount`, etc.) would become dead code, which is a
    maintenance loss on paper but not a fidelity loss given the point above. More concretely: `model`
    and `numTurns` are *weaker* over ACP — the final result never confirms what model actually ran
    (only the *requested* `configOptions` value from `session/new`, no Devin-style confirmation
    event), and `numTurns` was never observed populated at all, whereas stdout's `step_finish` count
    gives a real (if differently-defined) turn count today.
  - **Permission tiers: no loss versus what ships today**, but one open, closeable question — see §4
    (`build`-mode write behavior under the ACP client's defensive permission-decline is untested).
  - **Recommendation:** build the ACP path behind a per-harness config option, default `stdout`,
    once that one question is closed with a single more live run. Do not default to `acp` even after
    that — let it earn trust as an opt-in first, consistent with §6's default-selection reasoning.
- **amp/omp — don't even offer it as a config option yet.** Two independent problems, not one:
  - **Gains from ACP, if it worked:** likely a real `contextWindow` (1,000,000 was seen once, on a
    failed turn) and possibly real `cost` (schema supports it, never observed populated). **Not** a
    tool-call-id gain — the *current* stdout `amp.ts` already has real `toolCallId` correlation, so
    ACP brings no improvement there even in principle.
  - **Losses from ACP — structural, not just unverified:** the stdout CLI's `--approval-mode` gives
    3 genuine tiers (`always-ask`/`write`/`yolo`); ACP's mode surface gives only 2
    (`default`/`plan`). This is a permanent property of the ACP surface as it exists today, not a gap
    that one more live run closes.
  - **Recommendation:** because of §4's gate, `transport: 'acp'` should not even be a *legal* config
    value for amp/omp yet — offering it, even opt-in, would let a user pick a config value that
    silently drops the `edit` tier's distinct semantics. Revisit only if a future omp ACP version
    exposes a third tier (e.g. an `approval-mode`-shaped `configOptions` category, the same slot
    `thinking` already occupies today) — until then this is a `supportsTransports: ['stdout']`
    harness in §6's terms, ACP capability notwithstanding.
- **devin — no change.** ACP-only; no stdout mode exists to select between, so the "configurable
  transport" question doesn't apply. This research incidentally reinforces that `acp-runner.ts`'s
  general, harness-agnostic shape (mode id sourced from the `Harness`'s own static `permissionMap`,
  not parsed out of `session/new`'s response — see §6) was the right call, since two more real agents
  now use meaningfully different `session/new` dialects (`modes` field vs. `configOptions` vs. both)
  that it already handles without modification.

## 6. Design sketch: per-harness transport selection

Sketched against the real files, not abstractly. The goal is a config-driven choice per harness,
gated by what that harness actually, verifiably supports (§4/§5) — never a silent default into a
weaker permission model.

### Config shape

`HarnessConfig` (`extensions/config.ts`) already carries per-harness `model`/`timeoutMs`/
`allowDangerous`/`maxBudgetUsd`. `transport` slots in the same way:

```ts
export interface HarnessConfig {
  model?: string;
  timeoutMs?: number;
  allowDangerous?: boolean;
  maxBudgetUsd?: number;
  transport?: 'stdout' | 'acp';   // new — overrides the harness's default transport
}
```

```jsonc
// ~/.pi/agent/settings.json
{ "delegate": { "harnesses": { "opencode": { "transport": "acp" } } } }
```

`loadConfig()` already has the parsing pattern for every other per-harness field (`cfg.harnesses[k] =
{...}`); `transport` needs no new plumbing there beyond validating the two allowed string values.

### The one call site — and why it doesn't need to grow much

`harness.transport` is read in exactly one place today, `extensions/index.ts:603`:

```ts
result = harness.transport === 'acp' ? await runAcpHarness(baseRunOpts) : await runHarness(baseRunOpts);
```

For a dual-capable harness this becomes a resolved choice — config override, falling back to the
harness's own default — checked against what the harness actually declares it can do:

```ts
const transport = config.harnesses[harnessName]?.transport ?? harness.transport ?? 'stdout';
if (!(harness.supportsTransports ?? [harness.transport ?? 'stdout']).includes(transport)) {
  throw new Error(
    `delegate.harnesses.${harnessName}.transport is "${transport}", but ${harnessName} only supports: ` +
    (harness.supportsTransports ?? ['stdout']).join(', '),
  );
}
result = transport === 'acp' ? await runAcpHarness({...baseRunOpts, harness: acpView(harness)}) : await runHarness(baseRunOpts);
```

That validation must run **before** `acquireSlot()`/spawn (fail-fast, not at spawn time) — e.g.
configuring `transport: 'acp'` for `claude` should error immediately with a clear message, not
attempt to spawn `claude acp` and surface a cryptic "unknown subcommand" from the child process.
`detect()` itself doesn't need to change — it already answers "is the binary there," a separate
question from "does this transport exist for it"; `supportsTransports` is the new, static, per-harness
fact `detect()` doesn't currently need to probe for, since §2 already established it by hand
(`claude`/`codex`: `['stdout']` only; `opencode`/`omp`: `['stdout', 'acp']` once built; `devin`:
`['acp']` only).

### Two `buildArgs`, two parse paths — and a real `permissionMap` collision

A dual-capable `Harness` can't reuse today's single-purpose fields, because the two transports don't
just differ in shape, they differ in *vocabulary*:

```ts
interface Harness {
  buildArgs(opts): string[];              // stdout CLI args (unchanged meaning)
  buildAcpArgs?(opts): string[];          // new — spawns the ACP server, e.g. ['acp']
  parseLine(line, state): ParseOutcome;   // stdout JSONL parser (unchanged meaning)
  parseAcpLine?(line, state): ParseOutcome; // new — session/update -> ParseOutcome, devin.ts-shaped
  permissionMap?: Record<NormalizedPermission, string[]>;    // stdout CLI-flag fragments
  acpPermissionMap?: Record<NormalizedPermission, string[]>; // new — ACP mode ids
  transport?: Transport;              // default transport when config doesn't override
  supportsTransports?: Transport[];   // new — the ceiling config validation checks against
}
```

`permissionMap` splitting into two is not theoretical — the two vocabularies are simply different
strings for amp/omp:

| tier | stdout `permissionMap` (`--approval-mode`) | ACP `acpPermissionMap` (`session/set_mode`) |
| --- | --- | --- |
| readonly | `always-ask` | `plan` |
| edit | `write` | `default` |
| danger | `yolo` | `default` |

For opencode the two vocabularies happen to *coincide* (`plan`/`build` are both the CLI agent name
and the ACP modeId) — but that's a coincidence of this one agent's naming, not something to design
around; a single shared map would break the instant amp/omp (or a sixth harness) needs to be dual, so
the two-field shape should exist even where day-one values happen to match.

`acp-runner.ts` itself needs **no changes** for this — confirmed by reading it, not assumed. It
already sources the mode id purely from the `Harness` object it's given
(`opts.harness.permissionMap?.[opts.permission]?.[0]`, `acp-runner.ts`'s handshake IIFE), never from
`session/new`'s response. So a small adapter that presents an ACP-shaped view of a dual harness
(`buildArgs -> buildAcpArgs`, `parseLine -> parseAcpLine`, `permissionMap -> acpPermissionMap`) before
handing it to `runAcpHarness` is enough — `acp-runner.ts` and `runner.ts` both stay exactly as they
are, only `index.ts`'s one call site and the harness modules themselves change.

One more thing `acp-runner.ts` should eventually change, flagged by parallel research and *not* fixed
here (docs-only, belongs in its own PR): it currently calls `session/set_mode` unconditionally, but
that RPC is spec-optional. A capability-aware handshake — check `agentCapabilities`/`session/new`'s
response for mode/config-option support before calling it, per the ACP spec's additive-only growth
since 1.0 — is the more correct general shape regardless of this specific bug, and would matter more
as more ACP agents with differing optional-feature support get added (see §4's callout, §7).

### Default: stdout, always — ACP opt-in only where §4 clears it

**Recommendation: every harness defaults to `stdout`.** ACP becomes a legal, offerable config value
only for a harness where §4's permission-tier analysis is clean (opencode, once its one open question
closes) — never where the analysis found a structural gap (amp/omp, today). This is deliberately
conservative: the fidelity gains (cost, context window, resume) are real but secondary to permission
correctness, and a config knob that's easy to flip should never be the thing standing between a user
and an accidentally-weaker sandbox. `supportsTransports` from the previous section is exactly the
mechanism that keeps amp/omp's `transport: 'acp'` from being a legal value at all until that changes.

### What's still real work, unchanged from the original brief

- **Fixtures**: `tests/fixtures/opencode-acp.jsonl` (40 lines, this session) is a real starting point
  for `parseAcpLine`; closing §4's open question needs a second fixture capturing a genuine
  `build`-mode edit. `tests/fixtures/amp-acp.jsonl` (14 lines, this session) documents the protocol
  shape honestly but has no real tool-call/usage/cost data — not sufficient to build a parser against;
  needs a working, non-rate-limited omp model to recapture.
- **Templates** (`templates/opencode/*.md`): unaffected — normalized `permission` frontmatter already
  describes tiers abstractly; only the resolved harness's args/parser differ underneath per transport.
- **`registry.ts`**: no change in shape — still one `Harness` object per name; it just gets richer per
  the fields above for the harnesses that end up dual-capable.

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
- **`acp-runner.ts`'s unconditional `session/set_mode` call and unchecked `protocolVersion`** — real
  bugs found by parallel research (not this session's captures), verified against `main`, not fixed
  here (docs-only scope; belongs in its own PR). §4's callout covers why neither affected any finding
  in this document — both opencode and omp were independently live-tested calling `session/set_mode`
  directly and both accept it regardless of whether they advertise the spec's `modes` field. Still
  unverified: what a *third* ACP agent that implements neither `modes` nor `session/set_mode` at all
  (both spec-optional) would do against the current unconditional call — none of the two agents
  reachable in this environment happens to be that case, so it couldn't be exercised here.
- **Whether a genuinely no-permission-model ACP agent exists at all** — every agent seen here
  (Devin, opencode, omp) has *some* mode/config-option mechanism. Whether an ACP agent with no
  permission surface whatsoever is common enough to design `supportsTransports` around wasn't
  checked against the spec or against any third implementation.
