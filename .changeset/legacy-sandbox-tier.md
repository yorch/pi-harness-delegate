---
"pi-harness-delegate": patch
---

Legacy `sandbox:` template frontmatter now maps codex sandbox values onto the right tier (`read-only` → readonly, `workspace-write` → edit, `danger-full-access` → danger, behind `allowDangerous`), case-insensitively. Previously every codex value fell through to `edit`, so `sandbox: read-only` ran writable and its `verify:` ran host-side. An unrecognized `sandbox:`/`permissionMode:` value now fails closed to `readonly` instead of silently becoming `edit`, with a warning shown in `/delegate list` and on every run (a notification, a `- warning:` transcript line, and a prefix on the result).

Other behavior changes for existing templates:

- `permissionMode:` values are now case- and `-`/`_`-insensitive: `permissionMode: Plan` was `edit`, now `readonly`; `accept-edits`/`bypass_permissions` are recognized (`bypass_permissions` is danger, refused without `allowDangerous`).
- `permissionMode: nope` (any unrecognized value) was `edit`, now `readonly` with a warning.
- An empty `permissionMode:` no longer hides `sandbox:`: `permissionMode:` + `sandbox: danger-full-access` was `edit`, now `danger` (refused without `allowDangerous`).
- The `permission`/`permissionMode`/`sandbox` key names are case-insensitive: `Sandbox: read-only` or `Permission: readonly` were silently ignored (→ `edit`), now honored. A key given more than once takes the least permissive value.
- `permission:` still wins over the legacy keys, but a legacy key that disagrees with it is now flagged with a warning (the tier is unchanged).
