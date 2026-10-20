# outpost — agent brief
Product and working agreements for agents contributing to this repo.

## The Project
Outpost gives one ticket a single deterministic local Git workspace across many repositories: each repo gets the same branch and worktree, and Outpost refuses to delete, overwrite, or adopt state it cannot prove it owns. It targets restricted machines where npm and the system `git` CLI are the only tools you can count on.
Non-goals: issue trackers or ticket content; builds, deployments, or running tests; repository application code; remote collaboration (push, pull, merge).
Status: in-flight (paused) — the CLI is live on npm as `@abijith-suresh/outpost`; the Effect 4 migration sits unmerged on `chore/deps/effect-4`.

## How I Work Here
- Safety over convenience is the product, not a phase: never weaken a validation, preflight, or ownership check to make a test, command, or flow pass.
- Focused tests for what you touched before handoff; CI owns the full suite. Run `npm run verify` before pushing and never use `--no-verify`.
- Conventional Commits; squash merges; never commit to `main`.
- Pre-v1 changesets are `patch` only; docs-only and website-only changes need none.
- Update `apps/cli/README.md` when a command or safety behavior changes. Never restate dependency versions in prose — manifests own them.
- Two things are named `AGENTS.md`: this brief, and the file Outpost generates in each workspace. The generated one is hash-owned; never hand-edit it.
- No native binary dependencies and no implicit network access during workspace creation — the system `git` CLI is the only external tool.

## Sources of Truth
| Fact | Where |
|---|---|
| Product intent | § The Project (this file) |
| Runtime behavior and invariants | code + tests |
| Commands & deps | `package.json` (root and workspaces) |
| Commit rules | `commitlint.config.mjs` |
| Workflow, hooks, CI, release | `CONTRIBUTING.md`, `.github/workflows/` |
| Released history / pending notes | `apps/cli/CHANGELOG.md`, `.changeset/` |
Code and tests are the authority; this file never overrides executable truth.

## Getting Around
- `apps/cli/` — published CLI. Read `apps/cli/AGENTS.md` before changing workspace lifecycle, ownership, or output behavior.
- `apps/website/` — private marketing site. Read `apps/website/AGENTS.md` before touching deploy or base-path behavior.
