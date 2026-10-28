---
name: outpost
description: Manage local multi-repository Git workspaces with the Outpost CLI, including repository import, workspace creation, safe resume, inspection, removal and recovery. Use when operating Outpost, not for application code changes inside a worktree.
---

# Outpost

Use `outpost describe <command> --json` for the installed command contract,
including input and output schemas, network access, side effects and retry policy.
Use `--json` for lifecycle commands. Help and version remain text.
Read [commands](references/commands.md) for syntax and
[recovery](references/recovery.md) when an operation fails or returns a partial result.

## Choose the next operation

- For a known existing ticket, use named `workspace resume` inspection. Use
  `outpost doctor --json` to diagnose initialization or recovery.
  `OUTPOST_HOME` selects the home; otherwise it is `~/.outpost`.
- If the home is not initialized, run `outpost init --json` before list commands.
  Then inspect `outpost repo list --json` and `outpost workspace list --json`
  before changing existing repositories or workspaces.
- Import a local checkout with `outpost repo add <path> --json` only when repository
  network access is intended. `outpost repo fetch --all --json` explicitly updates
  managed repositories. Both can access the remote. Create uses cached remote
  refs by default and never falls back to local branches. Select
  `--base-source local` for owned local refs/objects. Only explicit
  `--base-source fresh-remote` authorizes a creation-time fetch.
- Select exact IDs from `repo list`. Preview with
  `outpost create --ticket <ticket> --type <type> --repo <id> --dry-run --json`.
  Use repeated `--repo` options for multiple repositories, then create with the
  same arguments without `--dry-run`. Non-interactive create requires all inputs.
  Use `--base <ref>` to choose a ref; omitted refs use each repository's recorded
  managed symbolic HEAD branch, which is not a newly discovered remote default.
  Inspect each member's requested source/ref, resolved ref and immutable starting
  SHA. Fresh previews report `fetch-required` with no resolved fresh SHA and never
  fetch. Fresh execution fails on unavailable refs/network/authentication instead
  of falling back to cache. Local mode cannot use source-only objects absent from
  owned managed storage. Preserve source work until targeted import is supported.
- Continue an existing ticket with `outpost workspace resume <ticket> --json`.
  Use its verified paths, current branch/HEAD and working-state facts. Preserve
  `originalBase` as creation history even when current HEAD has advanced. Dirty,
  untracked or diverged owned work on the expected branch can be resumable.
  Inspect partial/not-ready member diagnostics; wrong/detached branches, missing
  or foreign members, unavailable/retained registration and held locks require
  explicit inspection. Resume never fetches, switches branches, resets, repairs,
  adopts, moves paths or overwrites guidance/metadata. Repeating create points to
  resume and cannot fresh-fetch an existing ticket. Missing manifests or crash
  residuals require doctor/manual recovery, not a new create over existing work.
- Inspect settings with `outpost config show --json`. Set `worktreesRoot` only
  for future workspaces; old workspaces keep their recorded paths. The first
  creation or settings/tag/guidance mutation upgrades metadata so older writers refuse it.
  Keep the newer tool after migration; do not restore stale config over new state.
- Use `repo tag <id> --add <tag> --remove <tag> --json` for optional flat tags.
  `repo list --tag <tag>` and `create --tag <tag>` require every supplied tag.
  Tags filter explicit `--repo` IDs when combined; workspace membership freezes
  at creation and is unaffected by later tag edits.
- Use `guidance set <file> --json` for optional global plaintext instructions,
  `guidance clear --json` to clear them, and `guidance preview` with create's
  selection arguments to inspect the full factual `AGENTS.md` without writes.
  Settings affect future generation and never overwrite existing guidance.
- Read the generated workspace `AGENTS.md` to find child worktrees. Run Git and
  application commands inside the relevant worktree. Read its own `AGENTS.md` if present.
  Navigate using `ticketDirectory`, the absolute workspace root, and returned
  worktree paths. `workspacePath` is relative metadata, not a path from your cwd.
  Verify the current branch before committing. The workspace root is not a repo.
- Preview cleanup with `outpost workspace remove <ticket> --dry-run --json`, then
  remove only when cleanup is intended. Dirty worktrees block removal. Local
  branches are preserved, including work committed after creation.
- Unregister with `outpost repo remove <id> --dry-run --json`, then execute only
  when registration removal is intended and no workspaces or Git links reference
  it. This retains the mirror, local branches and all objects. No storage purge
  is provided. Inspect saved registrations with `repo list --retained --json`
  and `repo show <id> --retained --json`. Use `repo restore <id> --dry-run --json`
  before explicitly restoring. Restore checks the saved identity, ownership and
  path; it never fetches, clones or adopts arbitrary unregistered directories.
  Missing source/remote paths do not require another import. Do not remove or
  replace retained storage to make a failed command pass.
  Push only if the user explicitly authorizes that network action.

## Interpret the result before retrying

Success JSON has `ok: true` and exit code 0. Partial fetch/removal or a resume
result that is partial/not-ready has
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
