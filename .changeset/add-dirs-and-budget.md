---
"pi-harness-delegate": minor
---

`addDirs` end to end: extra directories the harness may access can now come from the `delegate` tool's `addDirs` parameter, a repeatable `/delegate --add-dir=<path>` flag, or an `addDirs:` template frontmatter key (merged, resolved against the working directory, and validated). Harnesses without the capability (`opencode run`, `codex exec resume`) keep ignoring them as before.
