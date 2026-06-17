# outpost

CLI for managing local Git repository workspaces. Bootstrap multiple repos into a single ticket workspace with branches, worktrees, and mirror fetching.

## Install

```bash
npm install -g @abijith-suresh/outpost
```

## Quick start

```bash
outpost init                          # create ~/.outpost
outpost repo add ./my-project         # import a repo
outpost create --ticket PROJ-123 --type feat --repo <id>
outpost workspace list                # see your workspaces
outpost workspace remove PROJ-123     # clean up when done
```

## Commands

| Command            | Usage                                                                                                           | Description                                          |
| ------------------ | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `help`             | `outpost help`                                                                                                  | Show help output                                     |
| `create`           | `outpost create --ticket <id> --type <branch-type> --repo <id> [--repo <id> ...] [--base <branch>] [--dry-run]` | Create worktrees for imported repositories           |
| `doctor`           | `outpost doctor [--json]`                                                                                       | Report local CLI environment status                  |
| `init`             | `outpost init [--json]`                                                                                         | Initialize Outpost home and worktrees roots          |
| `repo add`         | `outpost repo add <path> [--remote <name>]`                                                                     | Validate a local repository for Outpost registration |
| `repo fetch`       | `outpost repo fetch --all [--json]`                                                                             | Fetch all managed mirror repositories                |
| `repo list`        | `outpost repo list [--json]`                                                                                    | List imported repositories                           |
| `repo remove`      | `outpost repo remove <id>`                                                                                      | Remove an imported repository                        |
| `repo show`        | `outpost repo show <id>`                                                                                        | Show one imported repository by id                   |
| `workspace list`   | `outpost workspace list [--json]`                                                                               | List created ticket workspaces                       |
| `workspace remove` | `outpost workspace remove <ticket> [--json]`                                                                    | Remove a ticket workspace and all its worktrees      |
| `workspace show`   | `outpost workspace show <ticket> [--json]`                                                                      | Show one created ticket workspace                    |
| `demo list`        | `outpost demo list [--json]`                                                                                    | Show placeholder command output structure            |

## Environment

**OUTPOST_HOME** — override the default data directory (default: `~/.outpost`).

## JSON output

Most commands support `--json` for machine-readable output:

```bash
outpost repo list --json
outpost workspace show TICKET-123 --json
```

## Development

```bash
npm install
npm run verify    # format, lint, typecheck, test
npm run build
```

## Release

Pre-v1. Uses changesets. Merging to main creates a version packages PR. Merging that PR publishes to npm via trusted publishing.
