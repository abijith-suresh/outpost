# @abijith-suresh/outpost

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
