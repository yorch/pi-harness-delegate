---
"pi-harness-delegate": patch
---

Fix a batch of review findings:

- **Concurrency slot leak**: a refused `danger` template, or a failing `git diff`/`gh pr diff` scope lookup, no longer leaks a `maxConcurrent` slot for the rest of the pi session. The in-process counter also no longer absorbs other processes' runs.
- **Security**: the `delegate` tool's `allowDangerous` now requires interactive human confirmation (refused with no UI); `sessionId`, `model`, and `pr` are validated so a value can't be injected as a CLI flag; `codex exec resume` and `gh pr diff` pass their positionals after `--`. Transcripts are written owner-only (`0700` dir, `0600` files).
- **Correctness**: runners never spawn for an already-cancelled run and clean up their abort listeners; opencode/amp report cost only when the harness actually reported one (never a fake `$0`); resuming one `sessionId` across a fan-out is rejected up front; run-registry entries are written atomically.
- **Docs**: README documents every flag (`--budget`, `--pr`, …), subcommand, and template frontmatter key, `PI_CODING_AGENT_DIR`, and corrects the fan-out and opencode cost notes; package metadata now mentions Devin.
