---
"@abijith-suresh/outpost": patch
---

Check Git output status, drain both pipes, bound retained diagnostics, and terminate timed out or cancelled commands.

Escalate SIGTERM-resistant subprocess cleanup to SIGKILL after a one-second grace period and append bounded diagnostic lines individually so finite tiny-line Git output cannot bypass JSON error handling.
