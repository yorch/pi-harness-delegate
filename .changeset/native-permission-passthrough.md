---
'pi-harness-delegate': patch
---

Wire the `nativePermission` escape hatch through to stdout harnesses, and gate every harness's danger mode behind `allowDangerous`.

- `permissionMode`/`sandbox` template frontmatter was parsed and documented but never passed to `runHarness()`, so the native escape hatch has silently never worked for claude/codex/opencode/amp.
- Passing it revealed that the danger gate only recognised three hardcoded spellings. A template declaring `yolo` (amp) or `bypass` (devin) was filed as an unknown native with a normalized tier of `edit`, skipping the `allowDangerous` gate while running the harness unsandboxed. The gate now asks each harness for its own danger tokens.
- An explicit `allowDangerous` escalation now wins over a template's native mode, which would otherwise silently downgrade the run.
