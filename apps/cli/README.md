# outpost

CLI for managing local Git repository workspaces. Bootstrap multiple repos into a single ticket workspace with branches, worktrees, and mirror fetching.

## Install

```bash
npm install -g @abijith-suresh/outpost
```

**Requirements:** Node.js >= 24.19.0 <25 (Node.js 24 only), npm >= 11.5.1, and Git available on PATH.

## Quick start

```bash
outpost init                          # create ~/.outpost
outpost repo add ./my-project         # import a repo
outpost create --ticket PROJ-123 --type feat --repo <id>
outpost workspace list                # see your workspaces
outpost workspace resume PROJ-123     # inspect existing work before continuing
outpost workspace remove PROJ-123     # clean up when done
```

## Commands

```
outpost <command> [options]

Commands:
  help [<command> ...] Show this help output
  describe [<command> ...] [--json] Show command specifications
  docs [<topic>] [--json] Read bundled offline guidance
  skill show [--json] Read the bundled portable Outpost skill
  skill path [--json] Locate installed skill, reference, man and schema assets
  skill export <directory> [--json] Copy the portable skill without overwriting
  config show [--json] Inspect settings and recorded workspace roots
  config set worktreesRoot <absolute-path> [--json]
                       Set the root for future workspaces
  guidance set <file> [--json] Set extra instructions from a UTF-8 text file
  guidance clear [--json] Clear extra instructions for future workspaces
  guidance preview --ticket <id> --type <branch-type> [--repo <id> ...] [--tag <tag> ...] [--base-source <source>] [--base <ref>] [--json]
                       Preview factual workspace AGENTS.md without writing
  create --ticket <id> --type <branch-type> [--repo <id> ...] [--tag <tag> ...] [--base-source <source>] [--base <ref>] [--reuse-branch <name>] [--dry-run] [--json]
                         Create worktrees for imported repositories
  doctor [--json]      Report local CLI environment status
  init [--json]        Initialize Outpost home and worktrees roots
  repo register <checkout> --name NAME [--dry-run] [--json]
                       Register borrowed clone storage offline, source unchanged
  repo add <path> [--remote <name>] [--json]
                       Validate a local repository for Outpost registration
  repo fetch --all [--json]
                        Fetch all managed mirror repositories
  repo list [--tag <tag> ...] [--retained] [--json]
                       List active or explicitly retained repositories
  repo tag <id> [--add <tag> ...] [--remove <tag> ...] [--json]
                       Edit optional flat repository tags
  repo remove <id> [--dry-run] [--json]
                         Unregister a repository while retaining its storage
  repo restore <id> [--dry-run] [--json]
                         Restore a validated retained registration without fetching
  repo show <id> [--retained] [--json]
                       Show one imported repository by id
  workspace list [--json]
                         List created ticket workspaces
  workspace remove <ticket> [--dry-run] [--json]
                         Remove a ticket workspace and all its worktrees
  workspace resume <ticket> [--json]
                         Verify one existing workspace without changing it
  workspace show <ticket> [--json]
                         Show one created ticket workspace
Global options:
  --help               Show help output
  --version            Show CLI version
  --json               Use JSON output for supported commands
```

Use `outpost help <command>` or `outpost <command> --help` for command-level help, such as `outpost help repo add`. Use `outpost describe --json` or `outpost describe <command> --json` when an agent needs the command surface as structured data.

### Create

`outpost create --ticket <id> --type <branch-type> [--repo <id> ...] [--tag <tag> ...] [--base-source <source>] [--base <ref>] [--reuse-branch <name>] [--dry-run]`

By default, creates a branch `<type>/<ticket>` (e.g., `feat/PROJ-123`) on each specified managed repo, then creates a worktree at `<worktrees>/<ticket>/<repo-name>`. Choose `--base-source local`, `cached-remote` or `fresh-remote`. The default is
`cached-remote`. Use `--base <ref>` to select the ref; without it, each repository
uses its own recorded managed symbolic HEAD branch. This does not rediscover a
remote's current default branch.

| Source | Ref selection | Network and failure behavior |
| --- | --- | --- |
| `local` | An available owned local ref or immutable object | Never fetches. Missing objects fail; source-only commits are not imported. |
| `cached-remote` | The selected branch under `refs/remotes/origin/` | Never fetches and never falls back to a local branch. |
| `fresh-remote` | Explicitly fetch the selected upstream branch | Requires a successful checked fetch. Missing/unavailable refs or authentication fail without using cached/local work as a substitute. |

