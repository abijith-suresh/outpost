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

**Executable entry point:** `apps/cli/src/cli.ts` is the dedicated executable binary entry point pointed to by `apps/cli/package.json#bin`. It starts unconditionally and propagates numeric results through `process.exitCode`. Pure help/version/global-validation output runs at the process boundary before loading Effect. Discovery loads a small filesystem-only Effect runtime. State commands lazily load `runtime.ts`, which provides the full Node services and `NodeRuntime.runMain` lifecycle/signal handling.

**API entry point:** `apps/cli/src/index.ts` loads the package version and exports the asynchronous `runCli()` for programmatic use. Importing it loads neither Effect nor command handlers. It is import-safe with no side effects — importing the package does not execute the CLI.

**Argument parsing** starts in the pure `early-output.ts` prelude, shared by the executable, API and Effect program:

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

The full `NodeServices.layer` is provided lazily in `runtime.ts`. Discovery uses only `NodeFileSystem.layer` in `discovery-runtime.ts`. Pure early output uses console at the process boundary and returns an exit code; it performs no state workflow. Other process-level integration remains direct: TTY detection reads `process.stdin` and `process.stdout`, environment resolution reads `process.env`, timestamps use `Date`, lock metadata reads the PID and OS hostname and generates UUIDs, and interactive prompts use Node readline. Tests control those boundaries through temporary process state and mocks.

## Persisted State

All state lives under `$OUTPOST_HOME` (default `~/.outpost`):

```
~/.outpost/
  config.json           # OutpostConfig { version, outpostHome, reposRoot, worktreesRoot }
  repos.json            # legacy/v2/v3 managed records or v4 tagged storage records
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

`OutpostConfig` reads legacy version 1, version 2 and version 3. Read-only commands do not migrate files. Configuration, repository-tag and extra-guidance mutations acquire the home mutation lock and install version 2 default configuration before extended state is written. The config marker makes newly started version 1 binaries refuse the home. The persisted version 2 repository registry uses `{ version: 2, repositories: [...] }`, adapted to the existing in-memory `repos` model. Its missing legacy `repos` field also makes an older process that cached v1 config before taking the lock refuse the registry before mutation. Unknown future versions and malformed version fields fail closed.

Upgrading settings writes the default config barrier, then the incompatible registry barrier, then the requested root/instructions. Tag editing writes the default config barrier followed by the versioned tagged registry atomically. A failure before a requested setting commits leaves compatible defaults and an inspectable journal; retry repairs forward. Initialization refuses to recreate a missing config when a version 2 or 3 registry remains, because it cannot reconstruct historical roots or instructions from that registry.

Version 2 configuration saves `legacyWorktreesRoot`, the root used by unversioned manifests, and `trustedWorktreesRoots`, the roots available to versioned manifests. `config set worktreesRoot <absolute-path>` records the new future root without moving worktrees or rewriting manifests. Version 2, 3 and 4 manifests pin their root; unversioned manifests keep resolving against the saved original root. Inspection and removal use the manifest's validated root, rather than today's default. Root changes never replace `AGENTS.md`. This avoids a partially completed bulk-manifest migration and leaves an interruption after the config write as valid version 2 state. Old metadata backups cannot safely be restored over newly created workspaces; repair forward with the newer binary.

`config show` exposes validated settings. `guidance set <file>` reads bounded UTF-8 plaintext into optional global `extraInstructions`; `guidance clear` removes it. `guidance preview` uses create preflight and the same factual `AGENTS.md` renderer without locks or writes. These settings affect future generation only. The command adapter and application operations remain in the CLI package, with Effect workflows and the existing filesystem/Git boundaries; there is no HTTP server or daemon in this phase.

Repository records may contain optional flat `tags`. `repo tag <id> --add <tag> --remove <tag>` edits them under the home lock. `repo list --tag` and `create --tag` require every supplied tag to match. Explicit `--repo` IDs remain supported; when combined, tags filter that explicit set. The create plan freezes concrete repository IDs into the manifest. Later tag edits, fetches and reimports preserve that membership and retained tags.

## Repository Identity

Repositories are identified by a canonical identity derived from their remote URL (`apps/cli/src/remote-identity.ts`):

- **Network repos** (SSH, HTTPS): identity = `hostname[:port]/path/segments`
- **File repos** (local paths): identity = canonical `file://` URL with resolved absolute path

The identity determines the managed mirror path under `repos/`. Path segments are percent-encoded to produce filesystem-safe names (`encodeManagedPathSegment`).

**Checked process execution** (`apps/cli/src/child-process.ts`): all Git helpers drain stdout and stderr concurrently with exit-status waiting, retaining at most 256 KiB per stream. String results require exit status zero and complete stdout. Exit-code probes explicitly accept nonzero results. The default 120-second timeout is configurable with `OUTPOST_GIT_TIMEOUT_MS`; checked execution applies an explicit termination policy to every standard command and pipeline member. POSIX commands run in separate process groups, with SIGTERM followed by SIGKILL after one second. This uses the existing Effect spawner's `forceKillAfter` option. The spawner may wait one additional second for the group after SIGKILL. Cleanup is included in timeout/interruption completion, rather than abandoned in the background. Diagnostic lines are appended individually so bounded output with many tiny lines cannot overflow the JavaScript argument stack.

