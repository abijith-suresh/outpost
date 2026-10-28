# Product Context

## Problem

Developers working on tickets that span multiple repositories (e.g., a backend change plus a frontend change plus a shared-library bump) must manually create matching branches across repos, set up worktrees, and track which repos belong to which ticket. This manual process is error-prone, inconsistent, and wastes time.

## Target User

Coding agents are the primary operators of Outpost, coordinating one ticket across multiple local repositories on behalf of a developer. The developer remains responsible for intent, review and approval. Human command-line use remains supported. Outpost is particularly intended for restricted enterprise machines where installing arbitrary native tools may not be possible but npm packages are available.

## Goals

- **Deterministic workspace lifecycle.** Every `outpost create` produces the same branch layout and worktree structure for the same inputs. Humans and coding agents can safely operate within these workspaces.
- **Explicit base provenance.** New workspaces select an owned local ref/object, a cached remote branch, or an explicitly refreshed remote branch. The default is cached remote, with no fallback to local branches. Local and cached modes never fetch. Fresh mode performs an explicit checked fetch and fails when it cannot establish the requested remote commit. Each member records its requested source/ref, resolved ref and immutable starting commit in the result, manifest and factual guidance. Creation uses that commit, and refuses false provenance if another writer changes the created branch or worktree during creation.
- **Safety over convenience.** Outpost must not delete, overwrite, or adopt state it cannot prove it owns. Workspace removal refuses dirty worktrees and requires explicit interactive approval before deleting modified or foreign workspace guidance.
- **Terse everyday operations.** Frequent workspace operations (create, list, remove) are short. Infrequent repository and configuration operations may remain explicit.
- **Machine-readable output.** Most commands support `--json` for scripting and agent consumption.
- **Supported settings and repository selection.** Agents and humans can inspect and validate settings through application operations. Repositories may have multiple optional flat tags, used to select concrete repository IDs when creating a workspace. Explicit repository-ID selection remains supported. Tag changes never change an existing workspace's membership.
- **Stable workspace locations.** Changing the worktree root affects future workspaces. Existing workspaces keep their original roots and paths; changing settings never moves Git worktrees. Versioned metadata must preserve legacy interpretation and make older writers refuse newer state.
- **Safe explicit resume.** `workspace resume <ticket>` inspects only the named existing workspace and its frozen manifest membership/root. It reports verified paths, current branch/HEAD and bounded working-state facts separately from original immutable base provenance. Owned work can be advanced, diverged, dirty or untracked and still be resumable. Wrong or detached branches, missing/foreign/inconsistent members, unavailable or retained registration and held mutation/ticket locks produce precise diagnostics and a partial or not-ready result. Resume never fetches, resolves a new base, creates or repairs worktrees, resets refs, migrates metadata, moves roots or overwrites guidance. Inspection disables optional Git writes and implicit promisor fetching. Missing manifests and interrupted residual creation require existing doctor/manual recovery, never pathname-based adoption. Repeated create points to explicit resume before any fresh fetch.
- **No configured programs during resume status.** Read-only inspection must not run content filters or nested Git status that could write files or contact a remote. Unsupported tracked submodules or assigned filters produce unknown/not-ready diagnostics and preserve work, rather than running repository-configured programs or claiming a clean checkout.
- **Preserve repository storage when unregistering.** `repo remove` forgets active registration while retaining the owned repository and its complete recorded identity. Retained repositories remain discoverable through explicit inspection and can be restored without fetching or requiring the original source or remote to remain available. Restore validates identity, ownership, containment and registration conflicts before changing metadata. Unregistering never deletes branches, objects or source work. Cached remote refs and a clean worktree do not prove local work disposable. Storage deletion is outside this increment.
- **Factual, customizable orientation.** Keep task names/tickets, automatic workspace folders and generated `AGENTS.md` with its ownership marker. Optional global extra instructions supplement the factual layout. Previewing guidance is read-only; setting instructions affects future generation and never overwrites an existing workspace's guidance.
- **One application boundary.** CLI adapters and a later human management UI use the same validated operations and mutation locks. Normal CLI commands remain daemon-free. A later manager is explicitly started, serves bundled Solid/Vite assets, and opens a browser only on request.

## Non-Goals

Outpost manages local Git repositories, branches, worktrees, workspace state, and agent orientation. It does **not** manage:

- Issue trackers or ticket content
- Builds, deployments, or testing
- Repository application code
- Remote collaboration workflows such as push, pull, and merge

## Constraints