Git's implicit promisor-object fetching is disabled during base selection and
creation. Missing commits or checkout objects therefore fail honestly instead of
opening an undeclared fetch. Explicit fresh selection still uses the checked
fetch operation; it does not authorize arbitrary implicit fetches afterward.

Every successful member reports its requested source/ref, resolved ref and actual
immutable starting SHA. The manifest and factual generated `AGENTS.md` record the
same provenance. The branch is created from that SHA. If concurrent changes make
the created branch/worktree disagree, creation refuses to commit false provenance
and preserves changed work for inspection. Existing branches are never reset.

`--dry-run` validates without locks, writes or fetching. Local and cached previews
resolve owned commits and check their checkout objects. A fresh preview reports `fetch-required` with no resolved
fresh SHA; execution must fetch and resolve again. `guidance preview` follows the
same read-only rule. Refreshes completed before another repository fails are not
rolled back or described as a complete workspace. Inspect the operation journal
before retrying a failed or interrupted fresh operation. A failed operation may
retain a private receipt ref under `refs/outpost/base-fetch/` to keep a confirmed
fetched commit recoverable. Journals identify those refs and SHAs for inspection;
they are not authority to replay an operation or delete storage. Bulk repository
fetch timestamps are not a substitute for the per-workspace immutable receipt.

Select explicit repository IDs, tags, or both. Repeated tags require every tag to match. When combined with explicit IDs, tags filter only those IDs. Tags contain 1–64 lowercase letters, numbers, dots, underscores or hyphens, starting with a letter or number. Creation records the selected concrete repository IDs; changing tags later never changes a workspace. An empty selection fails before creating worktrees.

If run interactively (terminal, no `--json`), missing ticket, type or repository selection is prompted. Non-interactive use requires a ticket, type and explicit repository IDs or tags.

An existing ticket is a conflict, including when fresh selection was requested.
Use `workspace resume <ticket>` explicitly; repeating create never refreshes or
repairs an existing workspace.

### Reuse an existing managed branch

```bash
outpost create --ticket PROJ-124 --type feat --repo <id> --reuse-branch feature/existing --dry-run --json
outpost create --ticket PROJ-124 --type feat --repo <id> --reuse-branch feature/existing --json
```

Reuse attaches an existing direct local branch from each selected registered,
owned managed repository to a new ticket workspace. Supply the branch name,
without `refs/heads/`. `--type` remains the ticket category; the reused branch
keeps its exact name instead of becoming `<type>/<ticket>`. `--reuse-branch`
cannot be combined with `--base` or `--base-source`. Ordinary create still makes
a new branch, and an existing ticket still requires explicit `workspace resume`.
No existing checkout is adopted and no branch is force-attached twice.

All selected members must pass ownership, local-object, direct-branch and
checkout-conflict checks before workspace/configuration mutation. Reuse never
fetches, imports source-only branches, resolves a remote default, resets or
renames refs. Missing local objects and promisor objects fail without fetching.
External object pools, aliased object directories and filesystem ref aliases are refused. Reuse validates canonical containment and never adopts objects or refs through another directory, even when Git can resolve them. Alternate metadata is preserved, never removed as a repair. Selected commit/tree/blob loose files and their fanout directories, plus bounded pack/index metadata, must also be owned regular storage. Ordinary regular files and surviving hardlink clones remain supported. Replacement refs are refused because Git omits their replacement commit dependencies from the selected object inventory. Inspection never copies, repacks or repairs objects.
Assigned content filters or tracked submodules are unsupported in reuse because
creation cannot promise a safe, known working state for them. Resume's existing
split-index, filter and submodule unknown-status limits remain in effect.

Results distinguish `branchDisposition: existing` from ordinary create's
`created`. Source `local`, the requested branch, full ref and immutable
`baseCommit` describe admission of the existing branch, not creation of a new
branch from a base. Version 4 manifests freeze those facts and the original
root/members. Current HEAD may later advance; resume reports it separately.
Previous strict readers refuse version 4 rather than discarding its meaning.
Legacy, version 2 and version 3 workspaces retain their original interpretation.

