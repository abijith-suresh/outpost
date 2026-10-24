# @abijith-suresh/outpost

## 0.0.27

### Patch Changes

- 906fb60: Update the paired Effect runtime dependencies and refresh CLI test tooling, with explicit Node.js 24 types matching the supported runtime.
- 59604ce: Align effect with the @effect/platform peer range.
- 727d6bf: Upgrade the effect ecosystem to v4: `effect` 3.22.2 → 4.0.5 and `@effect/platform-node` 0.108.1 → 4.0.5. The separate `@effect/platform` package is removed; its file system, path, platform error, and child process APIs now ship in the `effect` core package (`effect/FileSystem`, `effect/Path`, `effect/PlatformError`, `effect/process/ChildProcess`).
- 2a59f52: Guard shared lifecycle mutations with home and ticket locks, record progress before mutation, clean up interrupted creates conservatively, support initialization retry, and inspect crash artifacts and workspace HEAD health in doctor.

  Confirm branch and worktree creation only after Git succeeds. Preserve unconfirmed or externally created artifacts and switched worktree branches during rollback, with intent and confirmation phases retained for inspection.

- 0821c58: Check Git output status, drain both pipes, bound retained diagnostics, and terminate timed out or cancelled commands.

  Escalate SIGTERM-resistant subprocess cleanup to SIGKILL after a one-second grace period and append bounded diagnostic lines individually so finite tiny-line Git output cannot bypass JSON error handling.

- 1e08f65: Preserve local workspace branches and commits during repository fetch and re-import; migrate legacy mirrors to isolated remote tracking refs.
- d9e447d: Expose a versioned agent command contract with typed schemas and structured recovery reasons, including semantic Git arguments and physically missing mirrors. Validate argument shapes from the registry, add mutation-free removal previews, and bound formatted Git diagnostics with explicit truncation metadata. Explain guidance preservation and explicit consent in workspace-removal refusals instead of suggesting deletion to bypass them.
- 5892c91: Ship a portable Outpost skill, generated command reference, man page and standalone JSON schemas. Add offline docs and skill discovery/export commands without automatic agent configuration changes, and verify packaged assets and schema drift across supported Effect patches with finite integer counts. Clarify that repository cleanup deletes local branch storage and warn in previews and removal results. Clarify initialization before listing, optional child guidance, and explicit branch selection and commit verification when restoring local bundles before mirror cleanup.
- 2318049: Escalate checked subprocess cleanup when SIGTERM is ignored and preserve structured JSON diagnostics for finite Git failures containing many tiny lines.

  Confirm successful Git creation before making a branch or worktree eligible for rollback. Preserve unconfirmed or ambiguous artifacts after mutation failure or interruption, and retain intent/confirmation phases for recovery inspection.

- 3416ee6: Load the CLI runtime lazily for faster help, version and command discovery. Build a per-invocation manifest identity snapshot and reuse validated manifests during workspace listing, preserving fresh mutation validation under locks. Verify installed discovery assets against generated per-command digests before parsing, rejecting damaged or mismatched schemas without loading the state runtime.
- 6db079b: Validate repository containment and ownership before mutation, protect all linked Git worktrees, reserve AGENTS.md during create preflight, and keep removal warnings structured in JSON.

## 0.0.26

### Patch Changes

- db478e7: Migrate linting and formatting from ESLint and Prettier to Biome. No behavioral or API changes.
- 647557e: Bump grouped minor and patch dependencies
- 0c1d2a1: Declare the published CLI's supported runtime as Node.js 24 only, starting at the verified LTS baseline `24.19.0`.
- 4299d8c: Reject empty semantic identifiers and ASCII control characters before state, filesystem, or Git operations.
- 77ff5e7: Update the development TypeScript toolchain to 7.0.2. The website workspace stays on 6.0.3 because `@astrojs/check` does not support TypeScript 7 yet. No runtime or API changes.

## 0.0.25

### Patch Changes

- b3be244: Reorganize Outpost into npm workspaces while preserving the published CLI contract

## 0.0.24

### Patch Changes

