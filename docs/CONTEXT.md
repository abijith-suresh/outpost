# Product Context

## Problem

Developers working on tickets that span multiple repositories (e.g., a backend change plus a frontend change plus a shared-library bump) must manually create matching branches across repos, set up worktrees, and track which repos belong to which ticket. This manual process is error-prone, inconsistent, and wastes time.

## Target User

Coding agents are the primary operators of Outpost, coordinating one ticket across multiple local repositories on behalf of a developer. The developer remains responsible for intent, review and approval. Human command-line use remains supported. Outpost is particularly intended for restricted enterprise machines where installing arbitrary native tools may not be possible but npm packages are available.

## Goals

- **Deterministic workspace lifecycle.** Every `outpost create` produces the same branch layout and worktree structure for the same inputs. Humans and coding agents can safely operate within these workspaces.
- **Local-first.** Workspace operations use local state. Network access happens only through explicit repository operations, never implicitly during workspace creation.
- **Safety over convenience.** Outpost must not delete, overwrite, or adopt state it cannot prove it owns. Workspace removal refuses dirty worktrees and requires explicit interactive approval before deleting modified or foreign workspace guidance.
- **Terse everyday operations.** Frequent workspace operations (create, list, remove) are short. Infrequent repository and configuration operations may remain explicit.
- **Machine-readable output.** Most commands support `--json` for scripting and agent consumption.
- **Supported settings and repository selection.** Agents and humans can inspect and validate settings through application operations. Repositories may have multiple optional flat tags, used to select concrete repository IDs when creating a workspace. Explicit repository-ID selection remains supported. Tag changes never change an existing workspace's membership.
- **Stable workspace locations.** Changing the worktree root affects future workspaces. Existing workspaces keep their original roots and paths; changing settings never moves Git worktrees. Versioned metadata must preserve legacy interpretation and make older writers refuse newer state.
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
- **Zero implicit network access during workspace creation**
- **No native binary dependencies** — uses system `git` CLI only
- **TypeScript strict mode** with ES modules
- **Native Windows PowerShell support** without WSL; platform-specific tests and installed-package checks must distinguish CI evidence from checks on the owner's laptop.
- **Bounded Windows Git paths.** Command-scoped long-path support covers Git's internal files, while repository paths, checkout working directories and worktree administrative paths must fit conservative, source-derived Git for Windows budgets. Validate canonical full paths before mutation, count bytes or UTF-16 units according to the relevant Git/Windows API, and report an actionable shorter-root choice when unsupported. Never move existing state, create aliases or change global settings to make a path fit. Existing workspaces and history remain inspectable even when a requested mutation is unsupported.

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

## Delivery phases

The first increment adds validated configuration, repository tags, guidance customization/preview, and safe versioned root handling. It retains the existing mirror-backed workflow and ownership checks.

Later increments improve create/resume and existing-branch/worktree reuse, explicit local/cached-remote/fresh-remote bases with immutable SHAs, source-only commit preservation, and recovery. Forgetting a repository registration must be separate from deleting owned Git storage; an innocuous unregister action must never delete unique branch-only commits. A human manager follows those operations, with explicit start/stop behavior and measured resource use. Manual prerelease-only distribution preparation is a final separate phase. These goals do not authorize automatic publication or a storage rewrite.
