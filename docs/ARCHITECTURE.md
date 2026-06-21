# Architecture

This document describes the current implemented behavior of Outpost. It is descriptive, not prescriptive. When this document and the source disagree, the source is authoritative.

## Overview

Outpost is a single-binary CLI tool (TypeScript compiled to ESM) that manages local Git repository workspaces. It uses [Effect-TS](https://effect.website) for all side effects: file I/O, process spawning, environment access, and console output are modeled as `Effect.Effect` values that are composed and executed through a single runtime.

## CLI Routing

**Entry point:** `src/index.ts` loads the package version and calls `run(argv, version)` from `src/program.ts`.

**Argument parsing** in `src/program.ts:run()`:

1. Check for `--help` or `--version` anywhere in `argv` — if found, print and exit 0 immediately.
2. Detect `--json` flag (any position) for machine-readable output.
3. Determine interactive mode: enabled only when `--json` is absent, stdin is a TTY, and stdout is a TTY.
4. Strip `--json` and `--version` from positional args.
5. If no positional args or first arg is `"help"`, print help and exit 0.
6. Dispatch to `resolveCommand()` which routes by `positionalArgs[0]` through a linear chain.

`resolveCommand()` (line 648) routes to individual command handlers (`runDoctor`, `runCreate`, `runInit`, `runRepoAdd`, etc.). All command errors are mapped to `CliError` via `Effect.mapError`.

**Output formatting** in `printCommandOutput()` (line 65): if `--json`, delegates to `printJson()` which serializes the `CommandOutput` object with `JSON.stringify` (pretty-printed, 2-space indent). Otherwise dispatches by `output.command` to human-readable text output.

**Exit codes:**

- 0 — success, or help/version requested
- 1 — any error or partial failure (e.g., some repos failed to fetch, partial workspace removal)

## Effect System Boundaries

All side effects flow through Effect layers:

- **FileSystem** (`@effect/platform/FileSystem`) — file reads, writes, directory listing, path resolution
- **Path** (`@effect/platform/Path`) — portable path manipulation
- **CommandExecutor** (`@effect/platform-node/CommandExecutor`) — child process spawning (`git` commands)
- **Console** (`effect/Console`) — stdout/stderr output
- **Terminal** (`@effect/platform-node/Terminal`) — TTY detection

The `NodeContext.layer` is provided at the entry point in `src/index.ts`. Tests inject custom layers to control the environment.

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

1. Create workspace directory
2. Create branches on all managed repos
3. Create worktrees on all managed repos
4. Write `AGENTS.md` into workspace directory
5. Write manifest to `workspaces/<ticket>.json`

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

1. Acquire ticket lock
2. Read and validate the manifest
3. For each repository entry:
   - Verify the managed repo still exists
   - Verify worktree ownership (`.git` file points to the correct bare repo's `worktrees/` directory)
   - Check `git status --porcelain` for uncommitted changes — refuse if dirty
   - Run `git worktree remove` on the worktree
4. Classify AGENTS.md ownership:
   - `"generated"` (unmodified by user): delete automatically
   - `"modified"` or `"foreign"`: prompt in interactive mode, refuse in non-interactive mode
5. Remove workspace directory (only if empty after worktrees removed)
6. Delete the manifest
7. Release the ticket lock

**Partial cleanup:** if some worktrees fail to remove, the command reports which succeeded and which failed with exit code 1. The manifest is only deleted on complete removal.

**Branch preservation:** `git worktree remove` removes only the worktree metadata and directory. The branch in the bare mirror is preserved.

### Workspace List (`src/commands/workspace-list.ts`)

Scans `workspaces/` for manifest files and `worktrees/` for directories without manifests (unmanaged workspaces). Derives a status for each:

| Status      | Condition                                                            |
| ----------- | -------------------------------------------------------------------- |
| `ready`     | Manifest valid, all repos and worktrees exist, ownership checks pass |
| `missing`   | Some worktree or managed repo path does not exist                    |
| `invalid`   | Manifest unreadable, path resolution fails, or ownership check fails |
| `unmanaged` | Directory exists in worktrees root but no manifest                   |

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

## Ticket Locks (`src/workspace-manifest.ts` lines 801-865)

Ticket operations that mutate workspace state (`create`, `workspace remove`) acquire an exclusive lock file at `workspaces/.<ticket>.lock` using `O_CREAT | O_EXCL` (exclusive creation). If the lock file already exists, the operation fails with a "ticket is locked" message. Locks are released via `Effect.ensuring` to guarantee cleanup even on errors.

## Workspace AGENTS.md (`src/workspace-agents.ts`)

When a workspace is created, Outpost generates an `AGENTS.md` file in the workspace directory using exclusive-create semantics (hard link from temp file — fails if the file already exists). The file contains workspace metadata (ticket, branch) and a per-repository block with the repo name, ID, worktree path, expected branch, and base branch.

**Ownership marker:** the first line is `<!-- outpost:workspace-agents sha256=<64-char-hex> -->`. The SHA256 is computed over the body (all content after the marker).

**Ownership classification** on workspace remove:

- `"missing"` — file absent
- `"foreign"` — file present but no Outpost marker
- `"generated"` — marker exists and hash matches (unmodified)
- `"modified"` — marker exists but hash does not match (user edited)

Outpost only deletes `AGENTS.md` when it is `"generated"` (unmodified). For `"foreign"` or `"modified"` files, the user must confirm in interactive mode, or the remove operation fails in non-interactive mode.

## Path Safety (`src/path-safety.ts`)

All path operations are validated for containment:

- `validatePathSegment()` — rejects `/`, `\`, `.`, `..` in path segments
- `resolvePathWithinRoot()` — resolves paths to canonical form, verifies the resolved path is within the root directory
- `getCanonicalPortablePathKey()` — normalizes paths (lowercase, unified separators) for collision detection

## Module Ownership

| Module                                    | Responsibility                                                     |
| ----------------------------------------- | ------------------------------------------------------------------ |
| `src/index.ts`                            | Entry point, runtime bootstrap                                     |
| `src/program.ts`                          | CLI routing, arg parsing, output formatting, help text             |
| `src/config.ts`                           | Config schema, read/write, migration                               |
| `src/store.ts`                            | Atomic JSON/text file writes                                       |
| `src/path-safety.ts`                      | Path segment validation, containment checks                        |
| `src/remote-identity.ts`                  | Remote URL parsing, identity derivation, managed path encoding     |
| `src/workspace-manifest.ts`               | Manifest schema, CRUD, validation, status derivation, ticket locks |
| `src/workspace-agents.ts`                 | AGENTS.md generation, ownership classification, deletion           |
| `src/types.ts`                            | Shared types (`CommandOutput`)                                     |
| `src/commands/create.ts`                  | Create command with rollback                                       |
| `src/commands/create-prompt.ts`           | Interactive prompting for create                                   |
| `src/commands/init.ts`                    | Initialize Outpost home                                            |
| `src/commands/doctor.ts`                  | Environment status report                                          |
| `src/commands/repo-add.ts`                | Register a local repo                                              |
| `src/commands/repo-mirror.ts`             | Git clone/fetch mirror operations                                  |
| `src/commands/repo-fetch.ts`              | Fetch all managed mirrors                                          |
| `src/commands/repo-list.ts`               | List registered repos                                              |
| `src/commands/repo-show.ts`               | Show repo details                                                  |
| `src/commands/repo-remove.ts`             | Remove registered repo (with workspace reference check)            |
| `src/commands/workspace-list.ts`          | List workspaces with derived status                                |
| `src/commands/workspace-show.ts`          | Show workspace details                                             |
| `src/commands/workspace-remove.ts`        | Remove workspace with safety checks                                |
| `src/commands/workspace-remove-prompt.ts` | Interactive prompting for AGENTS.md consent                        |
