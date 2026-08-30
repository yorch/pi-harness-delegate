---
"pi-harness-delegate": patch
---

Fix four issues found in code review of the Devin ACP harness (`extensions/acp-runner.ts`, `extensions/harnesses/devin.ts`):

- **Process leak**: a rejected handshake step (bad `session/set_mode` modeId, a JSON-RPC error, a handshake timeout) left the spawned `devin acp` process running indefinitely — every other exit path already killed it, only the handshake's `.catch` didn't. Confirmed live, both ways.
- **Inflated context %**: Devin's `inputTokens` already includes `cachedReadTokens` as a subset, but `StreamedUsage.inputTokens` is supposed to exclude cache reads (Claude's convention) — the mismatch roughly doubled the reported context-window percentage. Fixed and covered by a fixture-driven test asserting the real percentage.
- **Resume replayed the whole prior conversation**: `session/load` replays every prior turn as notifications before the new prompt's; nothing discarded them, so a resumed run's result had the entire previous session prepended. Fixed by gating streamed text/activity forwarding until the new `session/prompt` is actually sent. Verified live: a resumed run now returns only the new turn's answer, while still correctly recalling prior context.
- **`model` echoed as used but silently dropped**: a requested model was written into the transcript as what ran, but was never passed to `devin acp`. `--model` is real (`devin acp --help`) and genuinely changes what runs — now wired, with the reported `model` read back from Devin's own `_cognition.ai/agent_stopped` event rather than echoed from the request, so it reflects what actually ran.
