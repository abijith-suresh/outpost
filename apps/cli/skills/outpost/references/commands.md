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
  outpost create [--remote <name>] --ticket <id> --type <branch-type> [--repo <id> ...] [--tag <tag> ...] [--base-source <source>] [--base <ref>] [--reuse-branch <name>] [--dry-run] [--json]

Create worktrees; explicit local borrowed clones trust configured Git conversions

  mutation: true
  interactive: yes
  json output: yes
  dry-run: yes

Options:
  --remote <name>  Explicit named cached remote for borrowed clones; managed mirrors accept actual origin only
  --ticket <id>  Ticket identifier (required)
  --type <branch-type>  Branch type prefix (e.g. feat, fix) (required)
  --repo <id>  Repository identifier (repeatable; optional with --tag) (repeatable)
  --tag <tag>  Require every selected tag (repeatable); filters explicit IDs when combined (repeatable)
  --base-source <source>  local, cached-remote (default) or explicit fresh-remote fetch
  --base <ref>  Base ref (defaults to each repository's recorded managed HEAD branch)
  --reuse-branch <name>  Attach an existing owned managed local branch; incompatible with --base/--base-source
  --dry-run  Validate without creating
  --json  Output as JSON
```

Network: explicit. Retry: inspect-before-retry.
Side effects: explicit-fresh-remote-fetch, remote-tracking-refs, local-branches, worktrees, workspace-metadata, trusted-borrowed-git-programs.

## guidance preview

```text
Usage:
  outpost guidance preview [--remote <name>] --ticket <id> --type <branch-type> [--repo <id> ...] [--tag <tag> ...] [--base-source <source>] [--base <ref>] [--json]

Preview factual workspace AGENTS.md using current settings without writing files

  mutation: false
  json output: yes

Options:
  --remote <name>  Explicit named cached remote for borrowed clones; managed mirrors accept actual origin only
  --ticket <id>  Ticket identifier (required)
  --type <branch-type>  Branch type prefix (e.g. feat, fix) (required)
  --repo <id>  Repository identifier (repeatable; optional with --tag) (repeatable)
  --tag <tag>  Require every selected tag (repeatable); filters explicit IDs when combined (repeatable)
  --base-source <source>  local, cached-remote (default) or explicit fresh-remote fetch
  --base <ref>  Base ref (defaults to each repository's recorded managed HEAD branch)
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

## repo register

```text
Usage:
  outpost repo register <path> --name <name> [--dry-run] [--json]

Register borrowed local clone storage offline without changing Git or source files

  mutation: true
  json output: yes
  dry-run: yes

Arguments:
  <path>  Existing checkout (required)

Options:
  --name <name>  Portable member name (required)
  --dry-run  Inspect without writing metadata
  --json  Output as JSON
```

Network: none. Retry: inspect-before-retry.
Side effects: configuration, registry.

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
  outpost repo list [--retained] [--tag <tag> ...] [--json]

List active repositories or explicitly retained registrations

  mutation: false
  json output: yes

Options:
  --retained  List retained storage instead of active registrations
  --tag <tag>  Require every selected tag (repeatable) (repeatable)
  --json  Output as JSON
```

Network: none. Retry: safe.
Side effects: none.

## repo remove

```text
Usage:
  outpost repo remove <id> [--dry-run] [--json]

Unregister a repository while retaining its owned storage and all commits

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
Side effects: configuration, registry.

## repo show

```text
Usage:
  outpost repo show <id> [--retained] [--json]

Show an active repository, or inspect retained storage and local refs

  mutation: false
  json output: yes

Arguments:
  <id>  Repository identifier (required)

Options:
  --retained  Inspect a retained registration instead of an active repository
  --json  Output as JSON
```

Network: none. Retry: safe.
Side effects: none.

## repo restore

```text
Usage:
  outpost repo restore <id> [--dry-run] [--json]

Restore a retained registration after validating owned storage, without fetching

  mutation: true
  json output: yes
  dry-run: yes

Arguments:
  <id>  Retained repository identifier (required)

Options:
  --dry-run  Validate recovery without locks or writes
  --json  Output as JSON
```

Network: none. Retry: inspect-before-retry.
Side effects: registry.

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

Network: explicit. Retry: inspect-before-retry.
Side effects: worktrees, workspace-metadata, trusted-borrowed-git-programs.

## workspace resume

```text
Usage:
  outpost workspace resume <ticket> [--json]

Verify one workspace; borrowed status trusts configured Git conversions, which may have side effects/network

  mutation: false
  json output: yes

Arguments:
  <ticket>  Existing ticket workspace identifier (required)

Options:
  --json  Output as JSON
```

Network: explicit. Retry: inspect-before-retry.
Side effects: trusted-borrowed-git-programs.

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

Success uses stdout and exit 0. Partial fetch/removal and partial/not-ready resume use stdout, `ok: false`, `data` and exit 1. Errors without results use stderr and exit 1, with `code`, `reason`, `retryable` and `action`. See [recovery](recovery.md) before retrying.