Execution takes the existing home/ticket locks and Git's verify-only branch
locks, attaches a new checkout without changing the branch, then populates it
from the captured SHA using a merge that refuses raced user files. Ref locks are
aborted and closed without committing updates. Existing branches never enter
rollback's created-branch list. Failure, cancellation, manual recovery and
workspace removal preserve them and their commits. Dirty or changed residual
worktrees remain for explicit doctor/manual inspection; a journal is evidence,
not permission to delete refs, clear locks or adopt arbitrary directories.
Dry-run takes no locks and writes nothing; its result is advisory.

### Workspace resume

```bash
outpost workspace resume PROJ-123 --json
```

Inspects only the named ticket's frozen manifest and members. It uses the saved
root, even after settings or tags change. Verified paths, current branch, current
HEAD and bounded working-state counts are separate from `originalBase`, the
creation facts recorded in the manifest. A later commit does not replace the
original base SHA. Legacy manifests expose only their recorded base facts.

An owned checkout on its expected branch can be advanced, diverged, dirty or have
untracked work and still be resumable. `workingState` reports clean, dirty or
unknown and entry counts, without printing file names. Untracked directories
count as entries, not every contained file. Truncated or unavailable inspection
is never described as clean. Wrong or detached branches, missing or foreign
members, invalid ownership, retained/unregistered repositories and held locks
produce explicit diagnostics. A `partial` or `not-ready` result uses exit 1 with
structured data on stdout; inspect each member before continuing.

Resume is an advisory read-only snapshot. It does not fetch, resolve a new base,
switch/reset branches, recreate checkouts, refresh worktree state, migrate
metadata, move roots or overwrite `AGENTS.md`. Git inspection disables optional
writes and implicit promisor fetching. A missing manifest or interrupted-create
residual needs `outpost doctor --json` and manual inspection. A matching directory
name is never permission to adopt or repair it. Resume does not clear locks or
approve cleanup.

Resume reports Git's working-state snapshot, not a filesystem audit. Managed status
inspection refuses tracked submodules or assigned content filters in this slice
so it cannot run nested status commands or repository-configured filter programs.
Those members report unknown/not-ready with an inspection diagnostic; their work
is preserved. Globally configured filters that do not apply to tracked paths do
not by themselves prevent ordinary resume.
Split indexes also report unknown/not-ready because Git can renew their shared
index timestamps during reads. Resume detects that format before index-reading
Git commands and leaves it intact.

Resume also refuses inherited Git layout redirection, such as an alternate index
or common object directory, so current state cannot be taken from unrelated
storage. Diagnostics name the unsupported variable without exposing its value.
The command does not change environment or global Git settings.

### Configuration, tags and guidance

```bash
outpost config show --json
outpost config set worktreesRoot /absolute/path/to/workspaces --json
outpost repo tag <id> --add backend --add payments --json
outpost repo list --tag backend --json
outpost create --ticket PROJ-124 --type feat --tag backend --dry-run --json
outpost guidance set ./extra-instructions.txt --json
outpost guidance preview --ticket PROJ-124 --type feat --tag backend --json
outpost guidance clear --json
```

`worktreesRoot` must be an absolute local-platform path. On Windows PowerShell, use `outpost.cmd` and quote paths with spaces, for example `outpost.cmd config set worktreesRoot 'C:\Workspaces\Team work' --json`. Changing it only changes where future workspaces are created. It never moves existing worktrees. Existing manifests remain tied to their original roots, including workspaces created before settings commands existed. The home and repository-storage roots cannot be changed through this command.

Extra instructions are optional plaintext appended to the generated factual orientation, under its existing SHA256 ownership marker. They are read from a UTF-8 file of at most 65,536 bytes, without NUL characters, so multiline text does not depend on shell quoting. Preview uses the create preflight and returns the proposed full `AGENTS.md`; it writes no files and acquires no mutation lock. Setting or clearing instructions affects future generation only. Existing generated, modified and foreign guidance retains its normal protection.

The first settings, tag or guidance mutation, or new workspace creation, upgrades configuration to version 2 and installs an incompatible version 2 registry before writing extended state. Existing version 3 retained registries are preserved. Older Outpost binaries refuse that state, including an old process that read config before the upgrade but takes the mutation lock afterward. Legacy manifests are read against the saved original root; new version 3 manifests declare their root and complete immutable base provenance. Explicit existing-branch reuse writes version 4 admission provenance, which prior readers refuse. Do not restore an old config over newer workspace state as a rollback. Keep the newer tool and repair forward after inspecting `doctor` results. If a version 2 or 3 registry remains but config is missing, init refuses to invent replacement roots; restore the original config only after inspecting existing state.

