---
"@abijith-suresh/outpost": patch
---

Guard shared lifecycle mutations with home and ticket locks, record progress before mutation, clean up interrupted creates conservatively, support initialization retry, and inspect crash artifacts and workspace HEAD health in doctor.

Confirm branch and worktree creation only after Git succeeds. Preserve unconfirmed or externally created artifacts and switched worktree branches during rollback, with intent and confirmation phases retained for inspection.
