---
name: outpost
description: Manage local multi-repository Git workspaces with the Outpost CLI, including repository import, workspace creation, inspection, removal and recovery. Use when operating Outpost, not for application code changes inside a worktree.
---

# Outpost

Use `outpost describe <command> --json` for the installed command contract,
including input and output schemas, network access, side effects and retry policy.
Use `--json` for lifecycle commands. Help and version remain text.
Read [commands](references/commands.md) for syntax and
[recovery](references/recovery.md) when an operation fails or returns a partial result.

## Choose the next operation

- Inspect `outpost doctor --json`, `outpost repo list --json` and
  `outpost workspace list --json` before changing existing state.
- Run `outpost init --json` if the home is not initialized. `OUTPOST_HOME` selects
  the home; otherwise it is `~/.outpost`.
- Import a local checkout with `outpost repo add <path> --json` only when repository
  network access is intended. `outpost repo fetch --all --json` explicitly updates
  managed repositories. Both can access the remote. Create never fetches.
- Select exact IDs from `repo list`. Preview with
  `outpost create --ticket <ticket> --type <type> --repo <id> --dry-run --json`.
  Use repeated `--repo` options for multiple repositories, then create with the
  same arguments without `--dry-run`. Non-interactive create requires all inputs.
- Read the generated workspace `AGENTS.md` to find child worktrees. Run Git and
  application commands inside the relevant worktree and read its own guidance.
  Navigate using `ticketDirectory`, the absolute workspace root, and returned
  worktree paths. `workspacePath` is relative metadata, not a path from your cwd.
  Verify the current branch before committing. The workspace root is not a repo.
- Preview cleanup with `outpost workspace remove <ticket> --dry-run --json`, then
  remove only when cleanup is intended. Dirty worktrees block removal. Local
  branches are preserved, including work committed after creation.
- Remove a repository with `outpost repo remove <id> --dry-run --json`, followed
  by removal only after workspaces and Git links no longer reference it. Repository
  removal deletes the mirror that stores its local branches and commits. Keep the
  mirror or save needed work elsewhere first, for example with a local Git bundle.
  Push only if the user explicitly authorizes that network action.

## Interpret the result before retrying

Success JSON has `ok: true` and exit code 0. Partial fetch or removal has
`ok: false`, `data` and exit code 1 on stdout. Inspect per-repository results or
`completed`, `remaining` and diagnostics; do not treat a partial result as a
complete rollback. Errors without results are JSON on stderr with a stable
command `code` plus `reason`, `retryable` and `action`.

A dry run is an advisory snapshot. Execution rechecks state under locks.
`retryable` does not authorize deleting a lock or repeating a mutation blindly.
After a crash, run doctor and inspect the recorded owner, Git worktrees, branches
and files. Outpost does not automatically reap locks or recover artifacts.

Do not edit the generated workspace `AGENTS.md`. Outpost owns it and records its
content hash. Preserve modified or foreign guidance. Non-interactive removal
refuses to delete it; explicit interactive consent is required. Do not add a force
flag or delete files merely to make a failed command pass.

Guidance ships offline. `outpost docs [topic]` reads it, `outpost skill path --json`
locates package assets, and `outpost skill export <directory> --json` explicitly
copies this portable skill to `<directory>/outpost`. Export refuses an existing
destination. It never installs into an agent's configuration automatically.