### Workspace remove

`outpost workspace remove <ticket> [--dry-run] [--json]`

Removes all worktrees for the given ticket. The command refuses to remove:

- Worktrees with uncommitted changes (dirty `git status`)
- Worktrees it cannot prove it owns
- Workspaces where `AGENTS.md` has been modified or replaced (interactive mode prompts for confirmation; non-interactive mode fails)

Workspace removal preserves branches in the managed mirrors. `repo remove` now
unregisters the repository and retains its storage, including every local ref and
object. Neither operation deletes branch-only work. Registration removal still
refuses active manifests and linked Git worktrees. No storage purge is provided.

### Retained repositories and restoration

```sh
outpost repo remove <id> --dry-run --json
outpost repo remove <id> --json
outpost repo list --retained --json
outpost repo show <id> --retained --json
outpost repo restore <id> --dry-run --json
outpost repo restore <id> --json
```

The ordinary repository list, create selection and fetch include active
registrations. `--retained` explicitly selects saved registrations and their
storage paths. Retained show also reports local refs and inspection diagnostics.
A path-presence status of `ok` alone does not prove ownership; check
`inspection.status` before using its refs. Unsupported or foreign storage remains
visible with an unavailable inspection. Restore uses the saved record, validates identity, ownership,
containment, Windows path budgets and registration conflicts, and returns the
repository to the active set. It does not clone or fetch and does not require the
original source or remote to be available. Tags and import/fetch timestamps stay
unchanged. `repo add` refuses a retained identity and directs you to restore it.
It never automatically adopts an unregistered directory.

The first unregister/restore lifecycle mutation installs a version 3 repository
registry after the existing version 2 configuration barrier. The atomic registry
holds active and retained records together, so a failure or interruption leaves
each record discoverable in one set. Older repository writers refuse the new
format. Inspect both lists and the journal after an uncertain result before
retrying. Retained storage is still owned state; do not delete it or replace its
Git metadata to bypass a refusal. A missing or changed directory remains
inspectable but cannot be restored until its recorded ownership is validated.

### Interactive vs non-interactive

Interactive mode is enabled when stdin and stdout are both terminals and `--json` is not used. In non-interactive mode, all required arguments must be provided, and operations that need user confirmation (e.g., deleting a modified `AGENTS.md`) fail with a clear error message.

## Environment

**`OUTPOST_HOME`** — override the default data directory (default: `~/.outpost`).

All state lives under `$OUTPOST_HOME`:

```
~/.outpost/
  config.json         # configuration
  repos.json          # registered repositories
  repos/              # managed bare mirrors
  workspaces/         # workspace manifests
  worktrees/          # created worktree directories
```

## JSON output

Commands support `--json` for a stable machine-readable contract. JSON output is a single document with the following envelope:

- **Success:** `{ "ok": true, "command": "...", "data": { ... }, "exitCode": 0 }` written to stdout
- **Partial failure:** `{ "ok": false, "command": "...", "data": { ... }, "exitCode": 1 }` written to stdout
- **Error:** `{ "ok": false, "command": "...", "error": { "code": "...", "message": "..." }, "exitCode": 1 }` written to stderr

Known-command errors use the canonical command name, such as `repo show`. Unknown or unresolvable commands use `null`. Router and parser errors use `INVALID_ARGUMENT`, unknown commands use `UNKNOWN_COMMAND`, and command-handler failures use stable command-specific codes such as `CREATE_FAILED` or `REPO_SHOW_FAILED`. The error object may include a `diagnostics` array of structured objects when additional machine-readable context is available.

When `--json` is present, interactive prompting is disabled. Help and version output remain plain text unless argument validation fails before those options can short-circuit.

```bash
outpost repo list --json
outpost workspace show PROJ-123 --json
```

## Safety

Repository mutations validate registry paths against both `reposRoot` and, for legacy mirrors without ownership markers, the path derived from repository identity. Existing directories must be bare Git repositories with a matching origin and an Outpost ownership marker, or a verified legacy mirror layout. Unregistered directories are never adopted. Create preflight reserves `AGENTS.md`, including portable case and trailing-dot collisions, before either dry-run or execution. Removal refuses any linked Git worktree, including one whose workspace manifest is missing. An absent mirror can be unregistered into retained metadata after containment and manifest checks; restoring it requires the original validated storage. Foreign directories remain untouched. `repo remove --json` carries unmanaged-directory warnings in `data.warnings` without plain stderr output.

