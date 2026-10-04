---
"pi-harness-delegate": minor
---

Mode discovery, per-mode timeouts and default harnesses:

- **`delegate_modes` tool** (read-only): lets the model list every mode with its permission tier on each harness (danger and unlisted native modes marked as needing a confirmed `allowDangerous`), whether it has a default task/scope or a host-run check, its default harnesses and timeout, and which harnesses are on `PATH`, without running anything. Project-local templates appear only in a trusted project. `verify:` commands, prompt bodies, default task/scope text and file paths are never shown. Template text is sanitized (ANSI, control, bidi, zero-width and invisible tag characters stripped, one line, length-capped) and quoted and labelled as data. `/delegate list` now shows the same data: per-harness tier, source (`builtin`/`user`/`project`) and warnings.
- **`timeout:` template frontmatter** (whole seconds, 10–7200), plus a per-call `timeoutSec` tool parameter and a `/delegate --timeout=<sec>` flag with the same bounds. The order is per-call > template > per-harness `timeoutMs` > global `timeoutMs`, and a timeout can never exceed 2 hours. An invalid template value is ignored with a `⚠` warning. An invalid per-call value is an error.
- **`harnesses:` template frontmatter**: the mode's default harness(es), used only when no harness is given. The `/delegate` command and the `delegate` tool treat it the same way. One name is a normal single run. Several names run as a normal fan-out with detection filtering, slot queueing, a single danger confirm covering every harness, the `addDirs` confirm, and resume rejection. `all` is not accepted. An untrusted project's templates can never choose the harness.
