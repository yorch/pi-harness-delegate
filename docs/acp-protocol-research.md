# ACP protocol and ecosystem research

**Status:** research · **Written:** 2026-08-30, against schema `v1` release `1.21.0` (2026-08-20) / TS SDK
`@agentclientprotocol/sdk@1.4.0` (2026-08-20)

Scope note: this doc covers the protocol and ecosystem layer above any one harness. It does not touch
extension code, does not run any harness CLI, and does not overlap with the concurrent per-harness ACP
capture work (`docs/acp-harness-assessment.md`, a different branch). Grounded in this repo's actual
implementation — `extensions/acp-runner.ts`, `extensions/harnesses/devin.ts`,
`docs/devin-acp-harness-design.md` (incl. its §8 errata), `tests/fixtures/devin-acp.jsonl`.

## What was read, and how

Per this project's standing rule (documentation has been wrong about ACP before — Devin's undocumented
`session/set_mode` requirement, see the design note's §8), everything load-bearing here traces to the
**schema JSON or SDK source**, not prose:

- `schema/v1/schema.json` and `schema/v1/meta.json` fetched from `github.com/zed-industries/agent-client-protocol@main` (2026-08-30) — the canonical, currently-generated JSON Schema and method-name registry for wire protocol version 1.
- `schema/v2/schema.json` / `meta.json` (same repo, `v2` draft) for the upcoming breaking revision.
- `schema/v1/CHANGELOG.md` / `schema/v2/CHANGELOG.md` for the dated, PR-linked history of every schema change.
- `npm pack @agentclientprotocol/sdk@1.4.0` (current) and `npm pack @zed-industries/agent-client-protocol@0.4.5` (the old, now-superseded name — kept in the comparison specifically because it is what a search would find first, and it is stale) — read `typescript/acp.ts` (the `Agent`/`Client` TS interfaces, i.e. the actual method surface a TS implementation must satisfy) and `typescript/schema.ts` / `dist/schema.d.ts` directly, not the generated docs.
- `agentclientprotocol.com` pages fetched for prose context (governance, agents/clients registry, v2 draft announcement, MCP-over-ACP RFD, `_meta` propagation RFD) — used only for framing and adoption lists, never as the source of a schema claim without cross-checking the JSON.

**First finding, before any protocol content:** the npm package this repo's own header comment implicitly
points at (`@zed-industries/agent-client-protocol`) is a dead end. It was renamed to
`@agentclientprotocol/sdk` and the last `@zed-industries` publish (`0.4.5`, 2025-10-02) is **~11 months and
dozens of schema releases behind** the current spec — it predates `sessionCapabilities`, `session/list`,
`session/delete`, `session/resume`, `session/close`, `logout`, elicitation, and session config options
entirely. Diffing the old package against the live `schema/v1/schema.json` is what surfaced most of
§3 below. Anyone reaching for "the npm package" to check ACP's shape today needs `@agentclientprotocol/sdk`,
not the old name — a stale-but-still-installable package is a sharper trap than a 404.

## 1. What ACP is

