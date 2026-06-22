---
"@abijith-suresh/outpost": patch
---

Add dedicated executable entry point `src/cli.ts` so that the packaged CLI starts unconditionally when installed via npm. Remove the `import.meta.url` versus `process.argv[1]` guard from `src/index.ts` and keep it import-safe for programmatic use.
