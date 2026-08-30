---
'pi-harness-delegate': patch
---

Warn when project-local templates are skipped for an untrusted project, instead of failing silently.

The 0.6.0 security fix removed `.pi/trusted` and `PI_TRUSTED` as ways to grant trust. For anyone who relied on them, project-local templates stop loading on upgrade with no visible signal — an override shares its name with the builtin it replaces, so the delegation just uses the builtin and produces plausible output. `/delegate status` reported trust state, but nobody runs it until something already looks wrong.

A delegation in an untrusted project that actually has `.pi/delegate/templates/` now prints a one-time notice saying they were skipped and how to grant trust, and flags a leftover `.pi/trusted` file as inert and deletable. Gated on the content existing, so users who never had project templates see nothing.
