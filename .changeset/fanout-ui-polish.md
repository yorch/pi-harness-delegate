---
'pi-harness-delegate': patch
---

Fan-out overlay polish: a failed harness row now keeps its failure reason (or last activity) instead of blanking at the moment that context matters most, and the status-bar chip reports every status (`1✓ 1✗ 1▶ 1…`) rather than counting only running runs — which rendered `0/4 running` when runs had actually failed or were queued behind the concurrency cap.
