# outpost

CLI for managing local Git repository workspaces. Bootstrap multiple repos into a single ticket workspace with branches, worktrees, and mirror fetching.

## Install

```bash
npm install -g @abijith-suresh/outpost
```

**Requirements:** Node.js >= 22.14.0, Git available on PATH.

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
  help                 Show this help output
  create --ticket <id> --type <branch-type> --repo <id> [--repo <id> ...] [--base <branch>] [--dry-run]
                         Create worktrees for imported repositories
  doctor [--json]      Report local CLI environment status
  init [--json]        Initialize Outpost home and worktrees roots
  repo add <path> [--remote <name>]
                       Validate a local repository for Outpost registration
  repo fetch --all [--json]
                        Fetch all managed mirror repositories
  repo list [--json]   List imported repositories
  repo remove <id>     Remove an imported repository
  repo show <id>       Show one imported repository by id
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

### Create

`outpost create --ticket <id> --type <branch-type> --repo <id> [--repo <id> ...] [--base <branch>] [--dry-run]`

Creates a branch `<type>/<ticket>` (e.g., `feat/PROJ-123`) on each specified managed repo, then creates a worktree at `<worktrees>/<ticket>/<repo-name>`. Use `--base` to branch from a specific branch (defaults to the repo's HEAD). `--dry-run` validates inputs without creating anything.

If run interactively (terminal, no `--json`), missing `--ticket`, `--type`, or `--repo` values are prompted. In non-interactive mode (piped, `--json`), all three must be provided explicitly.

### Workspace remove

`outpost workspace remove <ticket> [--json]`

Removes all worktrees for the given ticket. The command refuses to remove:

- Worktrees with uncommitted changes (dirty `git status`)
- Worktrees it cannot prove it owns
- Workspaces where the generated `AGENTS.md` has been modified by the user (interactive mode prompts for confirmation; non-interactive mode fails)

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

Most commands support `--json` for machine-readable output. When `--json` is present, interactive prompting is disabled and output is formatted as pretty-printed JSON:

```bash
outpost repo list --json
outpost workspace show PROJ-123 --json
```

## Safety

- **Dirty worktree protection:** workspace removal checks `git status --porcelain` and refuses worktrees with uncommitted changes.
- **Ownership verification:** worktree `.git` files must point to the expected bare repository.
- **Ticket locks:** concurrent operations on the same ticket are serialized with exclusive lock files.
- **Repository reference checks:** `repo remove` refuses repos still referenced by active workspaces.
- **Rollback:** if `create` fails partway through, it rolls back branches, worktrees, and generated files.
- **Partial success reporting:** `repo fetch` and `workspace remove` report partial failures rather than hiding them.
