---
"pi-harness-delegate": minor
---

Run records, history filters, rerun, fan-out resume and template variables. Every run now writes a versioned JSON sidecar next to its transcript (never storing the verify command, `allowDangerous`, env or secrets); `/delegate history` gains `--failed`/`--ok`/`--since=`/`--limit=`/`--mode=`; `/delegate rerun [n|runId]` repeats a recorded run through the normal command path (stored values re-validated, `allowDangerous`/`verify` never replayed, fresh session unless `--resume`, `--here`/`--fanout`); `--resume=fan_…` (and the tool's `resumeFanout`) resumes every member of a past fan-out on its own harness with its own session; template bodies may position `{{task}}`, `{{scope}}` (the delimited block), `{{cwd}}`, `{{harness}}` and `{{mode}}`.
