# Product Context

## Problem

Developers working on tickets that span multiple repositories (e.g., a backend change plus a frontend change plus a shared-library bump) must manually create matching branches across repos, set up worktrees, and track which repos belong to which ticket. This manual process is error-prone, inconsistent, and wastes time.

## Target User

The primary user is an individual developer coordinating one ticket across multiple local repositories. Outpost is particularly intended for restricted enterprise machines where installing arbitrary native tools may not be possible but npm packages are available.

## Goals

- **Deterministic workspace lifecycle.** Every `outpost create` produces the same branch layout and worktree structure for the same inputs. Humans and coding agents can safely operate within these workspaces.
- **Local-first.** Outpost works entirely on the local filesystem. Network access happens only through explicit repository fetch operations, never implicitly during workspace creation.
- **Safety over convenience.** Outpost must not delete, overwrite, or adopt state it cannot prove it owns. Workspace removal refuses dirty worktrees and unmodified generated files.
- **Terse everyday operations.** Frequent workspace operations (create, list, remove) are short. Infrequent repository and configuration operations may remain explicit.
- **Machine-readable output.** Most commands support `--json` for scripting and agent consumption.

## Non-Goals

Outpost manages local Git repositories, branches, worktrees, workspace state, and agent orientation. It does **not** manage:

- Issue trackers or ticket content
- Builds, deployments, or testing
- Repository application code
- Remote operations beyond fetch (no push, no pull, no merge)

## Constraints

- **Runtime:** Node.js >= 22.14.0, npm >= 11.5.1
- **Delivery:** npm package (`@abijith-suresh/outpost`), installed globally
- **Zero implicit network access during workspace creation**
- **No native binary dependencies** — uses system `git` CLI only
- **TypeScript strict mode** with ES modules

## UX Principles

- Every command that mutates state confirms what it did or explains why it refused.
- Non-TTY environments (piped, `--json`) fail predictably on operations that require user confirmation rather than making unsafe assumptions.
- Error messages include actionable guidance (e.g., "Run `outpost repo add <path>` first").
- Commands report partial success where safe to do so (repo fetch, workspace remove).

## Success Criteria

1. A developer can initialize Outpost, import repos, create a ticket workspace, navigate it, and remove it — all from the command line.
2. A coding agent reading workspace `AGENTS.md` can understand which repos to work in, what branches to use, and what the workspace structure is.
3. Outpost refuses to remove worktrees with uncommitted changes or workspaces with modified generated files.
4. Concurrent `outpost create` calls for the same ticket are serialized via ticket locks.
5. All commands that inspect state support `--json` for scripting.