The Agent Client Protocol standardizes the channel between a **client** (an editor, IDE, or — as here — a
headless orchestrator like this extension) and an **agent** (a coding-assistant process): session
lifecycle, prompt turns, streamed progress, permission requests, and optional filesystem/terminal
delegation, over JSON-RPC 2.0, newline-delimited, normally on stdio (`initialize` → `session/new` →
`session/prompt`, this repo's `extensions/acp-runner.ts` implements exactly this).

**Precise distinction from MCP:** MCP (Model Context Protocol) is the interface between an **agent and its
tools/data** — a model-side integration surface ("give the agent this tool, this resource, this prompt
template"). ACP is the interface between an **agent and the program driving it** — a UI/orchestration
surface ("start a session, stream me what you're doing, ask before you do something risky, tell me when
you're done"). They are adjacent, not overlapping: an ACP `session/new` request literally carries an
`mcpServers` array (`NewSessionRequest.mcpServers`, `schema/v1/schema.json`) — the client tells the ACP
agent which MCP servers to connect to for that session, so a single agent process typically speaks MCP
*downward* to its tools while speaking ACP *upward* to whatever launched it. There's an active RFD,
["MCP-over-ACP"](https://agentclientprotocol.com/rfds/mcp-over-acp), proposing to let MCP traffic tunnel
through an already-open ACP channel (`mcp/connect`/`mcp/message`/`mcp/disconnect`) instead of requiring a
separate stdio/HTTP process per MCP server — draft status, not implemented in the schema I read.

This is also the answer to "why isn't codex's `mcp-server` subcommand the same thing as ACP": `codex
mcp-server` exposes Codex **as an MCP tool** that some other MCP client can call — a single
request/response tool invocation, no session, no streamed progress, no permission handshake, no modes.
`codex` as an ACP agent (via Zed's adapter, see §5) exposes Codex as an **interactive session** — the thing
this extension's `devinHarness` talks to. Same binary, two different roles depending on which protocol
wraps it; neither is a subset of the other.

## 2. Spec status: versions, negotiation, stability, cadence

**Wire protocol version is a small integer, decoupled from the schema's own semver.** `initialize`'s
`protocolVersion` field is `number`; the only value that has ever shipped is `1`
(`PROTOCOL_VERSION = 1` in every SDK generation I read, oldest to newest). The *schema* backing that
integer is independently semver'd and has moved from `1.0.0` to **`1.21.0`** (2026-08-20) purely through
additive, backward-compatible changes — new optional fields, new capability flags, new optional methods —
none of which bump the wire integer. Confirmed by `schema/v1/meta.json`'s `"version": 1` staying fixed
across the entire `CHANGELOG.md` history and by the schema's own tolerant-deserialization markers
(`x-deserialize-default-on-error: true` on nearly every new capability field — an old client parsing a
newer agent's response is *designed* to fall back to a default rather than fail to parse).

**Negotiation contract, verbatim from the schema** (`InitializeResponse.protocolVersion`, `schema/v1/schema.json`):
> "The protocol version the client specified if supported by the agent, or the latest protocol version
> supported by the agent. The client should disconnect, if it doesn't support this version."

So: client sends its highest supported integer in `initialize`; agent echoes it back if it can, or
substitutes its own highest; the client is obliged to check and disconnect on mismatch — this is a
**should**, not enforced by the transport, and nothing stops a client from ignoring it and finding out the
hard way later (see §4).

**Stability tiers exist and are explicit in the schema, not just prose.** Two parallel schema files ship
per version — `schema.json` (stable, spec-guaranteed) and `schema.unstable.json` (includes fields still
behind feature flags) — and individual fields/methods carry `**UNSTABLE**` doc comments
(`setSessionModel`/`SetSessionModelRequest` in the TS SDK; session compaction as of 1.21.0). The
CHANGELOG's own vocabulary — "stabilize elicitation", "stabilize terminal authentication", "stabilize
boolean session config options" — shows a real promote-from-unstable pipeline, not a single stable/beta
split.

**Cadence: fast and still accelerating, not winding down.** 21 schema-v1 releases from 1.0.0 to 1.21.0,
several with multiple PRs, the most recent (1.21.0) dated 10 days before this research (2026-08-20). The
TS SDK package hit its own `1.0.0` on 2026-06-24 and is now at `1.4.0`, tracking schema releases roughly
1:1 by date. GitHub commit history at the time of writing (2026-08-30) shows daily activity. This is an
actively-developed spec, not a settled one.

**Governance, because it bears on durability (§7):** the project moved from a Zed-only repo/npm namespace
to `github.com/agentclientprotocol` / `@agentclientprotocol/*`, jointly governed by **Zed and JetBrains**
(partnership announced Oct 2025) — two lead maintainers (one per company) with unilateral veto, a core
maintainer group voting bi-weekly, and an RFD process for smaller proposals. An "ACP Registry" (directory
of compatible agents) launched around Jan 2026. This is no longer a single-vendor protocol; it reads as
a genuine attempt at an LSP-style cross-vendor standard, with two large, differently-incentivized backers.

## 3. Method surface: what the spec defines, what we implement, and the verdict

Read from `typescript/acp.ts`'s `Agent`/`Client` interfaces (the TS SDK's own contract) and
`schema/v1/schema.json`'s `AGENT_METHODS`/`CLIENT_METHODS` (`meta.json`). `?` methods are optional per the
TS interface — an agent/client is spec-compliant without implementing them.

### Agent methods (client → agent)

| Method | Required? | We implement? | Verdict |
| --- | --- | --- | --- |
| `initialize` | yes | yes | **use** — core handshake |
| `session/new` | yes | yes | **use** — core handshake |
| `session/prompt` | yes | yes | **use** — the actual work |
| `session/cancel` | notification, agent-optional to honor gracefully | **no** | **risky-if-added-carelessly, currently fine as-is** — see §4 |
| `authenticate` | required only if agent advertises `authMethods` | **no** | **skip for now, gap noted** — see §4 |
| `logout` | optional (`AgentAuthCapabilities.logout`) | no | **skip** — no interactive session to log out of |
| `session/load` | optional (`loadSession` capability) | yes | **use** — resume path |
| `session/resume` | optional (`sessionCapabilities.resume`) | no | **low-priority future** — lighter-weight resume without history replay; marginal benefit here since `promptSent` gating already discards replayed content (see §4) |
| `session/close` | optional (`sessionCapabilities.close`) | no | **skip** — our process-per-run model already tears the whole child down on finish; explicit close is moot |
| `session/list` | optional (`sessionCapabilities.list`) | no | **skip** — we track sessions in our own transcripts already |
| `session/delete` | optional (`sessionCapabilities.delete`) | no | **skip** — same reason |
| `session/set_mode` | optional (`?` on `Agent`) | yes, **unconditionally** | **use, but currently unsafe for a general transport** — see §4, the highest-severity finding in this doc |
| `session/set_config_option` | optional (`SessionConfigOptionsCapabilities`) | no | **worth investigating** — see §4/§8, may be the real fix for Devin's model-selection hack |
| `setSessionModel` | **UNSTABLE**, may change/vanish | no | **skip** — explicitly unstable in the SDK itself |

### Client methods (agent → client) — these are the ones we must answer

| Method | Required? | We implement? | Verdict |
| --- | --- | --- | --- |
| `session/update` (notification) | yes | yes | **use** — this is the entire streaming/activity feed |
| `session/request_permission` | yes | yes | **use** — declines with a `reject_*` option per §4 |
| `fs/read_text_file` / `fs/write_text_file` | optional (`ClientCapabilities.fs`) | declined (capability not advertised) | **skip, correctly** — every harness we run has direct local filesystem access already; no need to proxy through us |
| `terminal/create` / `terminal/output` / `terminal/release` / `terminal/wait_for_exit` / `terminal/kill` | optional (`ClientCapabilities.terminal`) | declined (capability not advertised) | **actively risky if ever added** — terminal execution is not gated by the negotiated session mode; granting it would let a `readonly`-mode agent still get a shell through us. Skip deliberately, not by omission. |
| `elicitation/create` / `elicitation/complete` | optional (`ClientCapabilities.elicitation`) | declined (capability not advertised) | **skip** — mid-turn structured input from a human; we run headless, there's no one to ask |

### Notification-only surface

| Notification | Direction | We implement? | Verdict |
| --- | --- | --- | --- |
| `session/cancel` | client → agent | no | see §4 |
| `$/cancel_request` | either | no | generic JSON-RPC-level request cancellation, orthogonal to `session/cancel`; not needed given our timeout model |

### `session/update` payload kinds we translate vs. drop

`SessionUpdate` (`schema/v1/schema.json`) has 11 variants. `extensions/harnesses/devin.ts`'s
`translateUpdate` handles 5 (`agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`,
`usage_update`) and silently drops the rest via `default: break`:

| Kind | We use it? | Verdict |
| --- | --- | --- |
| `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `usage_update` | yes | **use** — this is `StreamedResult`'s entire data source |
| `user_message_chunk` | no | **skip** — we already know what we sent |
| `plan` | no | **worth adding** — a structured to-do list for complex tasks; would enrich the activity feed cheaply (`ActivityEvent` already has room for a `thinking`-like kind) |
| `available_commands_update` | no | **skip for now** — slash-command discovery matters for interactive UIs, not a one-shot headless prompt |
| `current_mode_update` | no | **low-priority** — lets an agent report it changed its own mode mid-turn; informational only |
| `config_option_update` | no | **skip unless we adopt `session/set_config_option`** (§4/§8) |
| `session_info_update` | no | **skip** — title/metadata bookkeeping, not relevant to a single delegated turn |

## 4. Client obligations — and where `acp-runner.ts` gets it right or wrong

**What a compliant client must do, per the schema:** answer every `id`-bearing request the agent sends
(a request with no reply is a hung agent, by design — nothing else times it out on the agent's side),
respond to `session/request_permission` with a `RequestPermissionOutcome` that references one of the
options it was actually offered, and — if it ever sends `session/cancel` — go on accepting further
`session/update` notifications until the agent's `session/prompt` response actually arrives with
`stopReason: "cancelled"`.

**What `acp-runner.ts` gets right:**

- **Generic default-deny for unknown requests.** `handleServerRequest`'s fallback (`respondError` with
  `-32601`) answers *any* request the agent sends that isn't `session/request_permission` — including
  every method added to the spec since this runner was written (`elicitation/create`, terminal auth
  flows, anything vendor-specific with an `id`). This is the single most important property for a
  general-purpose transport: it degrades safely against protocol growth by construction, rather than by
  needing to be updated every time the spec adds a request type. No hang risk here, confirmed against
  the current 1.21.0 method list.
- **`session/request_permission` handling matches the current `PermissionOptionKind` enum exactly**
  (`allow_once` / `allow_always` / `reject_once` / `reject_always`) — declining via `reject_once` first,
  falling back to any `reject*` kind, else `cancelled`. Correct against `schema/v1/schema.json`'s
  `PermissionOptionKind` as read today.
- **No `clientCapabilities` advertised** (`{}`) is the right call for a headless orchestrator: it tells
  the agent not to expect fs/terminal/elicitation support, and a spec-compliant agent shouldn't ask. The
  fallback above covers the case where one asks anyway.

**What it gets wrong, in order of severity:**

1. **`session/set_mode` is sent unconditionally, but the method is optional.** `Agent.setSessionMode` is
   `?` in the TS interface, and `NewSessionResponse.modes` is explicitly nullable — "Initial mode state
   **if supported by the Agent**." `acp-runner.ts`'s handshake IIFE calls `sendRequest('session/set_mode',
   ...)` regardless of whether `session/new`'s response included a `modes` field, with no guard and no
   fallback. Against Devin this is invisible because Devin implements modes. Against a spec-compliant ACP
   agent that doesn't (a legitimate configuration per the schema — no modes, one fixed behavior), this
   call returns a JSON-RPC method-not-found error, the handshake `await` rejects, the outer `.catch` calls
   `fail(err)`, and **the entire delegation fails** — not degrades, fails — even for a `readonly` request
   that a mode-less agent could have safely honored by just doing nothing risky. This is the concrete,
   evidenced version of the general worry the task asked about: it doesn't hang, but it does misbehave.
   Fix is small: skip `session/set_mode` when `newSession.modes` (or `loadSession`'s equivalent) is
   absent/null.
2. **`initialize`'s negotiated `protocolVersion` is never checked.** `acp-runner.ts` sends
   `protocolVersion: PROTOCOL_VERSION` and awaits the response but never reads
   `initializeResponse.protocolVersion` back. The spec's own text says the client **should disconnect** if
   the agent's answer isn't what it asked for. Today this is harmless — only `1` has ever existed — but
   it's exactly the check that needs to exist *before* a v2-capable agent shows up (§7), because without
   it, a version mismatch will surface as a confusing mid-handshake or mid-parse failure instead of a
   clear "this agent speaks a protocol version we don't support" error.
3. **No `authenticate` support.** Devin's own `initialize` response in the captured fixture advertises
   `authMethods: [{"id":"devin-browser", "name":"Log in with browser", ...}]`; the session happened to
   proceed without needing it. Nothing in `acp-runner.ts` handles the case where `session/new` returns an
   `auth_required` error — it would surface as a raw JSON-RPC error message via the existing generic
   failure path, not a hang, but not a clear message either. Low-severity (no hang, no misbehavior beyond
   an unhelpful error), worth a one-line message improvement if it's ever actually hit.
4. **`session/cancel` is never sent.** On timeout/abort, `acp-runner.ts` goes straight to
   `proc.kill('SIGKILL')`. This is *not* a spec violation — nothing requires graceful cancellation before
   process death, and our timeout/abort model owns the whole child process — but it does mean we never
   exercise the `cancelled` stop-reason path the spec designs for, and any agent-side cleanup that only
   runs on a graceful `session/cancel` (vs. SIGKILL) doesn't happen. Fine as-is given the process-per-run
   model; worth revisiting only if agents start doing meaningful async cleanup work.

None of the above is a hang risk today — the generic-decline design in point 1 of "gets right" prevents
that class of bug even as the spec grows. The set_mode issue (point 1 above) is a **correctness/generality**
risk: it will break on some future non-Devin agent, not on Devin.

## 5. Ecosystem adoption

**Read from `agentclientprotocol.com/get-started/agents` and `/clients` (2026-08-30) — the community-run
ACP registry pages, so treat the counts as a lower bound of what's been submitted, not an exhaustive
census.**

**Servers (agents), ~40 listed**, including this project's Devin plus others directly relevant to this
repo's other harnesses: **OpenCode** and **Codex CLI** (via a Zed-maintained adapter) both appear, plus
**Gemini CLI**, **GitHub Copilot** ("in public preview"), **Cursor**, **Cline**, **Goose**, **OpenHands**,
Docker's **cagent**, and **Junie by JetBrains** (notable given JetBrains' co-governance role) among many
smaller/newer entrants. This repo's other three harnesses (Claude Code, Amp/omp) are not themselves listed
as ACP servers on that page as of this read — `templates/`/`AGENTS.md` describe Amp's own `acp`
subcommand, but the registry snapshot didn't surface it, which is exactly the kind of gap this section is
supposed to flag rather than paper over. **Could not verify** whether Amp's `acp` mode is a recent
addition not yet in the registry, or whether it predates the registry and was simply never submitted.

**Clients (editors/tools), dozens listed**, spanning IDEs (Zed — the originator, JetBrains, VS Code via
several extensions, Neovim, Emacs, Qt Creator, Visual Studio), CLIs/TUIs, desktop apps, notebook tooling
(Jupyter, marimo), and mobile clients. The breadth here — well past "a Zed feature" — is itself a signal:
this reads as genuine cross-vendor interest in ACP as an integration point, not one company's plumbing.

**Direction:** adoption is growing and the pace (daily commits, 21 schema releases in under a year, a
formal cross-company governance structure stood up in the last year, a v2 draft actively soliciting
feedback) points at a protocol its maintainers intend to keep investing in, not one coasting on an initial
burst. **Could not verify** actual usage/traffic numbers (registry listing ≠ active maintenance) for any
individual entry beyond what this repo has itself verified for Devin.

**Competing/overlapping standards:** MCP is adjacent, not competing (§1). A2A (Agent-to-Agent, Google-
originated) is a different layer again — peer agent-to-agent coordination, not client-orchestrates-agent —
and wasn't investigated in depth here as it's out of this project's scope (this project delegates *from* a
single orchestrator *to* single agents; it doesn't need inter-agent coordination). No direct competitor to
ACP's specific niche (editor/orchestrator ↔ coding agent) was found.

## 6. Vendor extensions — `_meta` and underscore methods

**How the spec sanctions extensions**, read from `RequestPermissionRequest`/`NewSessionRequest`/etc.'s
own schema entries (every request/response/notification type carries an `_meta` field) and from the
[`_meta` propagation RFD](https://agentclientprotocol.com/rfds/meta-propagation):

- Every message type has an optional `_meta: { [key: string]: unknown }` — free-form, and per the schema's
  own repeated doc comment: *"Implementations MUST NOT make assumptions about values at these keys."*
  Consumers are required to treat unrecognized `_meta` content as opaque.
- Convention (not enforced by the schema, but stated as guidance) is to namespace `_meta` keys and custom
  method names by reverse-domain or vendor prefix — exactly what Devin does
  (`cognition.ai/inferenceToolName`, `cognition.ai/multiRootWorkspace`, the
  `_cognition.ai/agent_stopped` notification).
- A small set of **reserved root `_meta` keys** exist for cross-protocol interop specifically:
  `traceparent`, `tracestate`, `baggage` — W3C trace-context propagation, so ACP calls can carry
  distributed-tracing context through to MCP tool calls and OpenTelemetry collectors. Not currently used
  by this repo; worth knowing exists if observability is ever added.
- `extMethod`/`extNotification` on both `Agent` and `Client` interfaces are the sanctioned mechanism for
  an entirely custom **method** (not just custom data on a standard method) — "prefix extension methods
  with a unique identifier such as domain name." Devin's `_cognition.ai/agent_stopped` and
  `_cognition.ai/mcp/serversChanged` (seen in the fixture) are exactly this pattern, sent as bare
  underscore-prefixed notifications rather than through `extNotification`'s wrapper — both are consistent
  with "vendor traffic the transport must tolerate," just via slightly different sanctioned mechanisms.

**Assessment of this repo's seam:** correctly placed, and this research didn't find a reason to move it.
`acp-runner.ts` parses only the JSON-RPC envelope (`id`/`method`/`result`/`error`) and hands the full raw
line to `harness.parseLine` for everything else — it never inspects `_meta` or vendor method names itself.
`devin.ts` is where `cognition.ai/*` keys get read (`translateUpdate`'s `meta['cognition.ai/inferenceToolName']`,
`parseDevinLine`'s handling of `_cognition.ai/agent_stopped`). This matches the spec's own model exactly:
the *transport* must tolerate arbitrary `_meta` and arbitrary underscore-prefixed notifications without
choking on them (which `acp-runner.ts` does — unrecognized `method`s with no `id` just fall through
`parseLine`, which for a non-Devin agent would return `{}` and be silently ignored, not crash), while
*interpreting* vendor extensions is inherently harness-specific knowledge that belongs in the harness file.
A second ACP agent with its own `_meta` namespace slots into this exactly the way Devin did, with zero
changes to `acp-runner.ts`.

## 7. Durability and upgrade risk

**What's genuinely low-risk today:** the wire `protocolVersion: 1` pin is correct. v1 is the only
released integer, it's under active, purely-additive development (21 schema releases without a wire bump),
and the ecosystem's own guidance for v2 is explicit — *"v1 remains supported and will not be deprecated
soon... implementers should support both versions concurrently through version negotiation... v1-only
peers will remain common for some time"* (`announcements/acp-v2-draft.md`). Nothing here argues for
touching the pin.

**What would break us:**

- **A future ACP agent whose `session/new` doesn't advertise `modes`.** Already covered in §4 — this is
  the one concrete, fixable-today risk this research found, independent of any spec version bump.
- **ACP v2, if/when it ships.** Read from `announcements/acp-v2-draft.md`, status **Draft**, not released
  as of this research. It's explicitly a breaking revision: `session/update` notifications become legal
  outside a turn (background work), message/tool-call/terminal content moves to unified patch semantics
  with stable IDs, the diff format changes from `oldText`/`newText` to structured operations, permission
  requests decouple from tool calls, and `v2/meta.json`'s method list already differs from v1's
  (`auth/login`/`auth/logout` replacing `authenticate`/`logout`, no separate `session/load` — resume-only
  via `session/resume`). None of this is close to landing — it's a draft soliciting feedback — but when it
  does, `acp-runner.ts`'s current unconditional `1` and unchecked negotiated version (§4, point 2) means
  we'd silently keep speaking v1 shapes to a v2 agent that echoed back `protocolVersion: 2` rather than
  failing cleanly. Not urgent; worth the negotiation check regardless, since it's cheap and closes the gap
  before it matters.
- **The `x-deserialize-default-on-error` pattern is evidence the maintainers designed for exactly our
  situation** (an old client, a newer agent) — new fields default out rather than fail to parse. That
  significantly de-risks staying on an older schema understanding *as long as* we don't misinterpret an
  absent-because-newer field as absent-because-unsupported (the `modes` case in §4 is precisely this
  mistake, just inverted — we're the newer side assuming an old/minimal agent has a field it may not).

**What the negotiation contract actually obliges us to do, restated plainly:** send the highest version we
support (`1`, correctly), read what comes back, and disconnect cleanly if it's not something we understand
— we do the first, skip the second and third. Fixing this is small (one comparison, one clear error
message) relative to the damage an unchecked mismatch could eventually cause.

## 8. Recommendations for this project

Prioritized; effort is relative to this repo's own recent PRs (#21/#23/#24) as a yardstick.

**Worth doing:**

1. **Guard `session/set_mode` on `NewSessionResponse.modes` (and `LoadSessionResponse`'s equivalent)
   being present.** Effort: small. Rationale: §4 point 1 — the one concrete correctness bug found, and it
   only fails to reproduce today because Devin happens to implement modes; it will bite the first
   mode-less ACP agent added.
2. **Check `initializeResponse.protocolVersion === PROTOCOL_VERSION` and fail with a clear message if
   not**, rather than proceeding silently. Effort: small. Rationale: §4 point 2 / §7 — cheap insurance
   against a v2-speaking agent (or any future agent that only supports a version we don't) producing a
   confusing failure instead of an honest one. No urgency, but no reason to wait either — it's a
   self-contained, low-risk change.
3. **Investigate `session/set_config_option` (category `model`) as the real fix for Devin's unwired
   model-selection gap** (`ROADMAP.md` §14: *"Devin's `model` isn't wired over ACP — no verified way to
   set it on this version's ACP surface"*). The schema now has a generalized, category-tagged config
   mechanism (stabilized across 1.14.0–1.18.0) explicitly designed for exactly "model selector" as one of
   its four named categories. Effort: medium — requires a live capture against a Devin build new enough to
   return `configOptions` on `session/new`/`session/load` (**could not verify** whether the currently
   schema-verified `devin 3000.6.7` populates this field; the captured fixture predates or doesn't exercise
   it). This is squarely the concurrent per-harness capture work's territory, not this doc's — flagging the
   mechanism, not attempting the capture.
4. **Translate the `plan` session-update kind into an `ActivityEvent`.** Effort: small. Rationale: cheap,
   additive, and `Plan`/`PlanEntry` in the schema is exactly the kind of structured progress information
   the existing activity feed already displays for tool calls — a natural fit, not a stretch.

**Not worth doing now (explicitly, so it doesn't get "fixed" later without re-litigating):**

- **`fs/*` and `terminal/*` client capabilities.** Every harness this repo runs already has direct local
  filesystem/process access; proxying either through us adds surface area (see §3's "actively risky" note
  on terminal specifically — it bypasses the negotiated permission tier) for no capability we lack today.
- **`elicitation/*`.** Requires a human in the loop; this extension runs headless. Correctly declined by
  the existing generic-deny fallback if an agent ever asks anyway.
- **`session/list`/`session/delete`/`session/close`.** This repo already owns session bookkeeping via its
  own transcript/outputs directory; these would be redundant, second sources of truth.
- **`session/resume` as a replacement for `session/load`.** Marginal: the stated benefit (no history
  replay) is already neutralized by the existing `promptSent` gating, which discards replayed content
  either way. Only worth it if an agent supports `resume` but not `load` — not observed.
- **v2 adoption of any kind.** Draft status, not released, explicitly not meant to obsolete v1 support any
  time soon.

## 9. Open questions / could not verify

- **Whether Amp's `omp acp` subcommand appears in the community ACP registry.** Not found on the registry
  page as read; could be a recency gap (registry submission lag) rather than absence of the feature. The
  concurrent per-harness capture agent is better positioned to confirm this directly against the binary.
- **Whether the `devin 3000.6.7` build this repo's harness was schema-verified against populates
  `session/new`'s `configOptions` field**, and if so with what categories/options. Would directly inform
  recommendation §8.3. Not exercised by the existing captured fixture.
- **Actual real-world usage/maturity of the ~40 registry-listed agent implementations** beyond their
  presence in the registry — a submitted listing is not evidence of active maintenance or protocol
  fidelity. Only Devin has been independently, empirically verified by this project.
- **Whether any currently-shipping agent already negotiates `protocolVersion: 2`** (i.e., whether v2 has
  any real-world implementation yet despite Draft status). Not found; the draft announcement reads as
  pre-implementation.
- **The full content of `protocol/v2/migration.md`** (the implementer migration guide) was not read in
  depth — v2 is not close enough to actionable for this project to warrant the effort right now; revisit
  if v2 approaches a stable release.
