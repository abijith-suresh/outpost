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
  outpost create --ticket <id> --type <branch-type> [--repo <id> ...] [--tag <tag> ...] [--base <branch>] [--dry-run] [--json]

Create worktrees for imported repositories

  mutation: true
  interactive: yes
  json output: yes
  dry-run: yes

Options:
  --ticket <id>  Ticket identifier (required)
  --type <branch-type>  Branch type prefix (e.g. feat, fix) (required)
  --repo <id>  Repository identifier (repeatable; optional with --tag) (repeatable)
  --tag <tag>  Require every selected tag (repeatable); filters explicit IDs when combined (repeatable)
  --base <branch>  Base branch (defaults to repo HEAD)
  --dry-run  Validate without creating
  --json  Output as JSON
```

Network: none. Retry: inspect-before-retry.
Side effects: local-branches, worktrees, workspace-metadata.

## guidance preview

```text
Usage:
  outpost guidance preview --ticket <id> --type <branch-type> [--repo <id> ...] [--tag <tag> ...] [--base <branch>] [--json]

Preview factual workspace AGENTS.md using current settings without writing files

  mutation: false
  json output: yes

Options:
  --ticket <id>  Ticket identifier (required)
  --type <branch-type>  Branch type prefix (e.g. feat, fix) (required)
  --repo <id>  Repository identifier (repeatable; optional with --tag) (repeatable)
  --tag <tag>  Require every selected tag (repeatable); filters explicit IDs when combined (repeatable)
  --base <branch>  Base branch (defaults to repo HEAD)
  --json  Output as JSON
```

Network: none. Retry: safe.
Side effects: none.

## config show

```text
Usage:
  outpost config show [--json]

Show validated configuration and future workspace defaults

  mutation: false
  json output: yes

Options:
  --json  Output as JSON
```

Network: none. Retry: safe.
Side effects: none.

## config set

```text
Usage:
  outpost config set <key> <value> [--json]

Set worktreesRoot for future workspaces without moving existing workspaces

  mutation: true
  json output: yes

Arguments:
  <key>  worktreesRoot (required)
  <value>  Absolute native directory path (required)

Options:
  --json  Output as JSON
```

Network: none. Retry: inspect-before-retry.
Side effects: configuration.

## guidance set

```text
Usage:
  outpost guidance set <file> [--json]

Read optional global extra instructions from a UTF-8 file for future workspaces

  mutation: true
  json output: yes

Arguments:
  <file>  UTF-8 file, at most 65536 bytes (required)

Options:
  --json  Output as JSON
```

Network: none. Retry: inspect-before-retry.
Side effects: configuration.

## guidance clear

```text
Usage:
  outpost guidance clear [--json]

Clear extra instructions for future workspaces

  mutation: true
  json output: yes

Options:
  --json  Output as JSON
```

Network: none. Retry: inspect-before-retry.
Side effects: configuration.

## repo tag

```text
Usage:
  outpost repo tag <id> [--add <tag> ...] [--remove <tag> ...] [--json]

Add or remove flat repository tags without changing existing workspace membership

  mutation: true
  json output: yes

Arguments:
  <id>  Repository identifier (required)

Options:
  --add <tag>  Tag to add (repeatable)
  --remove <tag>  Tag to remove (repeatable)
  --json  Output as JSON
```

Network: none. Retry: inspect-before-retry.
Side effects: configuration, registry.

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
  outpost repo list [--tag <tag> ...] [--json]

List imported repositories

  mutation: false
  json output: yes

Options:
  --tag <tag>  Require every selected tag (repeatable) (repeatable)
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
