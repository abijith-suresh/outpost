---
"@abijith-suresh/outpost": patch
---

Add a dedicated executable entry point so the packaged CLI starts through npm bin shims, propagates command exit codes to the process, and remains side-effect-free when imported.
