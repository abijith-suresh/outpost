---
"@abijith-suresh/outpost": patch
---

Upgrade the effect ecosystem to v4: `effect` 3.22.2 → 4.0.5 and `@effect/platform-node` 0.108.1 → 4.0.5. The separate `@effect/platform` package is removed; its file system, path, platform error, and child process APIs now ship in the `effect` core package (`effect/FileSystem`, `effect/Path`, `effect/PlatformError`, `effect/process/ChildProcess`).
