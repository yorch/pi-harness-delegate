---
"pi-harness-delegate": patch
---

Template permission warnings now escape C1 control characters (including the 8-bit CSI), bidi overrides/isolates, zero-width characters and line separators as `\uXXXX` — `JSON.stringify` alone left them raw — in the echoed value, the native `permission:` value and the template name, on every channel (notification/stderr, transcript, result prefix, `details.permissionWarning`, `/delegate list`, and the danger refusal error). Ignored legacy `permissionMode:`/`sandbox:` keys that disagree with each other are now flagged even when the least permissive of them matches the running tier, and legacy keys next to conflicting `permission:` values are mentioned in that warning instead of being dropped silently.
