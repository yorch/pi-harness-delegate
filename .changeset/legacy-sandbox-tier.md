---
"pi-harness-delegate": patch
---

Legacy `sandbox:` template frontmatter now maps codex sandbox values onto the right tier (`read-only` → readonly, `workspace-write` → edit, `danger-full-access` → danger, behind `allowDangerous`), case-insensitively. Previously every codex value fell through to `edit`, so `sandbox: read-only` ran writable and its `verify:` ran host-side. An unrecognized `sandbox:`/`permissionMode:` value now fails closed to `readonly` with a warning in `/delegate list` instead of silently becoming `edit`.
