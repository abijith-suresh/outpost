# Recovery decisions

## Settings migration

Settings, tags and extra guidance upgrade the home to version 2. Existing
workspaces keep their original roots and guidance; no worktree is moved.
The config version and incompatible repository-registry format prevent older
writers from discarding extended state, including processes that read old config
before taking the mutation lock.

An interrupted upgrade may leave version 2 defaults before the requested setting
commits. Inspect `outpost doctor --json`, `outpost config show --json` and the
operation journal. Retrying the requested setting with the newer tool repairs
forward after the lock owner has finished. Do not restore stale config/registry
backups over newer workspaces or delete a lock merely because a process looks old.
If config is missing beside a version 2 registry, init refuses to invent roots;
restore the original config only after inspecting the existing workspaces.

## Operation failures

Read the `reason`, `retryable`, `action` and diagnostics in a JSON error. The
command-level `code` identifies the command that failed. Text is explanatory and
may change; do not match it to decide whether to retry.

| Reason | Next step |
| --- | --- |
| `lock-held` | Wait for the owner to finish. If it may have crashed, inspect doctor output and verify the owner process before considering manual recovery. Age or a PID alone does not prove abandonment. |
| `dirty-worktree` | Preserve or commit the changes in that worktree. Ask for any decision about discarding user work. |
| `repo-in-use` | Inspect workspace manifests and `git worktree list` on the managed repository. Remove owned workspaces before retrying repository removal. Missing manifests do not make Git links safe to delete. |
| `repo-missing` | Inspect the repository list and the required identity. Restore the missing mirror or explicitly import the intended checkout. |
| `workspace-missing` | Inspect the workspace list and check the exact ticket. An unmanaged directory is not permission to adopt it. |
| `invalid-arguments` | Read `outpost describe <command> --json` and correct the inputs. Named values in the normalized input schema are arrays. |
| `approval-needed` | Preserve changed or foreign `AGENTS.md`. An interactive removal can request explicit consent. The preview never grants consent. |
| `invalid-state` | Run `outpost doctor --json` and inspect config, registry, manifests and Git ownership before repairing state. |
| `operation-failed` | Inspect the subprocess diagnostics, remote access and current local state. Do not assume the command rolled back completely. |

## Partial operations

A partial `repo fetch --all --json` returns per-repository `fetchStatus`, `error`
and diagnostics on stdout with exit code 1. Successfully fetched repositories have
updated timestamps. Inspect failures before issuing another explicit fetch;
fetching may change remote tracking refs and tags, but preserves local branches.

A partial `workspace remove --json` returns `completed`, `remaining`, `status` and
diagnostics. Existing worktrees, the manifest or residual files may remain. Inspect
`workspace show` and the filesystem before retrying. A nonempty workspace root is
preserved. Workspace removal does not delete local branches. Repository removal deletes
the mirror containing those branches and any commits stored only there. Retain
the mirror or save needed work outside it before repository cleanup. A local Git
bundle can preserve work without network access; push only with explicit user
authorization.

Git diagnostic output is bounded to 80 lines and 16,384 text characters in total,
40 lines and 8,192 characters per stream. `diagnosticTruncation.truncated` covers
clipped long lines, omitted lines and capture truncation. `omittedLineCount` counts
whole omitted lines from captured text; output beyond the byte capture limit is
unknown. Never interpret absence of a line in truncated output as success.

## Save local branches before repository removal

Keep the bundle and restored checkout outside the managed mirror and workspace.
A bundle containing only a saved branch may have no `HEAD`; select that branch
explicitly when restoring. For example, replace these placeholders with the
managed mirror, the branch to save, an absolute bundle path and a new directory:

```sh
git -C <mirror> rev-parse refs/heads/<saved-branch>
git -C <mirror> bundle create <absolute-bundle-path> refs/heads/<saved-branch>
git -C <mirror> bundle verify <absolute-bundle-path>
git clone --branch <saved-branch> <absolute-bundle-path> <restore-directory>
git -C <restore-directory> rev-parse HEAD
```

Record the first commit ID and confirm the restored `HEAD` matches it. Inspect
needed files in the restored checkout before deleting the mirror. Repeat for any
other branches that must survive. These bundle operations stay local; pushing
still requires explicit user authorization.

## Crash inspection

`outpost doctor --json` reports held home/ticket locks, operation intent records,
repository health and workspace health. Records describe attempted intent and
progress, not ownership proof or a safe recovery script. Outpost never replays
records or deletes crash artifacts automatically.

Verify the owner process and compare manifests with Git worktree links, branches
and actual files. Preserve work that may belong to someone else. Remove only a
proven abandoned lock or artifact after the required decision and authorization.
Re-run inspection after manual repair, then preview the intended lifecycle action.

Do not hand-edit generated workspace guidance or Outpost-managed Git metadata as
a shortcut. Repository application changes belong inside the child worktrees.
