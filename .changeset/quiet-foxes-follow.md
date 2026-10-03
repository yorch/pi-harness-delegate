---
"pi-harness-delegate": patch
---

Review follow-ups:

- `/delegate` (and the fan-out command path) shows the danger banner based on the template that actually runs — including the default mode when none is given and each harness's native danger mode (e.g. amp `yolo`, devin `bypass`, opencode `build --auto`).
- `/claude`, `/codex`, `/opencode`, `/amp`, `/omp` and `/devin` now describe the full flag set, including `--add-dir` and `--allow-dangerous`.
- Command parsing: `--harness=omp` is alias-normalized like `omp` as the first word; a trailing comma (`claude,`) no longer turns a single harness into a fan-out; `--budget=0`, negative or non-numeric values are reported as an error instead of being silently ignored; `--flag=value` text inside backticks or double quotes in the prompt is left alone (a recognized flag stranded inside double quotes now gets a warning); an unbalanced `"`/backtick near flags is reported as an error instead of guessing (it could previously drop a real flag or expose a quoted `--verify` value as flags); an empty `--budget=` or the space form `--budget 5` is an error instead of running uncapped.
- The progress window's `+N earlier` marker no longer pushes the feed one line past its limit.
- Fan-out comparison rows report the real prompt-token count instead of omitting it.
- Resumed opencode ACP runs report only that run's spend, so `/delegate status` no longer counts earlier turns again — or no cost at all (`—`) when the session's prior total wasn't reported before the new prompt, instead of a silent under-count.
- The untrusted-project warning now also fires for per-harness project templates (`.pi/delegate/templates/<harness>/`) — only real harness partitions count, so an `archive/` or alias (`omp/`) subdirectory the loader never reads doesn't trigger it.
- Robustness: jittered concurrency-slot polling; an ACP agent that exits early can no longer crash pi through an unhandled stdin `EPIPE`.
- Removed the internal deprecated `run-claude.ts` / `stream-parse.ts` wrappers (unused outside tests).
