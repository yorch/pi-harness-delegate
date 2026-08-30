---
"pi-harness-delegate": patch
---

Live-verified codex's `exec resume` path end-to-end (a fresh process resuming a session genuinely recalls prior context, not just an echoed session id) and fixed two bugs the verification surfaced:

- `codex.ts`: `buildArgs` no longer appends `--add-dir` when resuming — `codex exec resume` has no such flag and rejects it outright (`unexpected argument '--add-dir' found`).
- `amp.ts`: a `turn_end`/`agent_end` whose failure only shows up as `message.stopReason === "error"` + `message.errorMessage` (observed live on a real 429 quota rejection, where `message.content` is an empty array) is now correctly reported as `isError: true` with the error message as the result text, instead of a silent, empty "successful" run.

Also confirmed `omp`'s `--add-dir` is real and accepted (contrary to earlier research) — no change needed there — and added an opt-in `tests/live.test.ts` suite (`PI_DELEGATE_LIVE=1`) that spawns each detected harness for real and checks the basics a fixture can't: the process runs, a result comes back, `sessionId` is populated, and known-reported metrics are present. Never runs in CI or `bun run verify`.
