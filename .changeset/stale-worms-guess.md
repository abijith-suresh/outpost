---
"@abijith-suresh/outpost": patch
---

Load the CLI runtime lazily for faster help, version and command discovery. Build a per-invocation manifest identity snapshot and reuse validated manifests during workspace listing, preserving fresh mutation validation under locks. Verify installed discovery assets against generated per-command digests before parsing, rejecting damaged or mismatched schemas without loading the state runtime.
