# Architecture

This document describes the current implemented behavior of Outpost. It is descriptive, not prescriptive. When this document and the source disagree, the source is authoritative.

## Overview

Outpost is an npm workspace repository containing the published CLI and the
private marketing website. The root package is a private orchestration package
with one lockfile and aggregate development scripts.

- `apps/cli/` contains the npm-distributed CLI, written in TypeScript and
  compiled to ESM as `@abijith-suresh/outpost`.
- `apps/website/` contains the private Astro marketing website deployed to
  GitHub Pages.

The CLI manages local Git repository workspaces and uses
[Effect-TS](https://effect.website) to compose its command workflows and most
filesystem, process, path, and console effects.

## CLI Routing

**Executable entry point:** `apps/cli/src/cli.ts` is the dedicated executable binary entry point pointed to by `apps/cli/package.json#bin`. It starts unconditionally, propagates the numeric command result through `process.exitCode`, and uses `NodeRuntime.runMain` for lifecycle management and signal handling.

**API entry point:** `apps/cli/src/index.ts` loads the package version and exports `runCli()` for programmatic use. It is import-safe with no side effects — importing the package does not execute the CLI.

**Argument parsing** in `apps/cli/src/program.ts`:

1. Validate duplicate global flags (`--json`, `--help`, `--version`) before any short-circuit.
2. Detect `--json` for machine-readable command output.
3. Strip global flags from positional args.
4. If `--help` is present, render top-level help or command-level help from the command registry and exit 0.
5. If `--version` is present, print the version and exit 0.
6. Determine interactive mode: enabled only when `--json` is absent, stdin is a TTY, and stdout is a TTY.
7. If no positional args or first arg is `"help"`, render top-level help or command-level help and exit without invoking command handlers.
8. Resolve the canonical command identity from the command registry and dispatch to `resolveCommand()`.

`resolveCommand()` routes to individual command handlers (`runDoctor`, `runCreate`, `runInit`, `runRepoAdd`, etc.). Every command validates that all provided positional arguments are consumed, rejecting extra or unknown arguments with a usage error before any side effects occur. Command errors are mapped to `CliError` before presentation.

### Command Specification (`apps/cli/src/command-spec.ts`)

All public commands are registered in `ALL_COMMANDS` as a single metadata source. Each entry declares the command path, human-readable description, positional arguments, command-specific options with required/repeatable/value-name annotations, and behavioral flags (mutation, interactive, JSON support, dry-run support). This registry drives:

- Top-level help text (`--help` output)
- Command-level help (`outpost help <command path>` and `outpost <command path> --help`)
- Command recognition and canonical command identity
- `outpost describe` and `outpost describe <command path>` (human and `--json` output)

**Output formatting:** returned command results are rendered as JSON envelopes when `--json` is present: `{ "ok": true | false, "command": "...", "data": { ... }, "exitCode": 0 | 1 }`. Success and partial results go to stdout; errors go to stderr with a stable `error.code` and descriptive `error.message`. Error codes are assigned explicitly at parser, router, and command-handler mapping boundaries; they are never inferred from message text. Known-command errors include the canonical command identity, while unknown or unresolvable commands use `null`. Error objects may include structured `diagnostics`, but diagnostics are omitted when none are available. In human mode, results are formatted as command-specific text. Help and version output remain plain text unless global argument validation fails first. Git subprocess stderr is piped and captured, never inherited as unstructured prose in JSON mode.

## Effect System Boundaries

The main command workflows use Effect services for:

- **FileSystem** (`effect/FileSystem`) — file reads, writes, directory listing, path resolution
- **Path** (`effect/Path`) — portable path manipulation
- **ChildProcessSpawner** (`effect/process/ChildProcessSpawner`) — child process spawning (`git` commands)
- **Console** (`effect/Console`) — stdout/stderr output

The `NodeServices.layer` is provided at the entry points in `apps/cli/src/cli.ts` and `apps/cli/src/index.ts`. Some process-level integration remains direct: TTY detection reads `process.stdin` and `process.stdout`, environment resolution reads `process.env`, timestamps use `Date`, lock metadata reads the PID and OS hostname and generates UUIDs, and interactive prompts use Node readline. Tests control those boundaries through temporary process state and mocks.

## Persisted State

All state lives under `$OUTPOST_HOME` (default `~/.outpost`):

```
~/.outpost/
  config.json           # OutpostConfig { version, outpostHome, reposRoot, worktreesRoot }
  repos.json            # RepoRegistry { repos: Array<RepoRecord> }
  .mutation.lock        # Exclusive home mutation owner metadata
  operations/
    <uuid>.json         # Intent and progress for an incomplete mutation
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

### Atomic Writes (`apps/cli/src/store.ts`)

`config.json`, `repos.json`, operation records, and workspace manifests are written atomically: write to a temp file in the same directory, then `rename` (atomic on same filesystem). If the rename fails, the temp file is cleaned up. This does not provide an fsync-based power-loss guarantee. Init writes or validates the registry first, then installs config as the initialization marker. A retry preserves an existing valid registry. Config without a registry is reported as incomplete initialization and requires inspection before registry restoration; init never replaces lost state with an empty registry.

### Configuration (`apps/cli/src/config.ts`)

`OutpostConfig` stores the home paths and a schema version (currently `1`). The `doctor` command reports whether the config and registry are valid. Config migration (`migrateConfig`) handles version upgrades; unknown future versions produce a clear error.

## Repository Identity

Repositories are identified by a canonical identity derived from their remote URL (`apps/cli/src/remote-identity.ts`):

- **Network repos** (SSH, HTTPS): identity = `hostname[:port]/path/segments`
- **File repos** (local paths): identity = canonical `file://` URL with resolved absolute path

The identity determines the managed mirror path under `repos/`. Path segments are percent-encoded to produce filesystem-safe names (`encodeManagedPathSegment`).

**Checked process execution** (`apps/cli/src/child-process.ts`): all Git helpers drain stdout and stderr concurrently with exit-status waiting, retaining at most 256 KiB per stream. String results require exit status zero and complete stdout. Exit-code probes explicitly accept nonzero results. The default 120-second timeout is configurable with `OUTPOST_GIT_TIMEOUT_MS`; checked execution applies an explicit termination policy to every standard command and pipeline member. POSIX commands run in separate process groups, with SIGTERM followed by SIGKILL after one second. This uses the existing Effect spawner's `forceKillAfter` option. The spawner may wait one additional second for the group after SIGKILL. Cleanup is included in timeout/interruption completion, rather than abandoned in the background. Diagnostic lines are appended individually so bounded output with many tiny lines cannot overflow the JavaScript argument stack.

**Managed mirrors** (`apps/cli/src/commands/repo-mirror.ts`): bare repos cloned with `git clone --mirror`. Before fetching, Outpost replaces the legacy mirror refspec with `+refs/heads/*:refs/remotes/origin/*` and disables `remote.origin.mirror`. Fetch uses `git fetch origin --prune --tags`. Existing `refs/heads` are never rewritten or pruned during this migration, preserving workspace commits. Create resolves bases from remote tracking refs first, then existing local branches. Git environment is sanitized (GCM_INTERACTIVE=never, GIT_TERMINAL_PROMPT=0).

**Registry** (`repos.json`): an ordered array of `RepoRecord` objects, each containing the identity, managed path, remote name and URL, timestamps. Repository IDs, names, and remote names are validated as non-empty semantic identifiers without ASCII control characters when state is read or written. Adding a repo with an identity that already exists in the registry updates the existing record rather than duplicating.

## Worktree and Branch Model

### Create (`apps/cli/src/commands/create.ts`)

`outpost create --ticket <id> --type <prefix> --repo <id> [--repo <id> ...] [--base <branch>] [--dry-run]`

Creates a branch `<type>/<ticket>` (e.g., `feat/PROJ-123`) on every specified managed repo, then creates a worktree for each at `<worktreesRoot>/<ticket>/<repo-name>`.

**Base branch resolution:**

- If `--base` provided: use that branch
- Otherwise: resolve HEAD symbolic ref from the bare mirror

**Validation (pre-flight):**

- Ticket, type, repository IDs, and an explicit base branch are validated as non-empty semantic identifiers without ASCII control characters before state or Git access
- Ticket and type are also validated for path segment safety
- Target branches must not already exist
- Base branches must exist
- No two repos may produce colliding worktree paths
- The ticket must not already have a manifest

**Transaction ordering:**

1. Create the workspace directory.
2. For each selected repository in order, create its branch and then its worktree.
3. Write `AGENTS.md` into the workspace directory.
4. Write the manifest to `workspaces/<ticket>.json` as the successful creation commit marker.

**Rollback** on failure or interruption before the manifest commit marker:

- Consider only worktrees whose creation returned success for this operation; verify repository association, unchanged branch and HEAD, then remove only clean worktrees with `git worktree remove` without force
- Consider only branches whose creation returned success for this operation; delete only unlinked branches whose commit still matches the immutable starting commit, using compare-and-delete `git update-ref -d <ref> <expected-oid>`
- Delete AGENTS.md (only if content matches the snapshot — never delete user-modified files)
- Remove workspace directory (only if empty via `rmdir`)

The directory-creation ownership flag, generated guidance snapshot, and manifest commit marker are installed in short uninterruptible filesystem sections. A late cancellation after manifest commit preserves the completed workspace. Git commands remain interruptible and scoped. Intent is journaled before execution, but an artifact becomes eligible for rollback only after the Git command returns success. An interruption mask protects the short transition from successful command result to in-memory confirmation; the Git command itself is restored to interruptible execution. A failed or interrupted mutation leaves creation unconfirmed, even when it may have installed a partial artifact. These artifacts are preserved for manual inspection. A matching path, base commit, or bare-repository association never substitutes for operation confirmation.

**Dry-run:** validates all inputs and produces a plan, but does not acquire locks or mutate any state.

**Interactive vs non-interactive:**

- Interactive mode (TTY, no `--json`): prompts for missing `--ticket`, `--type`, and `--repo` values using `node:readline/promises`. Handles SIGINT gracefully.
- Non-interactive mode: all `--ticket`, `--type`, and at least one `--repo` are required. Missing args produce an error.

### Workspace Remove (`apps/cli/src/commands/workspace-remove.ts`)

`outpost workspace remove <ticket> [--json]`

**Removal safeguards:**

1. Acquire the home mutation lock, then the ticket lock, and read and validate the manifest.
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
8. Release the ticket lock, then the home mutation lock.

**Partial cleanup:** worktree removal failures, concurrent changes to the approved `AGENTS.md` snapshot, residual directory entries, and workspace-directory inspection or removal failures produce a structured partial result and retain the manifest for retry. Other unexpected I/O failures can terminate with a plain command error. Preflight failures occur before worktree teardown begins.

**Branch preservation:** `git worktree remove` removes only the worktree metadata and directory. The branch in the bare mirror is preserved.

### Workspace List (`apps/cli/src/commands/workspace-list.ts`)

Scans `workspaces/` for manifest files and `worktrees/` for directories without manifests (unmanaged workspaces). Derives a status for each:

| Status      | Condition                                                             |
| ----------- | --------------------------------------------------------------------- |
| `ready`     | Manifest valid, all repos and worktrees exist, ownership checks pass  |
| `missing`   | The workspace directory, a worktree, or a managed repo path is absent |
| `invalid`   | Manifest unreadable, path resolution fails, or ownership check fails  |
| `unmanaged` | Directory exists in worktrees root but no manifest                    |

## Workspace Manifests (`apps/cli/src/workspace-manifest.ts`)

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

All paths in the manifest are relative to their respective roots (`reposRoot` or `worktreesRoot`). Ticket, type, branch, and repository identity fields are validated as non-empty semantic identifiers without ASCII control characters. Paths retain their domain-specific validation and are not treated as identifiers. The manifest is validated exhaustively on read and before write: semantic field validation, ticket identity collision detection, path containment checks, path uniqueness enforcement, and worktree single-segment checks.

## Mutation and ticket locks

`apps/cli/src/mutation-lock.ts` provides a conservative exclusive home mutation lock. Init, repo add/fetch/remove, create, and workspace remove acquire it with create-if-absent semantics before reading mutable snapshots. Contention fails immediately with a retry message. Create and workspace remove then acquire their existing ticket locks. The global order is home lock, then ticket lock, with release in reverse order through scoped Effect finalizers. Read-only commands and create dry-run do not acquire these locks. These locks coordinate Outpost processes; they do not block external Git or filesystem tools.

Home lock metadata includes a UUID, operation name, PID, hostname, timestamp, and operation-record path. Ticket locks also include PID, hostname, ticket, and timestamp; their filenames normalize case and trailing spaces/dots. Home lock release compares the recorded owner bytes before unlinking, and runs even if writing final operation status fails. Lock files are never reaped based on age or process checks.

Before artifact mutation, commands append intent/progress to an atomic `operations/<uuid>.json` record. Create records the full plan, including immutable starting commits, before making the workspace directory, and records branch, worktree, and manifest steps before execution. Branch and worktree journal entries distinguish `phase: "intent"` from `phase: "confirmed"`; confirmations are appended after successful execution. Journals remain inspection evidence and cannot be replayed as deletion authority. Removal records paths before deletion; import and fetch record their target repositories. Successful command effects remove their record. Failed/interrupted effects retain it, including successful rollback outcomes. Workspace remove partial results retain their manifest for retry.

Doctor reads metadata and reports workspace health, including commit resolution of actual HEAD, without enforcing the creation-time branch. Invalid HEAD, missing paths, or ownership mismatch cannot be ready. Changed branches and detached valid commits are accepted. Doctor exposes operation records in JSON and human output and performs no recovery mutations. A record is evidence of attempted work, not authority to delete or adopt an artifact.

SIGINT/SIGTERM trigger cleanup finalizers with the same escalation policy as command timeouts. Tests cover a SIGTERM-resistant direct child, external fiber interruption, a real Git descendant retaining inherited stdout/stderr, and a same-group descendant whose original leader already exited. Each regression has a watchdog that cleans up a broken implementation and fails the test. SIGKILL, machine crashes, and storage failures can leave locks, incomplete metadata, and partially installed Git artifacts. Manual recovery requires verifying the recorded process/host, actual Git worktree registrations, refs, cleanliness, guidance ownership, and residual files before releasing specific locks. Neither an old PID nor a journal proves an artifact safe to delete. There is no automatic force recovery or residual-directory adoption. Atomic writes are not a filesystem transaction across Git and Outpost state.

Process cleanup is limited by the OS and the installed Effect spawner. POSIX group signaling does not reach descendants that create a different session/group; it also inherits numeric group-ID reuse limits. Processes stuck in the kernel or inaccessible to the caller cannot be promised a strict wall-clock exit bound. Windows uses `taskkill` while the leader is alive and cannot promise descendant cleanup after leader exit. These changes are exercised on Linux; macOS and Windows remain unverified. The command timeout is not a promise of arbitrary process-tree termination.

## Workspace AGENTS.md (`apps/cli/src/workspace-agents.ts`)

When a workspace is created, Outpost generates an `AGENTS.md` file in the workspace directory using exclusive-create semantics (hard link from temp file — fails if the file already exists). The file contains workspace metadata (ticket, branch) and a per-repository block with the repo name, ID, worktree path, expected branch, and base branch.

**Ownership marker:** the first line is `<!-- outpost:workspace-agents sha256=<64-char-hex> -->`. The SHA256 is computed over the body (all content after the marker).

**Ownership classification** on workspace remove:

- `"missing"` — file absent
- `"foreign"` — file present but no Outpost marker
- `"generated"` — marker exists and hash matches (unmodified)
- `"modified"` — marker exists but hash does not match (user edited)

Outpost automatically deletes `"generated"` files. A `"foreign"` or `"modified"` file is deleted only after explicit interactive approval; non-interactive removal fails. Deletion compares the exact classified snapshot immediately before removal so a concurrently changed file is preserved.

Repository mutation boundaries validate absolute registry paths through `resolveManagedPath`, including canonical ancestor containment, and require the identity-derived managed path for legacy mirrors without ownership markers. Marked repositories may retain a registered relocated path within the root. Create reserves the generated `AGENTS.md` path with the same canonical portable identity checks as worktree paths. Ownership requires a bare Git repository, a matching local origin URL, and either a matching `outpost.repository-id` local Git config marker or the legacy mirror refspec at the expected registered path. Repo add writes the marker after a successful import; it refuses unregistered pre-existing directories. Fetch and create preflight also verify ownership before modifying a repository. Repo removal additionally inspects `git worktree list --porcelain -z` and refuses all linked entries regardless of manifest presence. Missing mirrors may be safely unregistered after path and manifest checks. Unmanaged-directory warnings are structured command data; only the human renderer prints them to stderr.

## Path Safety (`apps/cli/src/path-safety.ts`)

Path and semantic identifier validation are separate contracts:

- `validateSemanticIdentifier()` and `semanticIdentifierSchema()` — reject empty values and ASCII control characters (`U+0000` through `U+001F`, plus `U+007F`) without trimming, Unicode normalization, or applying identifier rules to filesystem paths and raw remote URLs
- `validatePathSegment()` — rejects path separators and, by default, traversal segments
- `resolvePathWithinRoot()` — resolves a path lexically and verifies that it remains within the root directory
- `getCanonicalPortablePathKey()` — normalizes paths (lowercase, unified separators) for collision detection

## Module Ownership

| Module                                             | Responsibility                                                              |
| -------------------------------------------------- | --------------------------------------------------------------------------- |
| `apps/cli/src/cli.ts`                              | Executable binary entry point, unconditional startup, exit-code propagation |
| `apps/cli/src/index.ts`                            | API entry point, programmatic `runCli()` export, import-safe                |
| `apps/cli/src/program.ts`                          | CLI routing, arg parsing, output formatting, help text                      |
| `apps/cli/src/config.ts`                           | Config schema, read/write, migration                                        |
| `apps/cli/src/mutation-lock.ts`                    | Shared mutation lock, operation progress, and recovery inspection           |
| `apps/cli/src/store.ts`                            | Atomic JSON/text file writes                                                |
| `apps/cli/src/path-safety.ts`                      | Path segment validation, containment checks                                 |
| `apps/cli/src/remote-identity.ts`                  | Remote URL parsing, identity derivation, managed path encoding              |
| `apps/cli/src/workspace-manifest.ts`               | Manifest schema, CRUD, validation, status derivation, ticket locks          |
| `apps/cli/src/workspace-agents.ts`                 | AGENTS.md generation, ownership classification, deletion                    |
| `apps/cli/src/types.ts`                            | Shared types (`CommandOutput`)                                              |
| `apps/cli/src/commands/create.ts`                  | Create command with rollback                                                |
| `apps/cli/src/commands/create-prompt.ts`           | Interactive prompting for create                                            |
| `apps/cli/src/commands/init.ts`                    | Initialize Outpost home                                                     |
| `apps/cli/src/commands/doctor.ts`                  | Environment status report                                                   |
| `apps/cli/src/commands/repo-add.ts`                | Register a local repo                                                       |
| `apps/cli/src/commands/repo-mirror.ts`             | Git clone/fetch mirror operations                                           |
| `apps/cli/src/commands/repo-fetch.ts`              | Fetch all managed mirrors                                                   |
| `apps/cli/src/commands/repo-list.ts`               | List registered repos                                                       |
| `apps/cli/src/commands/repo-show.ts`               | Show repo details                                                           |
| `apps/cli/src/commands/repo-remove.ts`             | Remove registered repo (with workspace reference check)                     |
| `apps/cli/src/commands/workspace-list.ts`          | List workspaces with derived status                                         |
| `apps/cli/src/commands/workspace-show.ts`          | Show workspace details                                                      |
| `apps/cli/src/commands/workspace-remove.ts`        | Remove workspace with safety checks                                         |
| `apps/website/`                                    | Private Astro static marketing landing page workspace                       |
| `apps/cli/src/commands/workspace-remove-prompt.ts` | Interactive prompting for AGENTS.md consent                                 |

## Agent command contract

The command registry is the source for help, discovery and generic argument shape
validation. `parseCommandInput` rejects unknown options, duplicates, missing values
and surplus positional arguments before dispatch. It normalizes named arguments
and option values into arrays. Required create options can be filled by an
interactive prompt; identifier, Git and ownership checks remain in the commands.
`renderer.ts` owns text and JSON formatting, while `program.ts` selects and runs
commands.

`describe --json` reports an independently versioned `contractVersion` and the
installed `cliVersion`. Each command includes normalized input and output JSON
Schemas, explicit network policy, retry policy, side effects and advisory dry-run
behavior. Output types derive from the executable schemas in `result-schemas.ts`;
only untrusted recovery metadata and JSON Schema documents contain opaque JSON.
Help keeps its text contract, so its JSON output schema is null.

Command-level error codes remain stable. Domain errors also carry `reason`,
`retryable` and `action` through typed wrappers. Reasons are assigned at checks
such as held locks, dirty worktrees, missing or in-use repos and guidance consent.
Error mapping never classifies message text. A retryable held lock means waiting
for the owner, not permission to remove the lock or repeat a mutation blindly.

Repository subprocess diagnostics retain at most 40 lines and 8,192 characters
per stream, 80 lines and 16,384 characters total. `diagnosticTruncation` reports
`truncated`, the number of omitted nonblank captured lines, whether the underlying
byte capture was truncated, and the configured total limits. A clipped long line
sets `truncated` even when no whole line was omitted. Counts cannot include data
beyond the subprocess capture limit. This bounds formatted JSON expansion from
many tiny lines. Human error summaries and partial-result stream routing are
unchanged.

`repo remove --dry-run` and `workspace remove --dry-run` execute the same preflight
as removal, then stop before acquiring locks, writing intent or deleting anything.
Workspace status uses Git's `--no-optional-locks`. A preview reports modified or
foreign guidance and the approval it would need without prompting, and reports
residual files that execution would preserve. Previews are advisory snapshots;
execution always repeats validation under the normal home and ticket locks.
The shared path planner reserves the canonical `AGENTS.md` identity both when
creating a workspace and when validating an existing manifest.
