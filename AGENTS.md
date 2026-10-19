# Outpost — agent brief
Repo-level brief for coding agents working in the Outpost npm-workspace monorepo.

## The Project
Core promise: deterministic local Git workspaces for one ticket across many repositories — `outpost create` produces the same branches, mirrors, and worktrees for the same inputs, and never deletes or adopts state it cannot prove it owns.
Non-goals: issue trackers or ticket content; builds, deployments, and test running; repository application code; remote collaboration (push, pull, merge).
Status: in-flight (paused) — the CLI is live on npm as `@abijith-suresh/outpost`; the pending `chore/deps/effect-4` branch holds the Effect 4 migration.

## How I Work Here
- Quality gate: `verify` — `npm run verify` at the root checks formatting and lint, runs the changeset-policy tests, then every workspace's own `verify`. Run it before handoff.
- Commits: Conventional Commits; the authoritative type list lives in `commitlint.config.mjs`. Never use `--no-verify` — husky runs `lint-staged`, `commitlint`, and `verify`. Squash merges; never commit to `main`; branch as `<feat|fix|chore|docs>/<slug>`.
- Every PR that changes releasable CLI code needs a changeset (`npx changeset`). Pre-v1, every bump is `patch` — never `minor` or `major`. Docs-only and website-only PRs need none.
- `verify` is the local gate; CI additionally runs a `Changeset policy` job, a CLI build plus installed-package smoke test, and a website build. See `CONTRIBUTING.md`.
- Hard product constraints: Node.js 24 only, no native binary dependencies (system `git` CLI only), and zero implicit network access during workspace creation.
- Update `apps/cli/README.md` in the same PR when a command or safety behavior changes. Never restate dependency versions in prose — `package.json` is authoritative.
- Two different files are named `AGENTS.md`: this hand-written brief, and the per-workspace file Outpost generates inside `~/.outpost/worktrees/<ticket>/`. The generated file is owned by Outpost via a SHA256 marker on its first line; do not hand-edit it.

## Sources of Truth
| Fact | Where |
|---|---|
| Product intent | § The Project (this file) |
| Runtime behavior and invariants | code + tests (`apps/cli/src`, `apps/cli/tests`) |
| Commands & deps | `package.json` (root and each workspace) |
| Commit rules | `commitlint.config.mjs` |
| Developer workflow, hooks, CI, release | `CONTRIBUTING.md` |
| CI and release mechanics | `.github/workflows/` |
| Released history | `apps/cli/CHANGELOG.md` |
| Pending release notes | `.changeset/` |
Code and tests are the authority; this file never overrides executable truth.

## Getting Around
- `apps/cli/` — the published `@abijith-suresh/outpost` CLI: `src/` holds routing, command handlers, and Effect services; `tests/` holds Vitest suites. Package notes in `apps/cli/AGENTS.md`.
- `apps/website/` — private Astro marketing site deployed to GitHub Pages. Package notes in `apps/website/AGENTS.md`.
- `scripts/` — Changeset policy classifier plus `node:test` coverage, wired into `npm run verify`.
- `package.json` / `package-lock.json` — private workspace coordinator and the single lockfile for `apps/*`; the root ships nothing.
- `.changeset/` — pending release notes; `.github/workflows/` — CI, Pages, and release automation.