Git commands drain both output streams and request termination after 120 seconds by default. Set `OUTPOST_GIT_TIMEOUT_MS` to a positive number of milliseconds for slower remotes. Diagnostics retain at most 256 KiB per stream, append lines without expanding them into function arguments, and mark truncation; commands requiring stdout fail rather than consume truncated or failed output.

On Windows, Outpost passes `-c core.longpaths=true` to its Git commands. Internal pack and administrative files may exceed 260 characters. Git still has startup and working-directory limits, so Outpost checks canonical full paths before clone, fetch, branch/worktree changes, removal, or a root-setting migration:

- Managed Git directories and each checkout's `.git` path must fit within 220 UTF-8 bytes.
- The invoking directory, source checkout, local file-remote directory and workspace checkout must fit within 258 UTF-16 code units, reserving a trailing separator and NUL for Win32 process creation. Derived worktree administrative directories must fit within 243 UTF-16 units, leaving room for `/config.worktree` and NUL during Git startup before long-path configuration loads.
- Root setting reserves space for the smallest ticket/repository layout. Creation checks the actual selected names and the administrative name Git may choose, including collision suffixes. A root accepted for short names may refuse a longer ticket or repository name.

These budgets follow Git for Windows' explicit `GIT_DIR` guard and fixed cwd buffers. Unicode can consume several UTF-8 bytes per character. Junctions and short-name aliases such as `RUNNER~1` are resolved before counting. The full spelling passed to Git must also fit, so neither a short alias to a deep target nor a long alias to a short target bypasses the budget. A refusal reports the affected path, count and budget. Choose a shorter user-owned Outpost home for new imports or `worktreesRoot` for future workspaces, and run Git operations from a shorter directory. Keep the original home to inspect existing work. Metadata inspection and history remain available, and changing the future root never moves old worktrees.

