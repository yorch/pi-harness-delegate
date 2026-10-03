---
"pi-harness-delegate": minor
---

`addDirs` end to end: extra directories the harness may access can now come from the `delegate` tool's `addDirs` parameter, a repeatable `/delegate --add-dir=<path>` flag, or an `addDirs:` template frontmatter key (merged, resolved against the working directory, and validated). A model-supplied tool `addDirs` entry that resolves (after `..` and symlinks) outside the working directory requires interactive confirmation and is refused without a UI. Harnesses without the capability (`opencode run`, `codex exec resume`) keep ignoring them as before.

`maxBudgetUsd` is now enforced (or honestly reported) for every harness: Claude keeps its native `--max-budget-usd`; harnesses that stream a cost but have no budget flag (opencode, amp) are stopped host-side as soon as the reported total exceeds the cap and recorded as `budget exceeded`; harnesses that report no cost (codex, devin) get a clear "not enforced" warning in the result and transcript instead of silently ignoring the cap. Over ACP (opencode), the cap is checked on every streamed `usage_update` (mid-turn, not only after the turn ends), and on a resumed session only the spend since the run started counts — prior turns in opencode's session-cumulative cost no longer trip a small budget.
