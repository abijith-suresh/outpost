# @abijith-suresh/outpost — agent brief
Package-level notes for the published CLI; the root `AGENTS.md` brief still applies.

## The Project
Core promise: this package is the whole product — the `outpost` binary plus an import-safe `runCli()` API export. Safety is the feature: Outpost refuses dirty worktrees, foreign guidance files, and ownership it cannot prove.
Non-goals: no push, pull, merge, or remote mutation beyond fetching managed mirrors; no issue-tracker, build, or deploy behavior.
Status: in-flight (paused) — the Effect 4 migration lives on `chore/deps/effect-4`.

## How I Work Here
- Quality gate: `verify` — here that is `npm run typecheck && npm run test` (TypeScript strict, then Vitest with `fileParallelism: false`).
- Refusals are contracts: preflight before teardown, no forced deletion of modified or foreign state, and no manifest write before creation succeeds. They are invariants, not UX polish.
- Interactive-only operations must fail predictably in non-TTY or `--json` runs instead of guessing; every mutation command reports what it did or why it refused, and errors carry actionable guidance.
- The JSON envelope is stable: `{ ok, command, data, exitCode }`. Error codes are assigned explicitly at parser/router/handler boundaries, never inferred from message text.
- Effect boundaries: command workflows and most filesystem, process, path, and console work go through Effect services; TTY detection, `process.env`, `Date`, and readline prompts stay direct Node.
- State is written atomically (temp file plus rename) and validated on read and before write; ticket locks use create-if-absent semantics.
- Adding a command means registering it in `src/command-spec.ts` (the single metadata source for help and `outpost describe`) and handling it in `src/program.ts`; every handler must reject extra or unknown positional arguments before any side effect.

## Sources of Truth
| Fact | Where |
|---|---|
| Runtime behavior and invariants | `apps/cli/src` + `apps/cli/tests` |
| Commands & deps | `apps/cli/package.json` |
| Command surface and help text | `apps/cli/src/command-spec.ts` |
| User-facing docs | `apps/cli/README.md` |

## Getting Around
- `src/cli.ts` / `src/index.ts` — executable binary entry point vs import-safe API entry point
- `src/program.ts` — routing, argument parsing, output formatting, help
- `src/commands/` — one module per command (`create`, `workspace-*`, `repo-*`, `doctor`, `init`)
- `src/workspace-manifest.ts` — manifest schema, workspace status, ticket locks; `src/workspace-agents.ts` — generated workspace `AGENTS.md` and ownership hashing
- `src/path-safety.ts`, `src/remote-identity.ts`, `src/store.ts`, `src/config.ts` — validation, repository identity, atomic writes, configuration
- `tests/` — one suite per command domain plus focused module tests; shared helpers in `tests/helpers.ts`
- `$OUTPOST_HOME` (default `~/.outpost`) — `config.json`, `repos.json`, `repos/` mirrors, `workspaces/` manifests, `worktrees/<ticket>/`