**Managed mirrors** (`apps/cli/src/commands/repo-mirror.ts`): bare repos cloned with `git clone --mirror`. Before fetching, Outpost replaces the legacy mirror refspec with `+refs/heads/*:refs/remotes/origin/*` and disables `remote.origin.mirror`. Fetch uses `git fetch origin --prune --tags`. Existing `refs/heads` are never rewritten or pruned during this migration, preserving workspace commits. Create selects an explicit base source; cached-remote is the default with no local fallback. Fresh creation uses a separate targeted checked fetch rather than the bulk mirror fetch/prune path. Git environment is sanitized (GCM_INTERACTIVE=never, GIT_TERMINAL_PROMPT=0).

The checked Git adapter adds command-scoped `-c core.longpaths=true` on Windows. Internal pack/admin files can exceed 260 characters without writing system, global or repository configuration. This option does not remove Git's repository startup or cwd limits.

### Windows Git path budgets

`windows-git-path.ts` applies conservative bounds to canonical full paths for named operations that mutate Git or select a future workspace root. Existing metadata is not rejected on load merely because its paths exceed these bounds. Read-only settings, repository and workspace inspection retain historical records.

| Path | Supported maximum | Reason |
| --- | --- | --- |
| Managed bare Git directory | 220 UTF-8 bytes | Git's explicit `GIT_DIR` startup guard rejects `strlen(GIT_DIR) > PATH_MAX - 40`; the MinGW default `PATH_MAX` is 260. Clone exports its canonical Git directory to internal children. |
| Checkout `.git` path | 220 UTF-8 bytes | Worktree add supplies this path as its checkout child's `GIT_DIR`, before Git resolves the back-pointer to the administrative directory. |
| Invocation cwd, source checkout, local file-remote directory and workspace checkout | 258 UTF-16 code units | Win32 process creation needs a trailing separator and NUL within `MAX_PATH`. Git's separate `mingw_getcwd` buffer admits 259 units, but native Node spawning already fails at that length. |
| Derived worktree administrative directory | 243 UTF-16 code units | Linked-worktree startup checks `/HEAD` and `/commondir`, and may read `/config.worktree` before `core.longpaths` is available. Reserve the longest of these, 16 units, and NUL: `243 + 16 + 1 = 260`. |

