# Architecture

This document describes the current implemented behavior of Outpost. It is descriptive, not prescriptive. When this document and the source disagree, the source is authoritative.

## Overview

Outpost is an npm-distributed CLI written in TypeScript and compiled to ESM. It manages local Git repository workspaces and uses [Effect-TS](https://effect.website) to compose its command workflows and most filesystem, process, path, and console effects.

## CLI Routing

**Executable entry point:** `src/cli.ts` is the dedicated executable binary entry point pointed to by `package.json#bin`. It starts unconditionally, propagates the numeric command result through `process.exitCode`, and uses `NodeRuntime.runMain` for lifecycle management and signal handling.

**API entry point:** `src/index.ts` loads the package version and exports `runCli()` for programmatic use. It is import-safe with no side effects — importing the package does not execute the CLI.

**Argument parsing** in `src/program.ts`:

1. Check for `--help` or `--version` anywhere in `argv` — if found, print and return a successful command result immediately.
2. Detect `--json` flag (any position) for machine-readable output.
3. Determine interactive mode: enabled only when `--json` is absent, stdin is a TTY, and stdout is a TTY.
4. Strip `--json` and `--version` from positional args.
5. If no positional args or first arg is `"help"`, print help and exit 0.
6. Dispatch to `resolveCommand()` which routes by `positionalArgs[0]` through a linear chain.

`resolveCommand()` routes to individual command handlers (`runDoctor`, `runCreate`, `runInit`, `runRepoAdd`, etc.). Command errors are mapped to `CliError` before presentation.

**Output formatting:** returned command results are rendered as pretty-printed JSON when `--json` is present, including structured partial results. Otherwise they are formatted as command-specific human-readable text. Help, version output, and errors raised before a command result is produced are plain text.

## Effect System Boundaries

The main command workflows use Effect services for:

- **FileSystem** (`@effect/platform/FileSystem`) — file reads, writes, directory listing, path resolution
- **Path** (`@effect/platform/Path`) — portable path manipulation
- **CommandExecutor** (`@effect/platform-node/CommandExecutor`) — child process spawning (`git` commands)
- **Console** (`effect/Console`) — stdout/stderr output

The `NodeContext.layer` is provided at the entry points in `src/cli.ts` and `src/index.ts`. Some process-level integration remains direct: TTY detection reads `process.stdin` and `process.stdout`, environment resolution reads `process.env`, timestamps use `Date`, and interactive prompts use Node readline. Tests control those boundaries through temporary process state and mocks.

## Persisted State

All state lives under `$OUTPOST_HOME` (default `~/.outpost`):

```
~/.outpost/
  config.json           # OutpostConfig { version, outpostHome, reposRoot, worktreesRoot }
  repos.json            # RepoRegistry { repos: Array<RepoRecord> }
  repos/                # Managed bare mirrors (git clone --mirror)
    <encoded-segments>/
      <name>.git/
  workspaces/           # Workspace manifests
    <ticket>.json       # One manifest per workspace
    .<ticket>.lock      # Ticket lock file
  worktrees/            # Worktree directories
    <ticket>/
      <repo-name>/      # Git worktree (direct child)
      AGENTS.md         # Generated workspace orientation
```

### Atomic Writes (`src/store.ts`)

`config.json`, `repos.json`, and workspace manifests are written atomically: write to a temp file in the same directory, then `rename` (atomic on same filesystem). If the rename fails, the temp file is cleaned up.

### Configuration (`src/config.ts`)

`OutpostConfig` stores the home paths and a schema version (currently `1`). The `doctor` command reports whether the config and registry are valid. Config migration (`migrateConfig`) handles version upgrades; unknown future versions produce a clear error.

## Repository Identity

Repositories are identified by a canonical identity derived from their remote URL (`src/remote-identity.ts`):

- **Network repos** (SSH, HTTPS): identity = `hostname[:port]/path/segments`
- **File repos** (local paths): identity = canonical `file://` URL with resolved absolute path

The identity determines the managed mirror path under `repos/`. Path segments are percent-encoded to produce filesystem-safe names (`encodeManagedPathSegment`).

**Managed mirrors** (`src/commands/repo-mirror.ts`): bare repos cloned with `git clone --mirror`. Fetched with `git fetch --all --prune --tags`. Git environment is sanitized (GCM_INTERACTIVE=never, GIT_TERMINAL_PROMPT=0).

**Registry** (`repos.json`): an ordered array of `RepoRecord` objects, each containing the identity, managed path, remote name and URL, timestamps. Adding a repo with an identity that already exists in the registry updates the existing record rather than duplicating.

## Worktree and Branch Model

### Create (`src/commands/create.ts`)

`outpost create --ticket <id> --type <prefix> --repo <id> [--repo <id> ...] [--base <branch>] [--dry-run]`

Creates a branch `<type>/<ticket>` (e.g., `feat/PROJ-123`) on every specified managed repo, then creates a worktree for each at `<worktreesRoot>/<ticket>/<repo-name>`.

**Base branch resolution:**

- If `--base` provided: use that branch
- Otherwise: resolve HEAD symbolic ref from the bare mirror

**Validation (pre-flight):**

- Ticket and type are validated for path segment safety
- Target branches must not already exist
- Base branches must exist
- No two repos may produce colliding worktree paths
- The ticket must not already have a manifest

**Transaction ordering:**

1. Create the workspace directory.
2. For each selected repository in order, create its branch and then its worktree.
3. Write `AGENTS.md` into the workspace directory.
4. Write the manifest to `workspaces/<ticket>.json` as the successful creation commit marker.

**Rollback** on any failure after step 1:

- Remove worktrees (`git worktree remove --force`)
- Delete branches (`git branch -D`)
- Delete AGENTS.md (only if content matches the snapshot — never delete user-modified files)
- Remove workspace directory (only if empty via `rmdir`)

**Dry-run:** validates all inputs and produces a plan, but does not acquire locks or mutate any state.

**Interactive vs non-interactive:**

- Interactive mode (TTY, no `--json`): prompts for missing `--ticket`, `--type`, and `--repo` values using `node:readline/promises`. Handles SIGINT gracefully.
- Non-interactive mode: all `--ticket`, `--type`, and at least one `--repo` are required. Missing args produce an error.

### Workspace Remove (`src/commands/workspace-remove.ts`)

`outpost workspace remove <ticket> [--json]`

**Removal safeguards:**

1. Acquire the ticket lock and read and validate the manifest.
2. Classify `AGENTS.md` ownership:
   - `"generated"` (unmodified by user): eligible for automatic deletion
   - `"modified"` or `"foreign"`: require approval in interactive mode and fail in non-interactive mode
3. Preflight every existing worktree before deleting any:
   - Verify the managed repo still exists.
   - Verify worktree ownership (`.git` points to the expected bare repository).
   - Check `git status --porcelain` and refuse if dirty or if cleanliness cannot be established.
4. Remove each existing worktree. A worktree already missing is treated as completed so a partial removal can be retried.
5. Delete `AGENTS.md` only if its bytes still match the snapshot that was classified and, when required, approved.
6. Remove the workspace directory only if it is empty.
7. Delete the manifest last, after complete cleanup.
8. Release the ticket lock.

**Partial cleanup:** worktree removal failures, concurrent changes to the approved `AGENTS.md` snapshot, residual directory entries, and workspace-directory inspection or removal failures produce a structured partial result and retain the manifest for retry. Other unexpected I/O failures can terminate with a plain command error. Preflight failures occur before worktree teardown begins.

**Branch preservation:** `git worktree remove` removes only the worktree metadata and directory. The branch in the bare mirror is preserved.

### Workspace List (`src/commands/workspace-list.ts`)

Scans `workspaces/` for manifest files and `worktrees/` for directories without manifests (unmanaged workspaces). Derives a status for each:

| Status      | Condition                                                             |
| ----------- | --------------------------------------------------------------------- |
| `ready`     | Manifest valid, all repos and worktrees exist, ownership checks pass  |
| `missing`   | The workspace directory, a worktree, or a managed repo path is absent |
| `invalid`   | Manifest unreadable, path resolution fails, or ownership check fails  |
| `unmanaged` | Directory exists in worktrees root but no manifest                    |

## Workspace Manifests (`src/workspace-manifest.ts`)

Each workspace is tracked by a manifest JSON file at `workspaces/<ticket>.json`:

```jsonc
{
  "ticket": "PROJ-123",
  "type": "feat",
  "branch": "feat/PROJ-123",
  "createdAt": "2025-...",
  "workspacePath": "PROJ-123",
  "repositories": [
    {
      "id": "github.com/owner/repo",
      "name": "repo",
      "base": "main",
      "managedPath": "github.com/owner/repo",
      "worktreePath": "repo",
    },
  ],
}
```

All paths in the manifest are relative to their respective roots (`reposRoot` or `worktreesRoot`). The manifest is validated exhaustively on read: ticket identity collision detection, path containment checks, path uniqueness enforcement, and worktree single-segment checks.

## Ticket Locks (`src/workspace-manifest.ts`)

Ticket operations that mutate workspace state (`create`, `workspace remove`) acquire an exclusive lock file using create-if-absent semantics. The lock identity normalizes ticket casing and strips trailing spaces and dots, matching Outpost's portable collision rules. If the lock already exists, acquisition fails. Normal handled outcomes release the lock through Effect finalization.

## Workspace AGENTS.md (`src/workspace-agents.ts`)

When a workspace is created, Outpost generates an `AGENTS.md` file in the workspace directory using exclusive-create semantics (hard link from temp file — fails if the file already exists). The file contains workspace metadata (ticket, branch) and a per-repository block with the repo name, ID, worktree path, expected branch, and base branch.

**Ownership marker:** the first line is `<!-- outpost:workspace-agents sha256=<64-char-hex> -->`. The SHA256 is computed over the body (all content after the marker).

**Ownership classification** on workspace remove:

- `"missing"` — file absent
- `"foreign"` — file present but no Outpost marker
- `"generated"` — marker exists and hash matches (unmodified)
- `"modified"` — marker exists but hash does not match (user edited)

Outpost automatically deletes `"generated"` files. A `"foreign"` or `"modified"` file is deleted only after explicit interactive approval; non-interactive removal fails. Deletion compares the exact classified snapshot immediately before removal so a concurrently changed file is preserved.

## Path Safety (`src/path-safety.ts`)

All path operations are validated for containment:

- `validatePathSegment()` — rejects path separators and, by default, traversal segments
- `resolvePathWithinRoot()` — resolves a path lexically and verifies that it remains within the root directory
- `getCanonicalPortablePathKey()` — normalizes paths (lowercase, unified separators) for collision detection

## Module Ownership

| Module                                    | Responsibility                                                              |
| ----------------------------------------- | --------------------------------------------------------------------------- |
| `src/cli.ts`                              | Executable binary entry point, unconditional startup, exit-code propagation |
| `src/index.ts`                            | API entry point, programmatic `runCli()` export, import-safe                |
| `src/program.ts`                          | CLI routing, arg parsing, output formatting, help text                      |
| `src/config.ts`                           | Config schema, read/write, migration                                        |
| `src/store.ts`                            | Atomic JSON/text file writes                                                |
| `src/path-safety.ts`                      | Path segment validation, containment checks                                 |
| `src/remote-identity.ts`                  | Remote URL parsing, identity derivation, managed path encoding              |
| `src/workspace-manifest.ts`               | Manifest schema, CRUD, validation, status derivation, ticket locks          |
| `src/workspace-agents.ts`                 | AGENTS.md generation, ownership classification, deletion                    |
| `src/types.ts`                            | Shared types (`CommandOutput`)                                              |
| `src/commands/create.ts`                  | Create command with rollback                                                |
| `src/commands/create-prompt.ts`           | Interactive prompting for create                                            |
| `src/commands/init.ts`                    | Initialize Outpost home                                                     |
| `src/commands/doctor.ts`                  | Environment status report                                                   |
| `src/commands/repo-add.ts`                | Register a local repo                                                       |
| `src/commands/repo-mirror.ts`             | Git clone/fetch mirror operations                                           |
| `src/commands/repo-fetch.ts`              | Fetch all managed mirrors                                                   |
| `src/commands/repo-list.ts`               | List registered repos                                                       |
| `src/commands/repo-show.ts`               | Show repo details                                                           |
| `src/commands/repo-remove.ts`             | Remove registered repo (with workspace reference check)                     |
| `src/commands/workspace-list.ts`          | List workspaces with derived status                                         |
| `src/commands/workspace-show.ts`          | Show workspace details                                                      |
| `src/commands/workspace-remove.ts`        | Remove workspace with safety checks                                         |
| `src/commands/workspace-remove-prompt.ts` | Interactive prompting for AGENTS.md consent                                 |
