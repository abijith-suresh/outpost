# @abijith-suresh/outpost

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
