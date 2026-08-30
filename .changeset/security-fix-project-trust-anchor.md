---
"pi-harness-delegate": minor
---

Security fix: project-local delegate templates could self-declare trust from inside the very repo they came from.

`loadTemplates()` decided whether to load `.pi/delegate/templates/` by reading `.pi/trusted` from the project itself (or an env var, `PI_TRUSTED=1` / `PI_DELEGATE_TRUSTED=1`, that leaked trust to every directory for the rest of a shell session). A cloned hostile repo could commit `.pi/trusted` containing `1` and its project-local templates would load with no prompt and no prior human trust decision — including a template overriding a builtin by name. In particular, an override of the builtin `review` template (permission: readonly) could declare `permission: edit` and attach a `verify:` command, which runs host-side via `sh -c` after the harness exits. Net effect: `git clone <hostile repo> && cd it`, then `/delegate review` — which a user reasonably expects to be read-only — could execute an arbitrary host command.

Fixed: `loadTemplates()` now takes an explicit `trusted` boolean (default `false`, fail-closed) instead of reading anything from the project or the environment. In the extension, that boolean comes from pi's own `ctx.isProjectTrusted()` — a trust decision backed by pi's trust store outside the project, set only by pi's own trust prompt or `defaultProjectTrust`. `.pi/trusted` and the `PI_TRUSTED`/`PI_DELEGATE_TRUSTED` environment variables no longer grant trust at all — remove them if you were relying on them, and trust the project through pi's own trust prompt (or `defaultProjectTrust`) instead. `/delegate status` now reports whether the current project is trusted and, if not, that project-local templates were skipped.