Outpost does not create path aliases, move existing roots, or change system, global or repository Git configuration. Other programs, hooks, submodules and manually run Git commands retain their own limits. See [the path-budget derivation](../../docs/ARCHITECTURE.md#windows-git-path-budgets) for the supported boundary.

Fetch prunes remote branches only under `refs/remotes/origin`. Workspace branches in `refs/heads` and their commits survive fetch and repository re-import. Older mirrors migrate on their next fetch without deleting or rewriting local refs. Create uses explicit base sources. Cached-remote is the default and has no local fallback; use local mode to select an owned local branch. Fresh creation uses a narrowly selected checked fetch and records its actual immutable receipt, without pruning local work or inheriting a mirror refspec that could overwrite user branches.

- **Semantic identifier validation:** empty values and ASCII control characters are rejected in tickets, branch inputs, repository identities, remote names, and persisted state before filesystem or Git operations.
- **Dirty worktree protection:** workspace removal checks `git status --porcelain` and refuses worktrees with uncommitted changes.
- **Ownership verification:** worktree `.git` files must point to the expected bare repository.
- **Mutation locks:** init, repository add/fetch/remove, workspace create, and workspace remove take one exclusive home mutation lock before reading state for mutation. An overlapping mutation fails with a clear retry message. Create and remove then take the ticket lock, in that order. Dry-run does not take locks.
- **Settings safety:** configuration, tag and guidance mutations use the same home lock. Root changes preserve existing workspace locations. Unsupported state versions fail closed; settings do not overwrite existing guidance or change workspace membership.
- **Repository reference checks:** `repo remove` refuses repos still referenced by active workspaces.
- **Existing branches:** explicit reuse never makes a borrowed branch eligible for rollback deletion. Removal preserves all local branches.
- **Rollback:** managed-only failed or ordinarily cancelled create rolls back only branches and worktrees whose creation this operation confirmed from a successful Git result, plus matching generated files. Failed or interrupted Git mutations leave creation unconfirmed; any resulting or externally created artifact is preserved for manual inspection. Dirty worktrees, switched worktree branches, advanced branches, edited guidance, and unrecognized files are preserved. A committed workspace manifest survives a late cancellation.
- **Partial success reporting:** `repo fetch` and `workspace remove` report partial failures rather than hiding them.

### Cancellation and crash recovery

`doctor` and `doctor --json` report held home/ticket locks and incomplete operation records. Records include the operation ID, PID, host, start time, and intended paths, branches, and starting commits. Mutation intent is recorded under `$OUTPOST_HOME/operations/` before artifacts change. Branch and worktree steps record an `intent` phase, followed by `confirmed` only when Git reports success. An unconfirmed step may have left artifacts, but matching paths, repository association, or starting commits do not prove operation ownership. Successful operations remove their record; interrupted or failed operations retain it for inspection, even when rollback cleaned up everything. Workspace health also checks that HEAD resolves to a commit. Switching branches or detaching HEAD is allowed.

SIGINT and SIGTERM run cleanup finalizers. On POSIX, checked commands own separate process groups: cleanup requests SIGTERM, then SIGKILL after a one-second grace period. Timeout completion includes cleanup; the Effect spawner can also wait one additional second for the group after escalation. Children that retain inherited output pipes in that group are included, even after the original process exits. SIGKILL, process crashes, machine shutdown, and storage failures can leave partial artifacts and locks. Writes use atomic rename, without a power-loss durability guarantee. Outpost never reaps a lock because of age or a dead-looking PID, and metadata alone does not authorize deletion or adoption.

After a crash, run `outpost doctor --json` and inspect the reported lock and operation files. Verify the recorded process and host independently, then compare the recorded plans with `git --git-dir <managed-path> worktree list --porcelain`, the current refs, and each worktree's status. Preserve edits and unfamiliar paths. Only after establishing that no mutation is running should you manually release the corresponding home and ticket locks. Keep operation records until all reported artifacts have been accounted for. There is no blanket force-recovery command. Process cleanup cannot guarantee termination of descendants that detach into another process group, inaccessible processes, or processes stuck in the kernel. Windows uses the platform spawner's taskkill behavior and cannot guarantee cleanup of descendants after their leader exits. POSIX group signaling also inherits the operating system's numeric process-group ID reuse limits. macOS and Windows cleanup are not covered by the Linux regressions. Residual workspaces without manifests remain unmanaged; unregistered repository directories require manual inspection and are not adopted on retry.

Initialization writes the registry before the config marker. If the config write fails, retrying init preserves the installed registry. If config exists but the registry is missing, init reports incomplete initialization and refuses to replace potentially lost registry state. Restore or reconstruct that registry only after inspecting existing repositories and workspaces.

## Website

The marketing landing page is built with Astro and deployed to GitHub Pages at [abijith-suresh.github.io/outpost](https://abijith-suresh.github.io/outpost/). See the [Pages workflow](https://github.com/abijith-suresh/outpost/blob/main/.github/workflows/pages.yml) for deployment behavior.

### Machine contract and removal previews

Use `outpost describe <command> --json` to read normalized input and output JSON
Schemas, network access, retry policy and side effects. Discovery reports both
`contractVersion`, which versions the machine contract independently, and the
installed `cliVersion`. Input schemas describe `{ arguments, options }` after CLI
normalization; named values are arrays, and boolean options are `true`.

JSON errors keep command-level `code` and add `reason`, `retryable` and `action`.
Inspect these fields instead of matching prose. A held lock can be retried after
its owner finishes. Crash recovery still requires inspection and manual action.
For partial results, inspect `data.results` or `data.completed` and `data.remaining`
before choosing a recovery action. Partial JSON stays on stdout with exit code 1;
errors without a result stay on stderr. `--json` remains opt-in, and help/version
remain text.

`outpost repo remove <id> --dry-run --json` and
`outpost workspace remove <ticket> --dry-run --json` preview removal without
writes or locks. They run removal's ownership, reference and cleanliness checks.
Workspace previews report `agentsOwnership`, `approvalRequired` and residual
entries. A preview never approves deletion and can become stale. Actual removal
rechecks state under locks. Generated `AGENTS.md` paths are reserved during
creation and manifest validation.

Git import and fetch diagnostics include at most 80 lines and 16,384 text
characters total, split equally across stdout and stderr. `diagnosticTruncation`
reports omitted captured lines and capture truncation explicitly. It replaces
unbounded line expansion and does not change concise human error summaries.

### Offline guidance and portable skill

`outpost docs` reads the shipped skill. Use `outpost docs commands`,
`outpost docs recovery` or `outpost docs schemas` for the generated reference,
recovery decisions or schema index. These commands work without initializing an
Outpost home or contacting the network. `outpost skill show` prints the skill;
`outpost skill path --json` returns installed skill, reference, man and schema paths.

`outpost skill export <directory> --json` copies the portable skill and its
references to `<directory>/outpost`. The destination must not exist. Export never
merges or overwrites an existing skill and never installs into an agent's settings
automatically. If a copy fails partway, inspect the reported destination before
choosing another directory. Source assets stay inside the installed package.

The npm package includes `skills/outpost/SKILL.md`, its references, `schemas/` and
`man/outpost.1`; package exports expose these paths. A global npm install on Unix
links `outpost.1` in `<prefix>/share/man/man1/`, so use `man outpost` when that prefix
is in the system man path, or `man <path>` using the path from `skill path`.
All assets are prebuilt and remain available with install scripts disabled.

### Inspection cost

Help and version avoid loading the command runtime, and discovery reads the
bundled schemas without loading mutation handlers. Workspace listing builds a
fresh collision index and reads each manifest once per invocation. It still
checks Git ownership and HEAD health for every worktree. Results are advisory
snapshots; mutation commands always validate current state under their locks.
There is no persistent cache to invalidate.

Installed `describe` checks output schema integrity against per-command digests
compiled with the CLI. Changed or stale schema assets fail with a structured
`invalid-state` error instead of advertising a successful contract. Restore or
reinstall the package rather than editing installed schemas. This check works
offline and detects individual asset damage, not replacement of package code.

### Register an existing clone offline

`outpost repo register <checkout> --name NAME [--dry-run] --json` records borrowed
storage without clone/fetch, credential-helper execution, source markers or Git
changes. Ordinary local-only/unborn clones and verified linked checkouts work.
The returned `local:<uuid>` identifies that common directory, independent of
remote URLs. Aliases return the existing record; independent clones remain distinct.
Registration is not ownership or backup. Stable filesystem identity must remain
available; replacement storage is never automatically adopted.

`repo list`, `repo show <id>`, `repo remove <id>`, retained inspection and
`repo restore <id>` support these records offline. Remove reports
`external-unchanged` and preserves all source files, branches, configuration,
hooks and objects. Restore validates the original anchor/common/private identity.
Read-only commands never upgrade metadata. Windows path budgets still apply.

Borrowed new ticket workspaces require explicit local selection:

```sh
outpost create --ticket TASK-1 --type feat --repo local:ID --base-source local --base refs/heads/main --json
outpost workspace resume TASK-1 --json
outpost workspace remove TASK-1 --json
```

The base must be a full `refs/heads/*`, `refs/tags/*` or full commit SHA already
available in the registered common store. No DWIM, source-HEAD default, implicit
fetch, source copying, borrowed existing-branch reuse or remote selection is
provided. Mixed selections preflight every member before workspace effects.
Manifest v5 freezes storage/checkout/admin identity, original root/membership and
requested/actual immutable starting commit. Older binaries refuse v5; managed-only
workspaces retain their existing formats. Source storage remains an external
dependency, not a backup. Resume/remove validate the frozen common and owned
checkout even if the saved launch anchor is gone. Missing/replaced state requires
manual inspection, never adoption or repair. Active or uncertain referenced
workspaces block unregistration.

Explicit borrowed create, resume/status and normal remove trust repository Git
clean/smudge/process conversions, including LFS. Those programs may have side
effects or network access, including drivers configured after preflight. Local
base means no implicit Outpost Git fetch, not a sandbox. Outpost keeps hooks and
fsmonitor disabled, refuses missing objects without lazy fetch, and does not
itself edit source files/config/index or source/base refs. Source preservation
excludes effects of trusted configured tools. Metadata-only registration/listing/
inspection remains offline and does not invoke conversions. Future UI polling
must not silently invoke content status.

Tracked submodules and unsupported owned-checkout index modes still refuse;
trusted filters do not authorize broader layout support. Selected-tree attribute
inspection uses a nonexistent index in checked private scratch outside source,
scoped only to that command, preserving main/linked source split indexes. Unknown
scratch contents/identity changes are retained, never recursively cleaned up.

Failed/cancelled borrowed-containing admission preserves branches, reflogs and
confirmed/possible checkout/admin/guidance, even if HEAD returns to the original
SHA. Inspect `doctor --json` and the operation record for original SHA, member
paths and confirmation/unknown status. No full rollback or clean retry is promised.
Do not reset/recreate/adopt residual ticket paths. Successful normal removal
requires verified owned clean work and preserves every branch. Managed-only
rollback is unchanged. Borrowed fetch/reuse/remote/auth modes remain unsupported;
`repo fetch --all` refuses when borrowed records are active.
