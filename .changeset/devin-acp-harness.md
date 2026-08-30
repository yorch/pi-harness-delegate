---
"pi-harness-delegate": minor
---

Add Devin as a fifth harness, over a new general Agent Client Protocol (ACP) transport.

- `extensions/acp-runner.ts` — a sibling to `runner.ts` for harnesses whose `transport` is `'acp'` (bidirectional JSON-RPC over stdio, https://agentclientprotocol.com), exposing the same `RunHarnessOptions`/`HarnessResult` shape so `delegate()` and everything downstream (transcripts, `ToolCallIndex`, progress overlays, fan-out, spend rollup) is unchanged. Devin is its first consumer, not a special case baked into it.
- `extensions/harnesses/devin.ts` — runs `devin acp`, maps `readonly→plan`, `edit→accept-edits`, `danger→bypass`, real `toolCallId` tool-call correlation, a genuine context-window %, and working resume via `session/load`. Reports no `$` cost (`null`) and no turn count — honest, not invented.
- `templates/devin/*.md` mirror the other harnesses' templates.
- The four existing harnesses (claude, codex, opencode, amp) are untouched — `transport` is optional and defaults to their existing behavior.
- `harness: "all"` / a comma-list fan-out picks up Devin automatically once `devin` is installed.
