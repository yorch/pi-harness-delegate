---
"pi-harness-delegate": minor
---

Add `/delegate config` — prints exactly what was read from `~/.pi/agent/settings.json` (or why nothing was: no file, no `delegate` key, or a parse error), plus the effective config with defaults filled in, as a paste-ready JSON block. Print-only; it never writes to `settings.json`.

`/delegate status` now leads with the same provenance instead of jumping straight to resolved values. This surfaces a real gap: staying on the legacy `claudeDelegate` key (rather than renaming it to `delegate`) silently blocks two settings from ever being reachable — `defaultHarness` (stays pinned to `claude`) and a top-level default `model` (only `claudeDelegate.model` migrates, to `harnesses.claude.model`) — both `status` and `config` now call this out and tell you to rename the key.

Internally, `loadConfig()` no longer swallows a malformed or unparseable `settings.json` into indistinguishable defaults — `loadConfigWithSource()` reports provenance (file existence, which key won, parse errors) alongside the resolved config, without a second file read and without ever throwing.
