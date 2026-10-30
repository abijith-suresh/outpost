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
If config is missing beside a version 2 or 3 registry, init refuses to invent roots;
restore the original config only after inspecting the existing workspaces.

## Base selection and provenance

Create defaults to `--base-source cached-remote`, with no local fallback. Use
`local` for an available owned ref/object, and `fresh-remote` only when an explicit
network refresh is intended. `--base` selects a ref; an omitted ref uses each
repository's recorded managed symbolic HEAD branch. It does not promise that the
remote still uses that default branch.

Fresh dry runs and guidance previews never fetch. They report unresolved
`fetch-required` provenance, not a cached SHA labeled fresh. Fresh execution must
establish an actual fetched commit or fail. Ref and object failures are not
permission to reset branches, delete source work or silently choose another mode.
Source-only objects absent from managed storage require a later supported import
path; preserve the source checkout. Missing promisor objects also fail rather
than triggering Git's lazy fetch. Do not retry offline selection expecting the
same command to import missing commits or checkout objects.

New version 3 manifests pin the original root and record requested source/ref,
resolved ref and actual immutable commit per member. Older manifest readers
refuse them. Legacy manifests remain readable without invented provenance. Do not
strip the new fields or restore an old manifest over a newer workspace.

Creation records resolved SHAs before branch/worktree mutation and checks actual
created work before committing the manifest. A raced or changed branch/worktree
is preserved when ownership or the starting commit can no longer be confirmed.
Fresh refreshes completed before a later failure or cancellation remain local
state; inspect confirmed refresh receipts and current refs in the journal. A
failure is not a promise that all Git changes rolled back. A private receipt ref
under `refs/outpost/base-fetch/` may remain to preserve a received commit. Inspect
its actual ref/value and recorded ownership before making a recovery decision.
Do not delete it merely to clear an error. Recovery records are
inspection evidence, never automatic replay or deletion authority.

## Existing branch admission

`create --reuse-branch <name>` admits an existing direct branch already in each
selected owned managed repository. It does not fetch, import source work, reset,
rename or create that branch. Version 4 manifests record immutable admission
provenance and `branchDisposition: existing`; previous readers refuse them.
Current HEAD may later differ and remains separate from original provenance.

All members are preflighted before workspace mutation. Prepared verify-only Git
transactions hold branch locks during attachment. The journal records admission
plans and lock intent before taking those locks. A hard crash can leave Git ref
locks or unconfirmed worktree artifacts. Preserve them and verify the owner and
actual Git state manually. Neither intent nor a matching path proves ownership,
and no journal step grants permission to delete or reset an existing branch.
Ordinary interruption aborts transactions and closes their input without ref
updates. Dirty, advanced or uncertain residual work remains inspectable; never
use force/prune or clear locks merely to make a retry pass. Missing/unsupported
objects, external alternate pools or object/ref aliases, assigned filters, tracked submodules and unsupported status/index data
require deliberate inspection, not a generic bypass. Existing ticket work uses
explicit resume instead of creating over it.

## Operation failures

`workspace resume <ticket>` reports an existing workspace without repairing it.
Its frozen root and members come from the manifest, not current settings or tags.
Current HEAD and working-state entries are separate from `originalBase` creation
facts. Preserve advanced, diverged, dirty and untracked work. A partial/not-ready
result is not permission to switch branches, delete paths, clear a lock or recreate
a checkout. Read member diagnostics for wrong/detached branches, missing/foreign
paths, inconsistent ownership and retained/unregistered storage. Inspect retained
records explicitly before any deliberate restoration. Resume never adopts them.

Inspection can be unknown because an object is unavailable, output exceeded a
bound, a path is unsupported or state changed during the snapshot. It never
silently fetches missing promisor objects or calls that state clean. Retry only
after inspecting the reason. If no complete manifest exists, use doctor and the
existing operation journal; residual files alone do not establish ownership.

For managed workspaces, tracked submodules and assigned content filters make resume status
unsupported in this slice. Managed inspection refuses nested status or custom filter
programs. Borrowed status instead trusts configured conversions, as described below. Preserve work and inspect the diagnostic;
do not clear global Git settings or add a bypass to make it report clean.
Split indexes are likewise reported unknown/not-ready before Git can renew shared
index timestamps. Resume does not convert or rewrite them.

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
preserved. Workspace removal does not delete local branches. Repository removal
unregisters while retaining the mirror and all its refs and objects. Inspect
`repo list --retained --json` and explicitly restore the saved registration when
needed. Neither command authorizes storage deletion or a network push.

