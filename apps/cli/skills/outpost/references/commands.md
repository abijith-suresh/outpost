# Command reference

Generated from the command registry. Edit the registry, then run `npm run docs:generate`.

Input schemas describe normalized `{ arguments, options }`; named values are arrays.
Help and version remain text. All other listed commands support opt-in `--json`.

## help

```text
Usage:
  outpost help [<command> ...]

Show this help output

  mutation: false

Arguments:
  <command>  Command path to show help for (repeatable)
```

Network: none. Retry: safe.
Side effects: none.

## describe

```text
Usage:
  outpost describe [<command> ...] [--json]

Show command specifications

  mutation: false
  json output: yes

Arguments:
  <command>  Command path to describe (repeatable)

Options:
  --json  Output as JSON
```

Network: none. Retry: safe.
Side effects: none.

## docs

```text
Usage:
  outpost docs [<topic>] [--json]

Read bundled offline guidance

  mutation: false
  json output: yes

Arguments:
  <topic>  overview, commands, recovery or schemas

Options:
  --json  Output as JSON
```

Network: none. Retry: safe.
Side effects: none.

## skill show

```text
Usage:
  outpost skill show [--json]

Read the bundled portable Outpost skill

  mutation: false
  json output: yes

Options:
  --json  Output as JSON
```

Network: none. Retry: safe.
Side effects: none.

## skill path

```text
Usage:
  outpost skill path [--json]

Locate installed skill, reference, man and schema assets

  mutation: false
  json output: yes

Options:
  --json  Output as JSON
```

Network: none. Retry: safe.
Side effects: none.

## skill export

```text
Usage:
  outpost skill export <directory> [--json]

Copy the portable skill to a selected directory without overwriting

  mutation: true
  json output: yes

Arguments:
  <directory>  Parent directory for a new outpost skill folder (required)

Options:
  --json  Output as JSON
```

Network: none. Retry: inspect-before-retry.
Side effects: exported-guidance.

## create

```text
Usage:
  outpost create --ticket <id> --type <branch-type> --repo <id> [--repo <id> ...] [--base <branch>] [--dry-run] [--json]

Create worktrees for imported repositories

  mutation: true
  interactive: yes
  json output: yes
  dry-run: yes

Options:
  --ticket <id>  Ticket identifier (required)
  --type <branch-type>  Branch type prefix (e.g. feat, fix) (required)
  --repo <id>  Repository identifier (repeatable) (required) (repeatable)
  --base <branch>  Base branch (defaults to repo HEAD)
  --dry-run  Validate without creating
  --json  Output as JSON
```

Network: none. Retry: inspect-before-retry.
Side effects: local-branches, worktrees, workspace-metadata.

## doctor

```text
Usage:
  outpost doctor [--json]

Report local CLI environment status

  mutation: false
  json output: yes

Options:
  --json  Output as JSON
```

Network: none. Retry: safe.
Side effects: none.

## init

```text
Usage:
  outpost init [--json]

Initialize Outpost home and worktrees roots

  mutation: true
  json output: yes

Options:
  --json  Output as JSON
```

Network: none. Retry: inspect-before-retry.
Side effects: configuration, directories.

## repo add

```text
Usage:
  outpost repo add <path> [--remote <name>] [--json]

Validate a local repository for Outpost registration

  mutation: true
  json output: yes

Arguments:
  <path>  Local repository path (required)

Options:
  --remote <name>  Remote name (defaults to origin)
  --json  Output as JSON
```

Network: explicit. Retry: inspect-before-retry.
Side effects: managed-repositories, registry.

## repo fetch

```text
Usage:
  outpost repo fetch --all [--json]

Fetch all managed mirror repositories

  mutation: true
  json output: yes

Options:
  --all  Fetch all managed mirrors (required)
  --json  Output as JSON
```

Network: explicit. Retry: inspect-before-retry.
Side effects: managed-repositories, registry.

## repo list

```text
Usage:
  outpost repo list [--json]

List imported repositories

  mutation: false
  json output: yes

Options:
  --json  Output as JSON
```

Network: none. Retry: safe.
Side effects: none.

## repo remove

```text
Usage:
  outpost repo remove <id> [--dry-run] [--json]

Remove an imported repository

  mutation: true
  json output: yes
  dry-run: yes

Arguments:
  <id>  Repository identifier (required)

Options:
  --dry-run  Preview removal without locks or writes
  --json  Output as JSON
```

Network: none. Retry: inspect-before-retry.
Side effects: managed-repositories, registry.

## repo show

```text
Usage:
  outpost repo show <id> [--json]

Show one imported repository by id

  mutation: false
  json output: yes

Arguments:
  <id>  Repository identifier (required)

Options:
  --json  Output as JSON
```

Network: none. Retry: safe.
Side effects: none.

## workspace list

```text
Usage:
  outpost workspace list [--json]

List created ticket workspaces

  mutation: false
  json output: yes

Options:
  --json  Output as JSON
```

Network: none. Retry: safe.
Side effects: none.

## workspace remove

```text
Usage:
  outpost workspace remove <ticket> [--dry-run] [--json]

Remove a ticket workspace and all its worktrees

  mutation: true
  interactive: yes
  json output: yes
  dry-run: yes

Arguments:
  <ticket>  Ticket workspace identifier (required)

Options:
  --dry-run  Preview removal without locks, writes or approval prompts
  --json  Output as JSON
```

Network: none. Retry: inspect-before-retry.
Side effects: worktrees, workspace-metadata.

## workspace show

```text
Usage:
  outpost workspace show <ticket> [--json]

Show one created ticket workspace

  mutation: false
  json output: yes

Arguments:
  <ticket>  Ticket workspace identifier (required)

Options:
  --json  Output as JSON
```

Network: none. Retry: safe.
Side effects: none.

## Exit and recovery contract

Success uses stdout and exit 0. Partial fetch/removal uses stdout, `ok: false`, `data` and exit 1. Errors without results use stderr and exit 1, with `code`, `reason`, `retryable` and `action`. See [recovery](recovery.md) before retrying.
