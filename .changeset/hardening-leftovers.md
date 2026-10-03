---
"pi-harness-delegate": patch
---

Security hardening: scope text, `git diff` output and `gh pr diff` bodies are now fenced in the delegated prompt as untrusted data (a backtick fence longer than any run in the content, between `BEGIN/END UNTRUSTED DATA <nonce>` markers with a fresh random nonce), so a malicious PR can't break out into instruction position. A template's native `permission:` value is now checked against a per-harness allowlist of readonly/edit-equivalent modes — anything not on it (e.g. claude `auto`/`dontAsk`, devin `smart`, a custom opencode agent) is treated as `danger` and needs `allowDangerous`/`--allow-dangerous`; once confirmed it still runs as declared. Also: typed tool registration (no casts), a shared `maxConcurrent` parser, a `test:coverage` script, and deterministic (sleep-free) timing in tests.