- e0ea55e: Reject unsupported and trailing CLI arguments before dispatching commands
- bccfd04: Add central workspace manifests with atomic writes, ticket locking, transactional create/rollback, manifest-backed list/show/remove, and repo-remove safety checks.
- d65d64e: Add Astro marketing landing page as a standalone website package
- 87d81b5: Make --json a complete machine-readable contract with stable error envelopes
- 1f3e1dc: Add a dedicated executable entry point so the packaged CLI starts through npm bin shims, propagates command exit codes to the process, and remains side-effect-free when imported.
- c0c8fbf: Add command-level help and machine-readable introspection via outpost describe
- 3236ffa: Generate workspace AGENTS.md with SHA-256 marker, ownership classification, and transactional creation/removal integration.

## 0.0.23

### Patch Changes

- 3fe3877: Write config and repository registry state atomically, and centralize create and workspace path containment checks.
- c9cc085: Replace collision-prone repository IDs with canonical network and local identities, hierarchical managed paths, and duplicate registry validation.

## 0.0.22

### Patch Changes

- 906b6a3: Report corrupt doctor config or repo registry state as an error instead of ok.
- 0a7e811: Reject unsafe workspace ticket arguments before resolving show or remove paths.

## 0.0.21

### Patch Changes

- d206768: Clean up temp test directories between tests to prevent stale state collisions
- 6d3a5b4: Remove demo list command from README commands table
- d7627cf: Add config schema version migration path with clear error for future versions
- 32010bb: Update CONTRIBUTING.md project structure with missing files

## 0.0.20

### Patch Changes

- dce190c: Validate ticket and type inputs in interactive create prompt and handle SIGINT gracefully
- 531f8f5: Prune git worktree entries from bare repos when removing a workspace
- 5f6c619: Rewrite README with install instructions, usage, and command reference
- 7693fc6: Show git clone and fetch stderr output for better error diagnosis
- d20caec: Remove demo list command stub

## 0.0.19

### Patch Changes

- a042f63: Add workspace remove command to delete ticket workspaces and their worktrees
- 6f267c7: Split monolithic test file into focused files per command domain and extract shared helpers
- 3a7f812: Use PAT for changesets step so CI triggers run on generated release PRs

## 0.0.18

### Patch Changes

- ded46a8: feat: add repo remove command to delete an imported repository

## 0.0.17

### Patch Changes

- 5c6e78e: Add the `outpost create` command for planning and creating managed ticket worktrees, including interactive prompting and dry-run support.
- 5c6e78e: Add `workspace show` and `workspace list` for inspecting created ticket workspaces.

## 0.0.16

### Patch Changes

- 318f63e: Add `outpost repo fetch --all [--json]` with per-repo results, partial failure reporting, and fetch exit codes.

## 0.0.15

### Patch Changes

- 7e5e458: Make `--version` work as a global flag anywhere in argv while keeping `--help` precedence.

## 0.0.14

### Patch Changes

- 8dec8e0: Make `--help` work as a true global flag anywhere in argv.

## 0.0.13

### Patch Changes

- a54e1a1: Print plain error messages for known command failures while keeping unknown-command guidance unchanged.

## 0.0.12

### Patch Changes

- 4ad67db: Add `--remote <name>` support to `outpost repo add` for multi-remote repositories.

## 0.0.11

### Patch Changes

- 1d46e5c: Add `repo show`, include repo ids in `repo list`, and clarify the multi-remote `repo add` error text.

## 0.0.10

### Patch Changes

- 9e9e19c: Add repo health diagnostics to `repo list` output.

## 0.0.9

### Patch Changes

- 25b924b: Extend `outpost doctor` to report degraded status when managed repositories are missing from disk.

## 0.0.8

### Patch Changes

- 0e0d09b: Enhance `outpost doctor` with Outpost initialization and repo registry details.

## 0.0.7

### Patch Changes

- 4da548c: Add a basic `outpost repo list` command.

## 0.0.6

### Patch Changes

- 68773c4: Persist imported repositories in a versioned repo registry and initialize that registry during `outpost init`.

## 0.0.5

### Patch Changes

- 020dd9a: Add managed bare-repo import for `repo add`, create a dedicated repos root during init, and automatically dispatch CI for Changesets release branches.

## 0.0.4

### Patch Changes

- 900f18a: Add a read-only `repo add` preflight command that validates local Git repositories against initialized Outpost configuration.

## 0.0.3

### Patch Changes

- 2346f38: Add an Effect-based CLI foundation with a real `init` command, validated config bootstrap, and async runtime-backed command execution.

## 0.0.2

### Patch Changes

- 92ade74: Add a minimal production-grade CLI baseline with help output, structured command routing, doctor checks, demo list output, and JSON support.
