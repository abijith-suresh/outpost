---
"@abijith-suresh/outpost": patch
---

Add explicit offline reuse of existing owned managed branches in new ticket workspaces, with immutable admission provenance and preservation through failure, interruption, recovery and removal.

Validate selected loose-object paths and bounded pack metadata before reuse, refusing external object aliases while preserving owned packed objects and hardlinks.