[Microsoft's SetCurrentDirectory documentation](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-setcurrentdirectory) describes the trailing-separator and NUL reservation for process creation. Native Node CI rejected a direct 259-unit cwd before Git started. The process ceiling reserves both units rather than relying on short-name substitution.

The derivation uses [Git for Windows setup.c](https://github.com/git-for-windows/git/blob/v2.56.0.windows.2/setup.c), [worktree.c](https://github.com/git-for-windows/git/blob/v2.56.0.windows.2/builtin/worktree.c), [mingw_getcwd](https://github.com/git-for-windows/git/blob/v2.56.0.windows.2/compat/mingw.c), and [MinGW limits.h](https://github.com/mingw-w64/mingw-w64/blob/master/mingw-w64-headers/crt/limits.h). Git for Windows' `are_long_paths_enabled` returns false before the configuration cache is initialized. `read_gitfile_gently`, `is_git_directory` and `read_and_verify_repository_format` inspect linked-worktree files before the reset builtin loads normal configuration. The 243-unit administrative bound includes `extensions.worktreeConfig=true`; 249 would cover `/commondir` but leave `/config.worktree` inaccessible. Native CI at an administrative directory of 257 units confirmed `gitfile does not point to a valid repository`. The contract is deliberately bounded; it does not claim arbitrary deep-root support through `core.longpaths`.

Canonicalization uses the native Windows realpath operation on the deepest existing ancestor, then appends missing descendants. This resolves junctions and short-name aliases before counting. UTF-8 bytes are counted with `Buffer.byteLength`, while UTF-16 code units use JavaScript string length. Roots with spaces and Unicode follow the same checks. The raw path spelling passed to Git, including redundant separators or dot components, must also fit: the startup guard checks that spelling before resolving a junction, and cwd APIs may return it before canonicalization. A long alias to a short target therefore cannot bypass the budget either.

Root setting reserves the smallest valid `<root>/a/a/.git` layout before configuration/registry migration. Create and guidance preview check the actual managed paths, checkout paths and derived administrative directory. Git sanitizes the repository basename for its administrative name and tries the unsuffixed name, then numeric suffixes. The preflight reserves enough digits for the current administrative-directory entry count plus one, read under the home lock during mutation. It resolves the administrative parent, then appends the reserved name without following a hypothetical occupied leaf, which might itself be a junction to a shorter target. Every selected repository is checked before branch or worktree mutation. Fetch checks all registered targets before changing any refspec or refs. Removal checks all affected paths before teardown. The invocation cwd is also checked because commands using `--git-dir` still inherit it. Local file remotes are checked before clone or fetch because Git runs `upload-pack` in that directory.

Unsupported operations fail with the existing structured `invalid-arguments` reason and an actionable message identifying the canonical path, measured count, unit and budget. They preserve source data, refs, manifests, guidance, configuration, registry and unowned sentinels. Existing homes and roots are never moved or aliased; global Windows/Git settings are unchanged. A shorter future root can repair new workspace creation without hiding old metadata. Arbitrary config include targets, custom environment path overrides, hooks, submodules, external programs and noncooperating filesystem changes retain their own constraints. Existing containment, ownership, locks, output limits and timeouts continue to apply.

**Registry** (`repos.json`): active `RepoRecord` objects contain the identity, managed path, remote name and URL, timestamps. The version 3 format also retains unregistered records with `retainedAt`; active and retained identities and canonical paths must be unique across both sets. Repository IDs, names, and remote names are validated as non-empty semantic identifiers without ASCII control characters when state is read or written. Adding a repo with an identity that already exists in the registry updates the existing record rather than duplicating.

## Worktree and Branch Model

### Create (`apps/cli/src/commands/create.ts`)

`outpost create --ticket <id> --type <prefix> --repo <id> [--repo <id> ...] [--base-source <source>] [--base <ref>] [--dry-run]`

Creates a branch `<type>/<ticket>` (e.g., `feat/PROJ-123`) on every specified managed repo, then creates a worktree for each at `<worktreesRoot>/<ticket>/<repo-name>`.

**Base selection and provenance:**

`--base-source` is local, cached-remote or fresh-remote. Cached-remote is the
non-network default, with no implicit local fallback. Checked creation Git
operations disable lazy promisor fetching, including ref resolution and checkout;
explicit fresh fetches remain explicit. Missing owned commits or blobs fail
without silently contacting the promisor remote. Local selects only available
owned refs/objects. Cached resolves only selected remote-tracking refs. Fresh
requires a successful checked fetch of the selected upstream branch and captures
its actual immutable receipt; a cached ref is never substituted after failure.
An omitted `--base` uses each repository's recorded managed symbolic HEAD branch,
not a remotely rediscovered default. Fresh receipt parsing uses Git's
[machine-readable fetch output](https://git-scm.com/docs/git-fetch/2.43.0#_output),
not a later read of a mutable cached ref.

New manifest version 3 records source, requested ref, resolved ref and immutable
commit per repository and pins its trusted root. Legacy unversioned/v2 manifests
keep their original root interpretation and do not gain invented provenance.
Previous strict manifest decoders refuse version 3 before modifying its workspace.
The existing config/registry barriers and retained records stay intact.

Branch creation consumes the resolved SHA. Before manifest commit, creation
checks that the resulting branch/worktree still matches it. Base-ref races cannot
change the chosen starting commit; a changed target is refused and preserved.
Journals record the request, immutable plan and confirmed fresh receipts. Remote
refreshes are not part of a filesystem rollback and remain inspectable after
partial failure or interruption. Fresh selection fetches into an operation-owned
receipt namespace, then updates only the selected tracking ref with a no-dereference
compare-and-swap. Explicit ref mappings override legacy mirror refspecs; no pruning,
tag refresh, submodule recursion or automatic maintenance is requested. Confirmed
receipt cleanup occurs before the manifest commit, while the created branch and
tracking ref preserve the fetched object. Uncertain or changed receipts remain
journaled for inspection. Retained repository records are unchanged.

**Existing managed branch admission:**

Contract version `3.2.0` adds explicit branch reuse and factual branch disposition.

`create --reuse-branch <name>` is mutually exclusive with explicit `--base` and
`--base-source`. The existing ticket/type/repository selection stays required;
`--type` is a ticket category while the existing branch retains its exact name.
Every selected repository is ownership-checked first. A direct existing
`refs/heads/<name>` must resolve to an available commit and checkout objects;
`worktree list --porcelain -z` must show no attachment. There is no source import,
remote inference or fetch. Before resolving a reuse ref, bounded checks validate canonical object/ref storage and refuse alternate-pool metadata or filesystem aliases in selected object/ref paths. The same checks repeat under admission locks and before manifest admission. Git's ordinary object lookup through an external alternate pool is not treated as proof that objects are owned. The selected checkout object inventory is capped at 256 KiB and 8,192 object IDs. Metadata checks cover selected loose object fanouts/leaves and at most 1,024 pack metadata entries, including chained multi-pack indexes. Directory iteration stops at the bound rather than materializing an unbounded listing. Canonical paths and file identities are rechecked around traversal, under admission locks and before population/publication. Ordinary regular files, including surviving hardlinks, are supported. Replacement refs fail closed before traversal because replacement commit OIDs are absent from the normal selected-object inventory; their refs and source are preserved. No object-content scan, copy, repack or automatic repair occurs. Bounded tree/attribute preflight refuses tracked
submodules and assigned filters before checkout mutation.

After all-member preflight, the operation journals every borrowed ref/SHA and
starts one checked `git update-ref --no-deref --stdin` verify-only transaction per
member. `prepare` holds Git's ref locks. Direct symbolic identity and checkout
conflicts are rechecked under all locks, because a verify of the same SHA alone
can accept a symbolic ref. This is scoped Git transaction state, not an
Outpost-created branch or permission to commit a ref update. On ordinary exit or
fiber cancellation, ordered `abort` and stdin EOF must be acknowledged and the
Git child must exit. Confirmed release is checked before atomic manifest
publication, so later branch advancement remains current work rather than a new
admission. Forced termination is only a failure fallback, never proof
of successful release. Hard crashes leave recorded lock/artifact evidence for
manual recovery, without automatic lock reaping.

Ordinary `worktree add` attempts a HEAD ref update and conflicts with the prepared
lock. Reuse therefore uses `worktree add --no-checkout --no-guess-remote`, records
successful ownership, then populates only that new checkout with
`read-tree -m -u --no-recurse-submodules <immutable-SHA>`. Unlike `--reset`, this
one-way merge refuses untracked or modified files that would be overwritten.
No reset, force checkout or branch update is used. Branch lock liveness, direct
ref identity, checkout association/branch/HEAD and resume's bounded safe
index/status rules are rechecked before admitting the manifest. External tools
can bypass Git locks by overwriting files directly; raced or changed work is
refused and preserved, never reset to make a check pass.

Only reuse writes manifest version 4. Each member records
`branchDisposition: existing` alongside `baseSource: local`, requested existing
branch, full ref and immutable admission `baseCommit`. The schema requires these
facts to match the frozen branch. Older strict version 3 loaders refuse the
manifest before removing or rewriting it. Ordinary create keeps version 3 and
reports `branchDisposition: created` in results. Show and resume preserve the
existing-branch fact; resume's current HEAD remains separate. Existing branches
never enter the in-memory rollback branch list, and no recovery journal grants
branch deletion ownership. Removal already preserves every local branch.

**Validation (pre-flight):**

- Ticket, type, repository IDs, and an explicit base branch are validated as non-empty semantic identifiers without ASCII control characters before state or Git access
- Ticket and type are also validated for path segment safety
- Ordinary new-branch targets must not already exist; explicit reuse requires an existing unlinked direct local branch
- Local/cached selections require an owned commit and its selected checkout objects; fresh execution validates fetched objects, while a fresh preview leaves remote existence unresolved
- No two repos may produce colliding worktree paths
- The ticket must not already have a manifest

**Transaction ordering:**

1. Preflight every selected member, resolve offline sources or explicitly refresh fresh sources, and journal immutable receipts. Preserve any completed refresh after failure. Install trusted-root metadata before writing a provenance manifest.
2. Create the workspace directory.
3. For each selected repository in order, create its branch and then its worktree from the immutable plan, checking actual branch/HEAD before committing provenance.
4. Write `AGENTS.md` into the workspace directory.
5. Write the manifest to `workspaces/<ticket>.json` as the successful creation commit marker.

**Rollback** on failure or interruption before the manifest commit marker:

- Consider only worktrees whose creation returned success for this operation; verify repository association, unchanged branch and HEAD, then remove only clean worktrees with `git worktree remove` without force
- Consider only branches whose creation returned success for this operation; preserve symbolic refs, and delete only unlinked direct refs whose commit still matches the immutable starting commit, using compare-and-delete `git update-ref --no-deref -d <ref> <expected-oid>` so a raced symbolic ref cannot delete its user-owned destination
- Delete AGENTS.md (only if content matches the snapshot — never delete user-modified files)
- Remove workspace directory (only if empty via `rmdir`)

The directory-creation ownership flag, generated guidance snapshot, and manifest commit marker are installed in short uninterruptible filesystem sections. A late cancellation after manifest commit preserves the completed workspace. Git commands remain interruptible and scoped. Intent is journaled before execution, but an artifact becomes eligible for rollback only after the Git command returns success. An interruption mask protects the short transition from successful command result to in-memory confirmation; the Git command itself is restored to interruptible execution. A failed or interrupted mutation leaves creation unconfirmed, even when it may have installed a partial artifact. These artifacts are preserved for manual inspection. A matching path, base commit, or bare-repository association never substitutes for operation confirmation.

**Dry-run:** validates local state and produces a plan, but does not acquire locks, fetch or mutate refs/configuration. Local/cached sources resolve actual owned commits. Fresh plans explicitly report fetch-required with no resolved fresh commit; execution resolves again after fetching. Guidance preview follows the same rule.

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

Scans `workspaces/` for manifest files and every recorded workspace root for directories without valid managed paths (unmanaged workspaces). Old-root residual directories stay visible after a default-root change. Derives a status for each:

| Status      | Condition                                                             |
| ----------- | --------------------------------------------------------------------- |
| `ready`     | Manifest valid, all repos and worktrees exist, ownership checks pass  |
| `missing`   | The workspace directory, a worktree, or a managed repo path is absent |
| `invalid`   | Manifest unreadable, path resolution fails, or ownership check fails  |
| `unmanaged` | Directory exists in worktrees root but no manifest                    |

### Workspace resume

`outpost workspace resume <ticket>` is a named-ticket, read-only operation. It
loads the frozen manifest/root/member identities, validates selected registration
and repository/worktree ownership, then reports current branch, HEAD and bounded
working-state entries separately from recorded `originalBase` provenance. Legacy
unversioned/v2 manifests retain their root interpretation and expose only recorded
facts. Advanced or diverged commits and dirty/untracked work on the expected
branch are resumable; wrong/detached branches, missing/foreign/inconsistent members
and unavailable or retained registration produce member diagnostics. Complete
readiness exits 0. Partial/not-ready outcomes retain structured data and exit 1.

Resume never resolves a new base, fetches, imports, changes refs, refreshes Git
worktree state, creates checkouts, moves paths, migrates metadata or overwrites
guidance. It does not acquire or create mutation locks/journals. Existing home or
ticket locks prevent readiness; metadata and lock snapshots are rechecked before
returning. This is advisory inspection, not a lock on external Git activity.
Missing or incomplete manifests point to doctor/manual recovery; matching paths
cannot establish ownership of interrupted creation residuals. Create conflict
checks direct the caller to explicit resume before fresh fetches.

Read-only Git commands disable optional writes and implicit promisor fetching,
including shared workspace health probes. Status is checked through the verified
checkout gitfile with the existing Windows path budgets. Bounded porcelain output
produces counts without paths; collapsed untracked directories count as entries.
Unavailable or truncated status is unknown, never clean. Resume bounds metadata,
member and subprocess output and inspects no unrelated repository storage. Its
registry reader retains schema/identity/lexical uniqueness validation without
probing unrelated canonical paths; selected members receive full canonical
containment and ownership checks. Mutation callers keep their existing registry
validation.

Managed resume preflights bounded tracked entries and filter attributes before invoking
status. Tracked gitlinks and assigned content filters produce unknown/not-ready
diagnostics, preventing nested status/filter execution. Unused globally
configured filters do not by themselves block resume. This conservative status
limit is explicit; no custom filter program is run to obtain a clean result.
Before index-reading Git commands, bounded checksum/entry/extension inspection
also refuses split indexes, whose shared index timestamps Git can renew during
reads. Normal index versions 2/3/4 are inspected; unsupported or invalid formats
produce unknown status without repair. Shared indexes remain untouched.
Inherited repository layout overrides are refused before Git inspection, including
alternate index/common/object storage. This prevents an alternate index from
producing a false clean result for the verified checkout. Diagnostics expose
variable names only; no process/global settings are changed.

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

The example above is the legacy unversioned shape. New manifests use `version: 3`, an absolute trusted `worktreesRoot`, and complete per-member `baseSource`, nullable `requestedBase`, `baseRef` and full `baseCommit` provenance. Version 2 manifests retain their saved roots without gaining provenance. Repository paths remain relative to `reposRoot`; workspace paths remain relative to the manifest's saved root. Unversioned manifests use `legacyWorktreesRoot` (or the current root in version 1 configuration). Ticket, type, branch, and repository identity fields are validated as non-empty semantic identifiers without ASCII control characters. Paths retain their domain-specific validation and are not treated as identifiers. The manifest is validated exhaustively on read and before write: schema version, provenance completeness, trusted root, semantic field validation, ticket identity collision detection, path containment checks, path uniqueness enforcement, and worktree single-segment checks.

## Mutation and ticket locks

`apps/cli/src/mutation-lock.ts` provides a conservative exclusive home mutation lock. Init, repo add/fetch/remove/tag, config set, guidance set/clear, create, and workspace remove acquire it with create-if-absent semantics before reading mutable snapshots. Contention fails immediately with a retry message. Create and workspace remove then acquire their existing ticket locks. The global order is home lock, then ticket lock, with release in reverse order through scoped Effect finalizers. Read-only commands, guidance preview and create dry-run do not acquire these locks. These locks coordinate Outpost processes; they do not block external Git or filesystem tools.

Home lock metadata includes a UUID, operation name, PID, hostname, timestamp, and operation-record path. Ticket locks also include PID, hostname, ticket, and timestamp; their filenames normalize case and trailing spaces/dots. Home lock release compares the recorded owner bytes before unlinking, and runs even if writing final operation status fails. Lock files are never reaped based on age or process checks.

Before artifact mutation, commands append intent/progress to an atomic `operations/<uuid>.json` record. Create records the full plan, including immutable starting commits, before making the workspace directory, and records branch, worktree, and manifest steps before execution. Branch and worktree journal entries distinguish `phase: "intent"` from `phase: "confirmed"`; confirmations are appended after successful execution. Journals remain inspection evidence and cannot be replayed as deletion authority. Removal records paths before deletion; import and fetch record their target repositories. Successful command effects remove their record. Failed/interrupted effects retain it, including successful rollback outcomes. Workspace remove partial results retain their manifest for retry.

Doctor reads metadata and reports workspace health, including commit resolution of actual HEAD, without enforcing the creation-time branch. Invalid HEAD, missing paths, or ownership mismatch cannot be ready. Changed branches and detached valid commits are accepted. Doctor exposes operation records in JSON and human output and performs no recovery mutations. A record is evidence of attempted work, not authority to delete or adopt an artifact.

SIGINT/SIGTERM trigger cleanup finalizers with the same escalation policy as command timeouts. Tests cover a SIGTERM-resistant direct child, external fiber interruption, a real Git descendant retaining inherited stdout/stderr, and a same-group descendant whose original leader already exited. Each regression has a watchdog that cleans up a broken implementation and fails the test. SIGKILL, machine crashes, and storage failures can leave locks, incomplete metadata, and partially installed Git artifacts. Manual recovery requires verifying the recorded process/host, actual Git worktree registrations, refs, cleanliness, guidance ownership, and residual files before releasing specific locks. Neither an old PID nor a journal proves an artifact safe to delete. There is no automatic force recovery or residual-directory adoption. Atomic writes are not a filesystem transaction across Git and Outpost state.

Process cleanup is limited by the OS and the installed Effect spawner. POSIX group signaling does not reach descendants that create a different session/group; it also inherits numeric group-ID reuse limits. Processes stuck in the kernel or inaccessible to the caller cannot be promised a strict wall-clock exit bound. Windows uses `taskkill` while the leader is alive and cannot promise descendant cleanup after leader exit. These changes are exercised on Linux; macOS and Windows remain unverified. The command timeout is not a promise of arbitrary process-tree termination.

## Workspace AGENTS.md (`apps/cli/src/workspace-agents.ts`)

When a workspace is created, Outpost generates an `AGENTS.md` file in the workspace directory using exclusive-create semantics (hard link from temp file — fails if the file already exists). The file contains workspace metadata (ticket, branch) and a per-repository block with the repo name, ID, worktree path, expected branch, base selection source/ref and actual immutable starting commit when available. Fresh read-only previews state that resolution requires a fetch; legacy manifests do not gain fabricated facts. Optional global extra instructions follow these facts as plaintext. The ownership hash covers both the generated facts and the extra instructions. Changing settings never regenerates an existing file.

**Ownership marker:** the first line is `<!-- outpost:workspace-agents sha256=<64-char-hex> -->`. The SHA256 is computed over the body (all content after the marker).

**Ownership classification** on workspace remove:

- `"missing"` — file absent
- `"foreign"` — file present but no Outpost marker
- `"generated"` — marker exists and hash matches (unmodified)
- `"modified"` — marker exists but hash does not match (user edited)

Outpost automatically deletes `"generated"` files. A `"foreign"` or `"modified"` file is deleted only after explicit interactive approval; non-interactive removal fails. Deletion compares the exact classified snapshot immediately before removal so a concurrently changed file is preserved.

Repository mutation boundaries validate absolute registry paths through `resolveManagedPath`, including canonical ancestor containment, and require the identity-derived managed path for legacy mirrors without ownership markers. Marked repositories may retain a registered relocated path within the root. Create reserves the generated `AGENTS.md` path with the same canonical portable identity checks as worktree paths. Ownership requires a bare Git repository, a matching local origin URL, and either a matching `outpost.repository-id` local Git config marker or the legacy mirror refspec at the expected registered path. Repo add writes the marker after a successful import; it refuses unregistered pre-existing directories. Fetch and create preflight also verify ownership before modifying a repository. Repo removal additionally inspects `git worktree list --porcelain -z` and refuses all linked entries regardless of manifest presence. Missing mirrors may be unregistered into retained metadata after path and manifest checks; restoration requires validated storage. Unmanaged-directory warnings are structured command data; only the human renderer prints them to stderr.

## Path Safety (`apps/cli/src/path-safety.ts`)

Path and semantic identifier validation are separate contracts:

- `validateSemanticIdentifier()` and `semanticIdentifierSchema()` — reject empty values and ASCII control characters (`U+0000` through `U+001F`, plus `U+007F`) without trimming, Unicode normalization, or applying identifier rules to filesystem paths and raw remote URLs
- `validatePathSegment()` — rejects path separators and, by default, traversal segments
- `validatePortableFilename()` — additionally rejects Windows device names, invalid filename characters and trailing dots/spaces for newly created ticket/repository directories; legacy paths retain their existing read validation
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
| `apps/cli/src/commands/settings.ts`                | Validated future-root, tag and extra-guidance operations and preview         |
| `apps/cli/src/commands/doctor.ts`                  | Environment status report                                                   |
| `apps/cli/src/commands/repo-add.ts`                | Register a local repo                                                       |
| `apps/cli/src/commands/repo-mirror.ts`             | Git clone/fetch mirror operations                                           |
| `apps/cli/src/commands/repo-fetch.ts`              | Fetch all active managed mirrors                                            |
| `apps/cli/src/commands/repo-restore.ts`            | Validate retained identity and reactivate registration without fetching      |
| `apps/cli/src/commands/repo-list.ts`               | List registered repos                                                       |
| `apps/cli/src/commands/repo-show.ts`               | Show repo details                                                           |
| `apps/cli/src/commands/repo-remove.ts`             | Unregister while retaining owned storage and recovery record                     |
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

Contract version `1.1.0` added settings, tags and guidance commands and made
`--repo` optional when tag selection is supplied. The package version is unchanged;
metadata version 2 separately protects stored state from older writers.

Contract version `2.0.0` changed repository removal to registration-only retention,
adds retained inspection and offline restoration, and reports the explicit storage
outcome. The package version is independent of this machine contract version.

Contract version `3.0.0` adds explicit base sources and immutable commit
provenance. Cached selection no longer falls back to local branches. Create's
network policy declares that explicit fresh selection can fetch; the default
cached mode and all previews remain offline. Manifest version 3 independently
protects stored provenance from incompatible older readers.

Contract version `3.1.0` added explicit safe workspace resume. Current branch/HEAD
and working-state facts are separate from the manifest's original base
provenance. The operation is offline and read-only, with partial/not-ready member
diagnostics and no automatic repair. Package and persisted schema versions remain
independent.

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

## Bundled guidance

The portable skill lives at `apps/cli/skills/outpost/SKILL.md`. It routes agents to
command and recovery references on demand. `docs [topic]`, `skill show` and
`skill path` read package assets without loading or initializing Outpost state.
`skill export <directory>` writes only an explicitly chosen new
`<directory>/outpost` destination, creates it exclusively and uses exclusive file
writes. It never merges existing skill content or chooses an agent configuration
directory automatically. Partial export failures leave created files for inspection.

`apps/cli/scripts/generate-docs.mjs` uses the command registry and executable result
schemas to generate the command reference, `man/outpost.1` and Draft 2020-12 input
and output schemas. Schema files are standalone and resolve local references
offline. The index maps command names to files and identifies the contract version.
`docs:generate` updates tracked artifacts; build and verify check their exact bytes
and reject stale or extra schema files. The generator uses direct Node filesystem
and subprocess calls as development tooling, outside CLI command workflows.

Package `files`, `man` and asset exports include guidance without postinstall
hooks. Unix global npm installs link the scoped package's actual `outpost.1`.
The CLI declares the shared Node adapter as an exact direct runtime dependency
alongside Effect and the Node platform adapter. This consumer-visible pin aligns
the runtime cohort without relying on a development lock or root-only override.
Other transitive dependency ranges remain upstream-owned. A fresh empty-cache
global installation resolves the shipped manifest; smoke verifies the adapter's
actual nested resolution and shared Effect identity before exercising lifecycle
commands. Deterministic resolution fixtures reject a missing shipped pin or a
newer nested adapter even if the root versions look compatible.

Installed tarball smoke tests read assets, compile every schema without a network
loader, validate installed guidance/partial/error envelopes, export the portable
skill, reject a second export and verify the man link resolves into the package.
The workspace AGENTS generator adds a short offline guidance pointer and states
that Outpost owns the generated file and records its hash.

Repository removal unregisters without deleting Git storage, branches or objects.
An atomic version 3 registry stores active records separately from retained records,
including the full repository identity and retention time. Retained IDs and
canonical paths remain reserved. `repo list --retained` and `repo show --retained`
inspect saved registrations; `repo restore` validates the recorded identity,
containment, Git ownership, conflicts and Windows budgets before transferring a
record back to the active set. Restore neither fetches nor requires the source or
remote to exist. `repo add` refuses retained identities before import mutation.
No storage purge or generic force bypass is implemented.

The lifecycle migration retains the existing version 2 config barrier, installs
an incompatible version 3 registry with all existing active records, then commits
the registration transfer atomically. Older strict registry decoders refuse it
before destructive repository operations. A failed or interrupted transfer leaves
the complete record active or retained; storage never moves. Existing settings,
tag, import and fetch writers preserve the retained set and registry version.
Operation journals describe intent, while current registry and validated Git state
remain the recovery authority. Cached remote refs and cleanliness are never used
as proof that local work can be deleted.

## Startup and workspace inspection performance

Runtime modules import Effect and Node platform modules by subpath. Help, version
and duplicate-global-option failures use a shared pure prelude and do not load
Effect or handlers. Installed API smoke checks trace actual module loads to guard
that boundary. Discovery reads the generated standalone output schemas through an
Effect filesystem layer and shares pure registry metadata with the generator;
it does not compile schemas or load mutation handlers at startup. Complete
discovery envelopes still pass the same JSON Schema acceptance checks.

`workspace list` builds one `ManifestReadSnapshot` for each invocation, containing
configuration, sorted tickets and canonical manifest identity collision indexes.
It reads each manifest once and derives health from that validated value. The
index catches canonical and portable name collisions without rescanning sibling
manifest paths for each result. Filesystem ownership, containment and Git HEAD
checks still run per worktree. There is no persistent cache, and listing remains
an advisory inspection rather than a locked, atomic snapshot.

Mutation preflights call `readManifest` without an inspection snapshot. They build
a fresh identity index under the normal home/ticket locks. A regression uses real
worktrees at 10 and 30 workspaces, counts filesystem reads/canonicalizations and
checks refreshed invalid, missing, collision and unmanaged results; a later
mutation still refuses a newly introduced identity collision.

Reproduce latency with `npm run benchmark --workspace @abijith-suresh/outpost`.
The script creates temporary Git repositories and one real worktree per workspace,
checks every listed workspace is ready, and measures three fresh Node processes
at 1, 10, 50 and 100 workspaces. It also measures an empty Node process and
version/help/describe startup. Fixture setup is outside the measurements.

On Linux x64, Node 24.19.0, the corrected guidance baseline `bcc0d0f` measured
median startup times of 379 ms for version, 381 ms for help and 353 ms for describe;
empty Node was 19 ms. This implementation measured 22, 23 and 139 ms respectively,
with empty Node at 16 ms. Listing medians at 1/10/50/100 workspaces changed from
411/553/1,958/5,077 ms to 195/299/777/1,303 ms on the same machine and runtime.
These are post-safety and corrected guidance measurements, separate from both the
initial audit and an earlier exploratory run on guidance commit `913d8b1`.
Fresh processes still benefit from OS filesystem caches and timings vary with host
load; they are observations, not latency guarantees. Git health checks remain a
linear per-worktree cost. No fetch concurrency or mutation locking changes are
included in this performance layer.

Installed discovery checks each output schema's bytes against a generated SHA256
map compiled into the CLI before parsing. The authoritative registry/schema
generator creates and drift-checks both assets and `src/schema-integrity.ts`;
checksums never derive from an installed asset at runtime. Changed, stale or
wrong-command assets fail as one structured stderr error, including all-command
discovery. Successful discovery still uses only the filesystem Effect runtime and
Node crypto, without runtime Ajv or mutation handlers. This detects individual
asset damage relative to compiled package code. It does not authenticate a
package whose code and assets have both been replaced. Even formatting changes
require restoring the shipped asset or regenerating the matching package code.

## Borrowed registration, offline increment

`repo register <checkout> --name NAME` registers ordinary/local-only/unborn clones
or verified linked anchors without touching Git storage. The v4 registry is a
strict tagged managed/borrowed union, adapted internally into separate collections.
Managed ownership and containment remain unchanged. Borrowed records freeze an
opaque local UUID, canonical anchor/private/common directories and lossless
bigint device/inode strings. These directory identities exclude timestamps,
config hashes and refs, and survive benign source evolution. Unavailable/replaced
identities fail closed. Node `fs/promises` bigint `lstat`/`realpath` is a documented
platform boundary because numeric Effect stat identifiers can lose file-ID bits.
Read-only Git discovery validates main/linked registrations and back-pointers,
disables optional writes and implicit promisor fetch, and inventories no objects.
Unsupported submodule/separate-Git-directory layouts are refused.

Registration writes only home metadata under the mutation lock/journal. Config v3
blocks newly started older writers; strict registry v4 blocks cached-config old
writers. The config barrier precedes the empty compatible tagged registry, then
the registration commit. Interrupted writes preserve old records and repair
forward. Reads never migrate. Managed manifests through v4 retain original roots;
borrowed-containing creation writes strict manifest v5 with tagged storage and frozen
common/checkout/admin lossless identity. Managed-only manifests retain their formats.
Borrowed reuse/remote modes and mixed/all fetch selections refuse before effects.

List/show inspect identity offline and distinguish unavailable from healthy
registration without claiming object availability. Remove transfers the complete
record to retained metadata, with `external-unchanged` storage; restore validates
exact identity offline. Neither operation deletes or owns source data. Foreign
source checkouts do not block forgetting registration, but unresolved/referencing
Outpost manifests do. Source refs, config, hooks, files and object bytes/mtimes
remain unchanged; no transport/helper/marker/worktree creation occurs. Native
Windows verifies lossless directory identifiers and existing canonical/raw path
budgets. Actual installed smoke runs through the native `.cmd` entrypoint and
retains the fresh-cache runtime-cohort validation.

## Borrowed local workspace lifecycle and trust

Explicit local/full-ref-or-SHA selection resolves once under locks. Object ownership,
identity, branch attachment, metadata parents and raw/canonical Windows budgets are
checked for every member before effects. Prepared ref creation rejects symbolic
branches; new checkouts attach only the captured SHA. Manifest v5 records the
backend, stable common/created checkout/admin identities, root and provenance.
Resume/show/remove use frozen storage independently of a missing launch anchor;
registration checks and unregister barriers never adopt a replacement source.

Borrowed content operations use normal trusted configured clean/smudge/process
conversion. Unlike managed status, they do not reject filter attributes or enumerate
and suppress drivers. Configured programs can have side effects/network, even if
introduced after preflight. Local selection disables implicit Outpost fetch, not
program effects. Hooks/fsmonitor, automatic maintenance and lazy object fetch remain
disabled. Submodule and non-refreshing owned-index restrictions remain. Metadata-only
registration/inspection does not execute conversions. UI polling must not invoke
these explicit content operations silently.

Only selected-tree check-attr receives a scoped nonexistent GIT_INDEX_FILE in private
scratch outside source. Identity, ownership, path budgets, bounded emptiness and
index absence are rechecked; cleanup removes only unchanged positively owned empty
scratch. Unknown residue is preserved. No source index/config copy or repair exists.

Borrowed-containing admission failure/cancellation retains all possible member
branches/reflogs/checkout/admin/guidance. A current-OID match cannot detect A-B-A
history. Journals record original pinned SHA, paths, confirmations and unknown
survivor status, with doctor/manual recovery. Retry refuses residual paths. There
is no automatic branch/reflog deletion or promise of full rollback. Normal successful
remove checks frozen ownership and clean state and preserves branches. Managed-only
rollback remains unchanged. Source byte/mtime preservation excludes trusted-program
effects and is tested with inert synthetic drivers; native proof remains mandatory.