Git diagnostic output is bounded to 80 lines and 16,384 text characters in total,
40 lines and 8,192 characters per stream. `diagnosticTruncation.truncated` covers
clipped long lines, omitted lines and capture truncation. `omittedLineCount` counts
whole omitted lines from captured text; output beyond the byte capture limit is
unknown. Never interpret absence of a line in truncated output as success.

## Restore a retained registration

`repo remove` moves the complete registered record into the retained set in one
atomic registry write. It never deletes Git storage. `repo list --retained --json`
and `repo show <id> --retained --json` expose that saved identity and location.
`repo restore <id> --dry-run --json` previews ownership and path validation;
`repo restore <id> --json` reactivates the exact record without fetching.
The source checkout and remote may be offline or gone. `repo add` refuses retained
identities and arbitrary pre-existing directories, so it cannot silently replace
branch-only work.

Lifecycle mutation installs registry version 3 behind the configuration version 2
barrier. The version 3 registry reserves active and retained IDs and canonical
paths. Older destructive repository writers refuse it. If a failure occurs
between the barrier and the transfer, the record remains active; if the transfer
commits, it is retained. Inspect both lists and operation records after a crash.
Do not restore older registry backups or use a journal as adoption authority.
Missing, foreign or changed storage stays recorded and must pass the original
identity/ownership checks before restoration. There is no purge or force bypass.

## Save a separate local copy

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
needed files in the restored checkout before relying on the backup. Retained
Outpost storage remains managed state; this copy does not authorize its deletion. Repeat for any
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

Reuse object ownership includes selected loose commit/tree/blob files and fanout directories, plus bounded pack/index metadata. Preserve rejected symlinks, junctions and their targets. Do not copy, repack or unlink storage to make admission succeed; source-backed import remains a separate operation. Regular owned files and surviving hardlinks remain supported.

## Borrowed local workspace recovery

New borrowed tickets require explicit local full heads/tags refs or commit SHAs.
Manifest v5 freezes original common/owned checkout/admin identity and provenance.
Missing source objects are not restored or fetched automatically; external storage
is not a backup. Resume uses the frozen owned checkout and common identity, not a
replacement source path. Unsupported legacy writers must refuse v5.

Explicit borrowed population/status/normal removal trusts repository configured
clean/smudge/process/LFS tools. These can have side effects or network access.
Local means Outpost does not implicitly fetch. Metadata-only registration/listing
remains offline. Do not interpret a failed status or removal as proof that no
configured program ran. Hooks/fsmonitor remain disabled.

Failed/cancelled borrowed-containing creation conservatively retains every
possible branch/reflog and checkout/admin/guidance. An A-B-A ref history cannot be
proved untouched from its current SHA. Inspect doctor and the journal's original
SHA, expected member paths, confirmation flags and unknown surviving state.
Do not force-remove, reset, adopt or repeat creation over residual ticket paths.
No automatic rollback or clean retry is promised. Normal successful removal must
validate owned clean work, and always preserves all branches. Managed-only
rollback semantics are unchanged.

## Named borrowed cache selection

Use explicit cached-remote, --remote NAME and --base branch/full-heads-ref. The
required cache is refs/remotes/NAME/BRANCH. Missing/custom-only caches do not cause
fallback, fetch or helper invocation. A cache is an unverified snapshot, not server
freshness. Correct missing/multiple/invalid remote metadata in the saved clone
outside Outpost; raw URL/config/subprocess diagnostics are deliberately withheld.
Never paste credentials or private helper output into operation metadata.

Manifest6 freezes original named cache/server ref/SHA and storage/root/membership.
Do not downgrade it to v5, whose borrowed semantics are local-only. Older binaries
report v6 show as invalid and refuse resume/removal/reference inspection. Current resume/show/remove use
frozen state even if remote config changes or the saved linked launch anchor is
gone. Normal owned removal preserves all branches. Failed/cancelled admission still
retains exact branches/reflogs and uncertain checkout/admin/guidance for doctor;
no destructive retry or clean rollback is promised. Borrowed fresh/auth/reuse remain
unsupported, and trusted content conversion programs may have effects/network.
