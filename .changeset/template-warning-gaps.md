---
"pi-harness-delegate": patch
---

Template permission warnings: a legacy `permissionMode:`/`sandbox:` key ignored next to a native `permission:` value (e.g. `permission: plan` + `sandbox: workspace-write`) is now flagged at run time against the tier that value actually runs at on the chosen harness (the tier itself is unchanged), and warnings name the key as the author spelled it (`Sandbox:`/`SANDBOX:`), sanitized.
