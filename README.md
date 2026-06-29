# outpost

CLI for managing local Git repository workspaces. Bootstrap multiple repos into a single ticket workspace with branches, worktrees, and mirror fetching.

## Install

```bash
npm install -g @abijith-suresh/outpost
```

**Requirements:** Node.js >= 22.14.0, npm >= 11.5.1, and Git available on PATH.

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

- **Dirty worktree protection:** workspace removal checks `git status --porcelain` and refuses worktrees with uncommitted changes.
- **Ownership verification:** worktree `.git` files must point to the expected bare repository.
- **Ticket locks:** concurrent operations on the same ticket are serialized with exclusive lock files.
- **Repository reference checks:** `repo remove` refuses repos still referenced by active workspaces.
- **Rollback:** if `create` fails partway through, it rolls back branches, worktrees, and generated files.
- **Partial success reporting:** `repo fetch` and `workspace remove` report partial failures rather than hiding them.

## Website

The marketing landing page is built with Astro and deployed to GitHub Pages at [abijith-suresh.github.io/outpost](https://abijith-suresh.github.io/outpost/). See `.github/workflows/pages.yml` for the deployment workflow.

### One-time repository setup

In your repository Settings:

1. Go to **Settings → Pages**.
2. Under **Build and deployment**, set **Source** to **GitHub Actions**.
3. Ensure the `github-pages` environment exists (created automatically on first deployment).
