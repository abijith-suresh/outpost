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
  create --ticket <id> --type <branch-type> --repo <id> [--repo <id> ...] [--base <branch>] [--dry-run] [--json]
                         Create worktrees for imported repositories
  doctor [--json]      Report local CLI environment status
  init [--json]        Initialize Outpost home and worktrees roots
  repo add <path> [--remote <name>] [--json]
                       Validate a local repository for Outpost registration
  repo fetch --all [--json]
                        Fetch all managed mirror repositories
  repo list [--json]   List imported repositories
  repo remove <id> [--json]
                         Remove an imported repository
  repo show <id> [--json]
                       Show one imported repository by id
  workspace list [--json]
                         List created ticket workspaces
  workspace remove <ticket> [--json]
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

`outpost create --ticket <id> --type <branch-type> --repo <id> [--repo <id> ...] [--base <branch>] [--dry-run]`

Creates a branch `<type>/<ticket>` (e.g., `feat/PROJ-123`) on each specified managed repo, then creates a worktree at `<worktrees>/<ticket>/<repo-name>`. Use `--base` to branch from a specific branch (defaults to the repo's HEAD). `--dry-run` validates inputs without creating anything.

If run interactively (terminal, no `--json`), missing `--ticket`, `--type`, or `--repo` values are prompted. In non-interactive mode (piped, `--json`), all three must be provided explicitly.

### Workspace remove

`outpost workspace remove <ticket> [--json]`

Removes all worktrees for the given ticket. The command refuses to remove:

- Worktrees with uncommitted changes (dirty `git status`)
- Worktrees it cannot prove it owns
- Workspaces where `AGENTS.md` has been modified or replaced (interactive mode prompts for confirmation; non-interactive mode fails)

Branches in the managed mirrors are preserved.

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

Repository mutations validate registry paths against both `reposRoot` and, for legacy mirrors without ownership markers, the path derived from repository identity. Existing directories must be bare Git repositories with a matching origin and an Outpost ownership marker, or a verified legacy mirror layout. Unregistered directories are never adopted. Create preflight reserves `AGENTS.md`, including portable case and trailing-dot collisions, before either dry-run or execution. Removal refuses any linked Git worktree, including one whose workspace manifest is missing. An absent mirror can be unregistered after containment and manifest checks; foreign directories remain untouched. `repo remove --json` carries unmanaged-directory warnings in `data.warnings` without plain stderr output.

Git commands drain both output streams and request termination after 120 seconds by default. Set `OUTPOST_GIT_TIMEOUT_MS` to a positive number of milliseconds for slower remotes. Diagnostics retain at most 256 KiB per stream, append lines without expanding them into function arguments, and mark truncation; commands requiring stdout fail rather than consume truncated or failed output.

On POSIX, checked commands own separate process groups: cleanup requests SIGTERM, then SIGKILL after a one-second grace period. Timeout completion includes cleanup; the Effect spawner can also wait one additional second for the group after escalation. Children that retain inherited output pipes in that group are included, even after the original process exits. Process cleanup cannot guarantee termination of descendants that detach into another process group, inaccessible processes, or processes stuck in the kernel. Windows uses the platform spawner's taskkill behavior and cannot guarantee cleanup of descendants after their leader exits. POSIX group signaling also inherits the operating system's numeric process-group ID reuse limits. macOS and Windows cleanup are not covered by the Linux regressions.

Fetch prunes remote branches only under `refs/remotes/origin`. Workspace branches in `refs/heads` and their commits survive fetch and repository re-import. Older mirrors migrate on their next fetch without deleting or rewriting local refs. Create prefers a fetched remote base, with a local branch fallback for existing mirrors and workspace branches.

- **Semantic identifier validation:** empty values and ASCII control characters are rejected in tickets, branch inputs, repository identities, remote names, and persisted state before filesystem or Git operations.
- **Dirty worktree protection:** workspace removal checks `git status --porcelain` and refuses worktrees with uncommitted changes.
- **Ownership verification:** worktree `.git` files must point to the expected bare repository.
- **Mutation locks:** init, repository add/fetch/remove, workspace create, and workspace remove take one exclusive home mutation lock before reading state for mutation. An overlapping mutation fails with a clear retry message. Create and remove then take the ticket lock, in that order. Dry-run does not take locks.
- **Repository reference checks:** `repo remove` refuses repos still referenced by active workspaces.
- **Rollback:** failed or ordinarily cancelled create rolls back only branches and worktrees whose creation this operation confirmed from a successful Git result, plus matching generated files. Failed or interrupted Git mutations leave creation unconfirmed; any resulting or externally created artifact is preserved for manual inspection. Dirty worktrees, switched worktree branches, advanced branches, edited guidance, and unrecognized files are preserved. A committed workspace manifest survives a late cancellation.
- **Partial success reporting:** `repo fetch` and `workspace remove` report partial failures rather than hiding them.

### Cancellation and crash recovery

`doctor` and `doctor --json` report held home/ticket locks and incomplete operation records. Records include the operation ID, PID, host, start time, and intended paths, branches, and starting commits. Mutation intent is recorded under `$OUTPOST_HOME/operations/` before artifacts change. Branch and worktree steps record an `intent` phase, followed by `confirmed` only when Git reports success. An unconfirmed step may have left artifacts, but matching paths, repository association, or starting commits do not prove operation ownership. Successful operations remove their record; interrupted or failed operations retain it for inspection, even when rollback cleaned up everything. Workspace health also checks that HEAD resolves to a commit. Switching branches or detaching HEAD is allowed.

SIGINT and SIGTERM run cleanup finalizers. On POSIX, checked commands own separate process groups: cleanup requests SIGTERM, then SIGKILL after a one-second grace period. Timeout completion includes cleanup; the Effect spawner can also wait one additional second for the group after escalation. Children that retain inherited output pipes in that group are included, even after the original process exits. SIGKILL, process crashes, machine shutdown, and storage failures can leave partial artifacts and locks. Writes use atomic rename, without a power-loss durability guarantee. Outpost never reaps a lock because of age or a dead-looking PID, and metadata alone does not authorize deletion or adoption.

After a crash, run `outpost doctor --json` and inspect the reported lock and operation files. Verify the recorded process and host independently, then compare the recorded plans with `git --git-dir <managed-path> worktree list --porcelain`, the current refs, and each worktree's status. Preserve edits and unfamiliar paths. Only after establishing that no mutation is running should you manually release the corresponding home and ticket locks. Keep operation records until all reported artifacts have been accounted for. There is no blanket force-recovery command. Residual workspaces without manifests remain unmanaged; unregistered repository directories require manual inspection and are not adopted on retry.

Initialization writes the registry before the config marker. If the config write fails, retrying init preserves the installed registry. If config exists but the registry is missing, init reports incomplete initialization and refuses to replace potentially lost registry state. Restore or reconstruct that registry only after inspecting existing repositories and workspaces.

## Website

The marketing landing page is built with Astro and deployed to GitHub Pages at [abijith-suresh.github.io/outpost](https://abijith-suresh.github.io/outpost/). See the [Pages workflow](https://github.com/abijith-suresh/outpost/blob/main/.github/workflows/pages.yml) for deployment behavior.