- **Runtime:** Node.js >= 24.19.0 <25 (Node.js 24 only), npm >= 11.5.1
- **Delivery:** npm package (`@abijith-suresh/outpost`), installed globally
- **Zero implicit network access during workspace creation.** Only explicit fresh-remote base selection authorizes a creation-time fetch. Dry runs never fetch or mutate refs; a fresh preview reports unresolved freshness instead of claiming a cached SHA is fresh.
- **No native binary dependencies** — uses system `git` CLI only
- **TypeScript strict mode** with ES modules
- **Native Windows PowerShell support** without WSL; platform-specific tests and installed-package checks must distinguish CI evidence from checks on the owner's laptop.
- **Bounded Windows Git paths.** Command-scoped long-path support covers Git's internal files, while repository paths, process working directories and worktree administrative paths must fit conservative, source-derived Git for Windows and Win32 process budgets, including the trailing separator and NUL required for process creation and administrative files read before long-path configuration is available. Validate canonical full paths before mutation, count bytes or UTF-16 units according to the relevant Git/Windows API, and report an actionable shorter-root choice when unsupported. Never move existing state, create aliases or change global settings to make a path fit. Existing workspaces and history remain inspectable even when a requested mutation is unsupported.

## UX Principles

- Every command that mutates state confirms what it did or explains why it refused.
- Non-TTY environments (piped, `--json`) fail predictably on operations that require user confirmation rather than making unsafe assumptions.
- Error messages include actionable guidance (e.g., "Run `outpost repo add <path>` first").
- Commands report partial success where safe to do so (repo fetch, workspace remove).

## Success Criteria

1. An agent can discover the installed command contract, initialize Outpost, explicitly import repos, preview a ticket workspace, create it and remove it with structured lifecycle results.
2. A coding agent reading workspace `AGENTS.md` can understand which repos to work in, what branches to use, and what the workspace structure is.
3. Outpost refuses to remove worktrees with uncommitted changes and does not delete modified or foreign workspace guidance without explicit interactive approval.
4. Concurrent `outpost create` calls for the same ticket are serialized via ticket locks.
5. All commands that inspect state support `--json` for scripting.
6. An agent can change the future worktree root and still inspect and safely remove old workspaces at their original locations. Unsupported metadata versions fail closed before mutation.
7. Guidance preview retains the generated facts, and repository tag selection freezes concrete IDs without changing old workspaces.
8. Native Windows acceptance includes successful operations on real internal Git files beyond 260 characters and pre-mutation refusal of unsupported repository, checkout and derived administrative paths. Boundary, Unicode, space and junction cases preserve source commits, refs, manifests, guidance, configuration, registry and unrelated files.
9. An exact branch-only commit survives create, workspace removal, repository unregistration and explicit restoration. Retained records reserve their identities and paths, remain inspectable after failures or interruption, and cannot be replaced by an automatic import. Invalid ownership, conflicting registrations and unsupported Windows paths fail without deleting or adopting storage.
10. Local, cached-remote and fresh-remote selection resolve distinct real commits without changing local/source branches. Missing refs or objects fail explicitly. Defaults use each selected repository's recorded managed symbolic HEAD, never a guessed remote/local precedence; a fresh refresh of that branch does not claim to rediscover the remote's default branch. Base-ref changes after resolution cannot change the recorded starting commit. Fresh previews disclose that fetching is required, and partial or interrupted refreshes remain journaled rather than being described as rolled back.
11. An agent explicitly resumes a named workspace using its original root and concrete members after settings/tags change. Current advanced HEAD and dirty/untracked facts are reported without replacing the manifest's creation SHA or changing index, refs, guidance, source or Outpost metadata. Wrong/detached branches and unavailable, foreign or partial members cannot produce blind success. Offline/promisor and native Windows boundary acceptance preserve all original bytes and avoid automatic repair or broad repository scans.

## Delivery phases

The first increment adds validated configuration, repository tags, guidance customization/preview, and safe versioned root handling. It retains the existing mirror-backed workflow and ownership checks.

The next increment separates registration from storage. It adds retained-repository inspection and explicit restoration to the existing mirror-backed model, with versioned metadata that older destructive writers refuse. It does not add storage purge or infer that any local commit is disposable.

The next increment adds explicit local/cached-remote/fresh-remote bases and immutable provenance. Local selection is limited to objects already present in the owned managed repository; it does not import source-only commits. Fresh selection refreshes only remote tracking, without resetting user branches, pruning unique objects or implying a cross-repository transaction.

The next increment adds explicit read-only resume of an existing managed workspace, with current working state distinct from immutable creation provenance and no automatic repair.

Subsequent increments add deliberate existing-branch/worktree reuse, targeted source-backed import and authentication support, and recovery. A human manager follows those operations, with explicit start/stop behavior and measured resource use. Manual prerelease-only distribution preparation is a final separate phase. These goals do not authorize automatic publication or a storage rewrite.
