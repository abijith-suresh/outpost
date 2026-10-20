# outpost — agent brief
Product intent and philosophy for this repo; working agreements live in `CONTRIBUTING.md`.

## The Project
Outpost gives one ticket a single deterministic local Git workspace across many repositories: each repo gets the same branch and worktree, and Outpost refuses to delete, overwrite, or adopt state it cannot prove it owns. It targets restricted machines where npm and the system `git` CLI are the only tools you can count on.
Safety over convenience is the product, not a phase: the CLI's behavior is defined by what it refuses as much as by what it does.
Non-goals: issue trackers or ticket content; builds, deployments, or running tests; repository application code; remote collaboration (push, pull, merge).
Constraints: no native binary dependencies and no implicit network access during workspace creation — the system `git` CLI is the only external tool.
Status: in-flight (paused) — the CLI is live on npm as `@abijith-suresh/outpost`; the Effect 4 migration sits unmerged on `chore/deps/effect-4`.

## Sources of Truth
| Fact | Where |
|---|---|
| Product intent | § The Project (this file) |
| Runtime behavior and invariants | code + tests |
| Commands & deps | `package.json` (root and workspaces) |
| How to work here | `CONTRIBUTING.md` |
| Package intent | `apps/cli/AGENTS.md`, `apps/website/AGENTS.md` |
| Released history / pending notes | `apps/cli/CHANGELOG.md`, `.changeset/` |

Code and tests are the authority; this file never overrides executable truth.
