# @abijith-suresh/outpost

## 0.0.19

### Patch Changes

- a042f63: Add workspace remove command to delete ticket workspaces and their worktrees
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
