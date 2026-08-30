# Design note — adding Devin as a harness over ACP

**Status:** proposal · **Written against:** `devin 3000.6.7 (260a97c8)`, `pi-harness-delegate` 0.4.1

Devin is not currently a harness (`HARNESSES` in `extensions/harnesses/registry.ts` is `claude`,
`codex`, `opencode`, `amp`). This note scopes what adding it would take, based on **real captured
runs**, not documentation — the same standard that caught codex's and opencode's entirely-broken
`buildArgs` in #13.

## Summary

Devin fits the *data* model better than three of the four existing harnesses, and fits the
*transport* model worse than all four. The parser is the easy half; the runner change is the cost.

## 1. `devin -p` is a dead end

`devin --permission-mode auto -p "<prompt>"` runs headless and exits 0, but stdout is **plain prose
only** — a 296-byte final answer in the capture, no JSON, no tool events, no usage, no session id.
Its help exposes no `--json` / `--output-format` flag (the only JSON string in `--help` is the path
to `~/.config/devin/config.json`). `--export [PATH]` writes a conversation file after each turn, but
that is a file artifact, not a stdout stream the runner can consume line-by-line.

A harness built on `-p` would work — `parseLine` tolerates plain text and `extractResult` synthesizes
from `streamedText` — but under the honest-metrics convention (#11) every metric would render `—`
and the activity feed would be empty. In a fan-out row it would be conspicuously information-poor.

**Rejected.**

## 2. `devin acp` carries everything

`devin acp` runs an [Agent Client Protocol](https://agentclientprotocol.com) server over stdio:
JSON-RPC 2.0, newline-delimited. A real captured session (`initialize` → `session/new` →
`session/prompt`, 93 lines, saved as a candidate fixture) maps almost 1:1 onto `StreamedResult`:

| `StreamedResult` field | ACP source | Captured value |
| --- | --- | --- |
| `result` / `streamedText` | `session/update` → `agent_message_chunk` | 43 chunks |
| activity `thinking` | `agent_thought_chunk` | 8 |
| activity `tool_input` | `session/update` → `tool_call` — `toolCallId`, `title`, `kind`, `rawInput` | 4 |
| activity `tool_result` | `tool_call_update` — **same `toolCallId`** + `status` | 12 |
| `usage` | prompt result `usage` + `usage_update` events | `{totalTokens 66491, inputTokens 66446, outputTokens 45, cachedReadTokens 66124}` |
| `contextWindow` | `usage_update` → `size` (and `used`) | `200000` (used `66012`) |
| `stopReason` | prompt result | `"end_turn"` |
| `sessionId` | `session/new` result | `"cactus-iberis"` |
| `totalCostUsd` | — **absent** | `null` (correct under the honest-metrics convention) |
| `numTurns` | — not directly reported | `null`, or count prompt turns |

Two things stand out:

- **`toolCallId` is a real correlating id.** `ToolCallIndex` (`extensions/activity.ts`) would attribute
  parallel tool results correctly from day one — unlike codex/opencode/amp, which are still on the
  id-less last-entry fallback pending confirmed id field names.
- **`contextWindow` is reported.** Only `claude` provides this today, so Devin would be the only other
  harness with a real `% ctx` figure.

Permission mapping is an *exact* structural match to Claude's. `session/new` returns
`availableModes`: `plan` (Plan), `accept-edits` (Code), `smart` (Smart), `ask` (Ask), `bypass`
(Bypass Permissions).

| Normalized | Devin mode |
| --- | --- |
| `readonly` | `plan` |
| `edit` | `accept-edits` |
| `danger` | `bypass` |

`ask` and `smart` remain available as native escape hatches via the existing `nativePermission`
frontmatter, consistent with how the other harnesses expose theirs.

## 3. Why this is not just a fifth parser

`extensions/runner.ts` is strictly **one-way**: `spawn(binary, buildArgs())` with `stdio: ['ignore',
'pipe', 'pipe']`, then a readline loop feeding `harness.parseLine`. stdin is explicitly `ignore`d.

ACP is **bidirectional and stateful**. A single delegation requires:

1. send `initialize`, await the response (capability negotiation)
2. send `session/new` with `cwd` + `mcpServers`, await the `sessionId`
3. send `session/prompt`, then consume `session/update` notifications until the `session/prompt`
   response arrives carrying `stopReason` and `usage`
4. hold stdin open throughout — **ACP exits on stdin EOF** (confirmed: piping one line and closing
   produced no response at all)

So the runner must *drive* a protocol rather than read a stream. `buildArgs`/`parseLine`/
`extractResult` cannot express that: `buildArgs` has nowhere to put a handshake, and `parseLine` has
no way to send anything.

### Recommended shape: a sibling runner, selected by a declared transport

Add an optional discriminator to `Harness`:

```ts
transport?: 'stdout' | 'acp';   // default 'stdout'
```

and a sibling `extensions/acp-runner.ts` exporting `runAcpHarness(opts)` with the **same**
`RunHarnessOptions` / `HarnessResult` signature as `runHarness`. `delegate()` picks the runner from
`harness.transport`. Everything downstream — `ActivityEvent`, `StreamedResult`, transcripts,
`ToolCallIndex`, the progress overlays, fan-out, spend rollup — is unchanged, because the seam is
*below* `StreamedResult`.

The ACP harness then implements a different, narrower contract (build args; map permission to a
mode; translate one `session/update` into `ParseOutcome` deltas) rather than `buildArgs`/`parseLine`.

**Why a sibling and not a generalized `Harness.run()`:** the four existing harnesses are working and
schema-verified against captured fixtures. A refactor that rewrites their execution path to
accommodate a fifth risks all four for the benefit of one. A sibling runner touches none of them.
The cost is two runners to maintain; that is the right trade here.

**Rejected alternative — an ACP→JSONL shim.** A wrapper that drives ACP and re-emits newline JSON
into the existing `parseLine` would avoid a second runner, but it hides a stateful protocol behind a
stream abstraction that cannot express failure of the handshake, and it still needs the bidirectional
process management. It buys nothing real.

## 4. Operational obstacles (both found by running it, not reading about it)

**Workspace trust.** Devin refuses to run in a directory not interactively trusted:

```
Error: Refusing to run in an untrusted workspace: <path>
Start `devin` interactively in this directory to trust it, or set
`respect_workspace_trust: false` in your config to restore the previous behavior.
```

This is fatal for a tool that spawns in arbitrary `ctx.cwd`. **The error message names the wrong
key**: `respect_workspace_trust` is the CLI/env name (`RESPECT_WORKSPACE_TRUST`); the *config* field
in the binary's own serde field list is `skip_workspace_trust`. Setting the documented key silently
does nothing — verified by `strings` on the binary after the documented fix failed. Trusted paths are
recorded in `~/.local/share/devin/cli/trusted_workspaces.json`.

**This extension must not silently disable that gate.** It is a security control, and turning it off
on a user's behalf — in every repo they ever delegate into — is not ours to do. `detect()` should
surface it as a hint (`workspace not trusted — run \`devin\` here once, or set skip_workspace_trust`)
and the run should fail with that message rather than being worked around.

**Process lifecycle.** stdin must stay open for the session's lifetime, and the process killed on
abort/timeout. The existing SIGKILL-on-abort path in `runner.ts` carries over, but `stdio[0]` becomes
`'pipe'` rather than `'ignore'`.

## 5. Effort and risk

| Piece | Effort | Risk |
| --- | --- | --- |
| `transport` discriminator + runner selection in `delegate()` | small | low — additive, default unchanged |
| `acp-runner.ts` (handshake, request/response correlation, notification loop, abort/timeout) | **medium–large** | medium — new process-lifecycle code, the genuinely new part |
| `harnesses/devin.ts` (mode map, `session/update` → `ParseOutcome`, `detect()` incl. trust check) | small–medium | low — schema already captured |
| Fixtures + tests from the captured session | small | low |
| Templates (`templates/devin/*.md`) | small | low |
| Docs (README harness table, AGENTS.md) | small | low |

Roughly one focused PR, dominated by `acp-runner.ts`.

## 6. Recommendation

**Worth doing, but not urgent, and only via ACP.** It adds a fifth harness that is second only to
Claude in metric fidelity, with correct tool attribution and a real context-window figure.

Two arguments for waiting:

1. **Nobody has run a real fan-out yet.** Four harnesses already work; a fifth adds breadth to a
   feature whose day-to-day value is still unmeasured. The existing backlog is deliberately parked
   on exactly this reasoning.
2. **ACP is a spec, not a Devin feature.** Building `acp-runner.ts` makes *any* ACP agent pluggable,
   which is a bigger and more interesting capability than Devin specifically — and a better thing to
   design once, deliberately, than to shape around a single vendor.

If it proceeds: build `acp-runner.ts` as a general ACP transport, with Devin as its first consumer.

## 7. What was verified vs assumed

**Verified by execution** (billed runs, `devin 3000.6.7`, scratch repo): `-p` produces prose only;
ACP `initialize`/`session/new`/`session/prompt` handshake; the 9 `session/update` kinds and their
counts; `toolCallId` correlation between `tool_call` and `tool_call_update`; final `usage` and
`stopReason`; `usage_update` carrying `used`/`size`; the five `availableModes`; the workspace-trust
refusal and that `skip_workspace_trust` is the key that actually works; ACP exiting on stdin EOF.

**Not verified:** resume via ACP (`loadSession: true` is advertised in `agentCapabilities` but was not
exercised); whether cost ever appears (`cognition.ai/totalCreditCost` and `totalAcuCost` exist as
strings in the binary but appeared in no captured event); `numTurns` semantics across multiple
prompts in one session; behaviour of the `review` and `summarizer` `--agent-type` variants; whether
`devin cloud` sessions change the execution model.

## 8. Errata (found during implementation)

**§4's workspace-trust claim was too broad — it does not apply to `devin acp`.** This note's §4 says
"Devin refuses to run in a directory not interactively trusted" and treats that as fatal for a tool
that spawns in arbitrary `ctx.cwd`. That refusal is real, but it's specific to `devin -p` / interactive
`devin` — verified live, twice, against directories `devin` had never seen (no `--config` bypass): the
raw `initialize`/`session/new` ACP handshake succeeded with no refusal and no prompt, in the same test
session where `devin -p` in the exact same directory printed the documented
`Refusing to run in an untrusted workspace` error. The shipped harness (`extensions/harnesses/devin.ts`)
therefore carries no trust-check hint and never touches `skip_workspace_trust` — not because doing so
was rejected as a design choice (§4's reasoning there still holds, if it turns out to be needed), but
because the gate this note worried about never fires on the code path this harness actually uses. If a
future Devin version starts enforcing trust over ACP too, `acp-runner.ts`'s generic non-zero-exit
handling already surfaces whatever refusal message `devin` prints, same as any other process failure.

**Resume works.** `session/load` (sessionId + cwd + mcpServers, same shape as `session/new` minus
minting a new id) round-trips cleanly through a real `runAcpHarness` call: a second process resumed a
session created by a first, replayed its prior turn, and correctly recalled information only given in
that first turn. Wired in `acp-runner.ts` — `opts.resumeSessionId` set sends `session/load` instead of
`session/new`.

**One handshake step this note didn't call out: `session/set_mode`.** `session/new`'s request has no
field for requesting an initial mode — the mode is set with a separate `session/set_mode` call after
session creation. Confirmed by fetching the real `NewSessionRequest`/`SetSessionModeRequest` schemas
(not the docs site, which doesn't show it either) from the `agent-client-protocol` Rust crate on GitHub.

**The agent doesn't exit once a prompt turn completes.** An ACP session can outlive a single
`session/prompt` (resume, follow-up turns) — real-run testing found `session/prompt`'s response
resolving correctly while the process kept idling afterward, so a runner that waits for the process to
exit on its own (the stdout harnesses' pattern) hangs until the outer timeout fires. `acp-runner.ts`
finishes and kills the process itself as soon as the response resolves.
