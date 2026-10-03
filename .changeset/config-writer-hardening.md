---
'pi-harness-delegate': patch
---

Harden `/delegate config init` / `writeDelegateConfig`, found by adversarial review.

- `init` now writes only the settings that differ from the built-in defaults (including per-alias for `modelAliases`). Writing the full effective config pinned every default into `settings.json`, and the loader treats a present value as user intent, so later default changes (`maxConcurrent` 1 → 4 already was one) would never have reached that user.
- Takes pi's own `settings.json.lock` (the configured path, not a symlink's target — that is what pi locks) before the read-modify-write and refuses if another pi session holds it, instead of racing pi's saves and silently losing either side's write.
- Preserves the file's mode (a 0600 file was becoming 0644), writes through a symlinked `settings.json` instead of replacing the link with a regular file, and matches the file's trailing-newline convention (pi writes none).
- Cleans up its temp file on failure.
