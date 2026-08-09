---
"@abijith-suresh/outpost": patch
---

Migrate from Effect 3 to Effect 4 (4.0.0-beta.106). `@effect/platform` is absorbed into `effect` (imports moved to `effect/FileSystem`, `effect/Path`, `effect/PlatformError`); command execution uses the v4 `ChildProcess`/`ChildProcessSpawner` handle protocol via new `command-utils` helpers; renames applied (`catchAll` → `catch`, `Either` → `Result`, `Schema.Literal` → `Schema.Literals`, `decodeUnknown` → `decodeUnknownEffect`, `Schema.filter` → `Schema.makeFilter` + `.check`, `Effect.either` → `Effect.result`, `NodeContext` → `NodeServices`, `Schema.Record` object form → pair form). Behavior preserved: 256/256 tests passing.
