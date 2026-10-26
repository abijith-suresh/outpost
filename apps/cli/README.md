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
  guidance preview --ticket <id> --type <branch-type> [--repo <id> ...] [--tag <tag> ...] [--base <branch>] [--json]
                       Preview factual workspace AGENTS.md without writing
  create --ticket <id> --type <branch-type> [--repo <id> ...] [--tag <tag> ...] [--base <branch>] [--dry-run] [--json]
                         Create worktrees for imported repositories
  doctor [--json]      Report local CLI environment status
  init [--json]        Initialize Outpost home and worktrees roots
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
  workspace show <ticket> [--json]
                         Show one created ticket workspace
Global options:
  --help               Show help output
  --version            Show CLI version
  --json               Use JSON output for supported commands
```

Use `outpost help <command>` or `outpost <command> --help` for command-level help, such as `outpost help repo add`. Use `outpost describe --json` or `outpost describe <command> --json` when an agent needs the command surface as structured data.

### Create

`outpost create --ticket <id> --type <branch-type> [--repo <id> ...] [--tag <tag> ...] [--base <branch>] [--dry-run]`

Creates a branch `<type>/<ticket>` (e.g., `feat/PROJ-123`) on each specified managed repo, then creates a worktree at `<worktrees>/<ticket>/<repo-name>`. Use `--base` to branch from a specific branch (defaults to the repo's HEAD). `--dry-run` validates inputs without creating anything.

Select explicit repository IDs, tags, or both. Repeated tags require every tag to match. When combined with explicit IDs, tags filter only those IDs. Tags contain 1–64 lowercase letters, numbers, dots, underscores or hyphens, starting with a letter or number. Creation records the selected concrete repository IDs; changing tags later never changes a workspace. An empty selection fails before creating worktrees.

If run interactively (terminal, no `--json`), missing ticket, type or repository selection is prompted. Non-interactive use requires a ticket, type and explicit repository IDs or tags.

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

The first settings, tag or guidance mutation upgrades configuration to version 2 and installs an incompatible version 2 registry before saving extended settings or tags. Older Outpost binaries refuse that state, including an old process that read config before the upgrade but takes the mutation lock afterward. Legacy manifests are read against the saved original root; new manifests declare their version and root. Do not restore an old config over newer workspace state as a rollback. Keep the newer tool and repair forward after inspecting `doctor` results. If a version 2 or 3 registry remains but config is missing, init refuses to invent replacement roots; restore the original config only after inspecting existing state.

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

Fetch prunes remote branches only under `refs/remotes/origin`. Workspace branches in `refs/heads` and their commits survive fetch and repository re-import. Older mirrors migrate on their next fetch without deleting or rewriting local refs. Create prefers a fetched remote base, with a local branch fallback for existing mirrors and workspace branches.

- **Semantic identifier validation:** empty values and ASCII control characters are rejected in tickets, branch inputs, repository identities, remote names, and persisted state before filesystem or Git operations.
- **Dirty worktree protection:** workspace removal checks `git status --porcelain` and refuses worktrees with uncommitted changes.
- **Ownership verification:** worktree `.git` files must point to the expected bare repository.
- **Mutation locks:** init, repository add/fetch/remove, workspace create, and workspace remove take one exclusive home mutation lock before reading state for mutation. An overlapping mutation fails with a clear retry message. Create and remove then take the ticket lock, in that order. Dry-run does not take locks.
- **Settings safety:** configuration, tag and guidance mutations use the same home lock. Root changes preserve existing workspace locations. Unsupported state versions fail closed; settings do not overwrite existing guidance or change workspace membership.
- **Repository reference checks:** `repo remove` refuses repos still referenced by active workspaces.
- **Rollback:** failed or ordinarily cancelled create rolls back only branches and worktrees whose creation this operation confirmed from a successful Git result, plus matching generated files. Failed or interrupted Git mutations leave creation unconfirmed; any resulting or externally created artifact is preserved for manual inspection. Dirty worktrees, switched worktree branches, advanced branches, edited guidance, and unrecognized files are preserved. A committed workspace manifest survives a late cancellation.
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
