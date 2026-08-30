---
"pi-harness-delegate": minor
---

Add `/delegate config` — prints exactly what was read from `~/.pi/agent/settings.json` (or why nothing was: no file, no `delegate` key, or a parse error), plus the effective config with defaults filled in, as a paste-ready JSON block.

Add `/delegate config init` — writes that effective config into `settings.json` under the `delegate` key, the only thing this extension ever writes there and only on this explicit command. It's a read-modify-write: the whole file is read, only the `delegate` key is replaced, every other key (pi's own settings, a leftover `claudeDelegate`) is preserved verbatim, and the write is atomic (temp file + rename). It refuses outright rather than writing over a file that fails to parse.

`/delegate status` now leads with the same provenance instead of jumping straight to resolved values. This surfaces a real gap: staying on the legacy `claudeDelegate` key (rather than renaming it to `delegate`, or running `/delegate config init`) silently blocks two settings from ever being reachable — `defaultHarness` (stays pinned to `claude`) and a top-level default `model` (only `claudeDelegate.model` migrates, to `harnesses.claude.model`) — both `status` and `config` now call this out.

Internally, `loadConfig()` no longer swallows a malformed or unparseable `settings.json` into indistinguishable defaults — `loadConfigWithSource()` reports provenance (file existence, which key won, parse errors) alongside the resolved config, without a second file read and without ever throwing.
