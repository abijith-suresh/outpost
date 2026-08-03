# Contributing to Outpost

Welcome to Outpost — a CLI tool for managing local Git repository workspaces. Outpost is built with TypeScript and [Effect-TS](https://effect.website). We're glad you're here.

## Getting Started

**Prerequisites:** Node.js >= 24.19.0 <25 (Node.js 24 only), npm >= 11.5.1.

Use a version manager that reads the checked-in `.node-version`; it pins local
work and CI to Node.js `24.19.0`.

```bash
git clone https://github.com/abijith-suresh/outpost.git
cd outpost
npm install
npm run build
```

The root is a private npm workspace coordinator. One root install provisions
the CLI and website workspaces from `package-lock.json`.

| Workspace                 | Path            | Purpose                         |
| ------------------------- | --------------- | ------------------------------- |
| `@abijith-suresh/outpost` | `apps/cli/`     | Published CLI package           |
| `outpost-website`         | `apps/website/` | Private Astro marketing website |

## Development Workflow

### Branch Naming

Use descriptive branch names prefixed by category:

- `feat/add-workspace-command`
- `fix/handle-empty-state`
- `chore/update-dependencies`
- `docs/readme-examples`

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add list workspaces command
fix: crash when config file is missing
docs: update CLI examples in README
```

Allowed types: `feat`, `fix`, `chore`, `docs`, `style`, `refactor`, `test`.

### Changesets

Every PR that changes CLI source code or package behavior **must** include a changeset:

```bash
npx changeset
```

While Outpost is pre-v1, all changesets use the `patch` bump level — never `minor` or `major`. Documentation-only changes do not require a changeset.

Website-only PRs that touch `apps/website/`, website-specific workflows, or website-specific docs/config do not require a CLI package changeset because the website is not published with `@abijith-suresh/outpost`.

The [Changeset Bot](https://github.com/apps/changeset-bot) comments on PRs if a changeset is missing. CI additionally enforces the policy in the local `Changeset policy` job: a pull request that changes a releasable CLI path without a pending patch changeset for `@abijith-suresh/outpost` fails the build.

### Changeset Policy Enforcement

Releasable CLI paths require a patch changeset:

- `apps/cli/src/**`
- `apps/cli/scripts/**`
- `apps/cli/package.json`
- `apps/cli/tsconfig.json`

Exempt unless mixed with a releasable path: tests, `dist`, documentation, website files, typecheck/test configuration, workflows, and root tooling.

A changeset satisfies the policy only when it is a non-generated `.changeset/*.md` file (excluding `.changeset/README.md`) that is added or modified by the pull request and still exists at the head revision, parsed with `@changesets/parse`, and contains exactly one release entry: `@abijith-suresh/outpost: patch`. A changeset already pending on `main`, a changeset deleted by the PR, or a malformed, additional-package, wrong-package, minor, or major entry does not satisfy the policy.

Generated release PRs (`changeset-release/main`) are exempt only when every diff entry is structurally valid generated output — deleted pending changeset Markdown files, `apps/cli/CHANGELOG.md`, `apps/cli/package.json`, and `package-lock.json`. A branch-name prefix alone never grants the exemption; any source or unexpected path disables it.

Run the policy locally with explicit base, head, and head-ref arguments (the same arguments CI passes from the pull-request event):

```bash
npm run changeset:check -- --base <base-sha> --head <head-sha> --head-ref <head-ref>
```

The pure classifier has `node:test` coverage run as part of `npm run verify`:

```bash
npm run test:policy
```

### Verification

Before pushing, run the full verification suite:

```bash
npm run verify
```

This runs, in order:

1. `format:check` — repository-wide Prettier formatting check
2. `lint` — repository-wide ESLint
3. CLI verification — TypeScript strict mode and Vitest
4. Website verification — Astro check and TypeScript

If any step fails, the remaining steps do not run. Fix the issue and re-run.

### Build

```bash
npm run build
```

Builds every workspace. The CLI compiles TypeScript to ESM in
`apps/cli/dist/`; the website builds static output in `apps/website/dist/`.

## Hooks

Husky manages Git hooks. They run automatically — never use `--no-verify` to bypass them.

| Hook         | Action                                                                                        |
| ------------ | --------------------------------------------------------------------------------------------- |
| `pre-commit` | Runs lint-staged: ESLint fix + Prettier on staged code, styles, data, and documentation files |
| `commit-msg` | Validates the commit message against `@commitlint/config-conventional`                        |
| `pre-push`   | Runs repository-wide `npm run verify`                                                         |

## Code Style

- **TypeScript strict mode** with ES modules (`"type": "module"` in package.json)
- **Effect-TS conventions:** use `Effect.gen` for effectful logic, `Schema.TaggedError` for typed error variants, `pipe` for composition
- **No CLI framework:** arguments are parsed manually from `process.argv` — follow the existing pattern in `apps/cli/src/program.ts` when adding flags
- **Formatting:** Prettier (double quotes, semicolons, trailing commas)
- **Linting:** ESLint with the TypeScript and Astro recommended rules; tests disable project-service parsing

## Testing

```bash
npm test
npm run test:watch --workspace @abijith-suresh/outpost
```

Tests use [Vitest](https://vitest.dev) and run sequentially (`fileParallelism: false`) to prevent temp directory conflicts.

**Integration tests** exercise the full CLI pipeline via `runCli()` from `apps/cli/src/index.ts`. Lifecycle tests scaffold real temporary directories and Git repositories, run Outpost against them, and assert against stdout/stderr output and filesystem state. Test files are organized by CLI command domain (e.g., `apps/cli/tests/create.test.ts`, `apps/cli/tests/workspace.test.ts`).

**Focused unit/module tests:**

- `apps/cli/tests/store.test.ts` — atomic file writes with mocked FileSystem layers
- `apps/cli/tests/path-safety.test.ts` — path containment and validation
- `apps/cli/tests/remote-identity.test.ts` — remote URL parsing and identity encoding
- `apps/cli/tests/workspace-agents.test.ts` — AGENTS.md generation, classification, and deletion

**Shared helpers** in `apps/cli/tests/helpers.ts` provide temp directory management, Git repo fixtures, registry helpers, and TTY mocking.

**Test isolation:** `afterEach` restores `process.env`, resets Vitest mocks, and recursively deletes all tracked temp directories.

## CI

GitHub Actions run on every pull request and push to `main`:

- `npm quality (Node 24) / Install and verify` calls the zero-input central
  `.github/workflows/npm-quality.yml` workflow at central PR #7's exact head
  `9bdb73a2291cd38324751293f02062b6c303744e5`. The central workflow reads
  `.node-version` and `packageManager` from the repository, installs
  dependencies with `npm ci`, and runs root `npm run verify`.
- `Changeset policy` remains local because it needs pull-request base/head
  metadata and the Outpost-specific release-path rules. It reads the same
  `.node-version` file.
- `CLI build and smoke (Node 24)` remains local because building the published
  CLI and testing its installed package are Outpost-specific checks.
- `Website build (Node 24)` remains local because website compilation is an
  Outpost-specific application check; website verification runs through the
  central quality command. Pages deployment and release validation also read
  `.node-version`.
- Outpost has one runtime policy: Node.js 24. The root and published CLI
  manifests declare `>=24.19.0 <25`, which means every Node.js 24 patch from
  the verified LTS baseline onward, but no Node.js 22 or 25 runtime. The
  checked-in `.node-version` pins CI and local development to `24.19.0`, the
  latest Node.js 24 LTS patch verified against official Node release metadata.
  This is a range for the package contract rather than an exact patch lock, so
  later compatible Node.js 24 security patches remain supported. npm remains
  the exact `npm@11.16.0` declared by `packageManager`.
- Main branch protection still requires `validate (22)` and `validate (24)`.
  Those names are retained as documented temporary aggregation aliases only;
  both report the same Node 24 jobs and neither sets up or tests Node 22. A
  later settings PR should replace those historical required names with the
  actual Node 24 job names and remove the aliases.

The generic PR-title and dependency-review callers remain pinned to released
central workflows commit `b42be9571985efb1ce10970340250fcccc657050` (`v0.1.0`).
Dependency review stays enabled through the central caller; if its check is
blocked, a repository owner must enable the dependency graph in repository
settings. The npm-quality caller uses central PR #7's immutable head
`9bdb73a2291cd38324751293f02062b6c303744e5` because that is the requested
zero-input workflow contract.

Changesets release pull requests (`chore: version packages`) are validated
through the same `pull_request` path as ordinary PRs; there is no separate
push trigger for `changeset-release/**` branches.

### GitHub Actions Pinning

External GitHub Actions referenced from `.github/workflows/` must be pinned to
full 40-character immutable commit SHAs — never floating tags, branches, or
abbreviated SHAs. The corresponding release tag must remain as a same-line
comment on the `uses:` reference so the pinned version stays legible:

```yaml
uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6.0.3
```

[Dependabot](https://docs.github.com/code-security/dependabot) is configured in
`.github/dependabot.yml` to open scheduled (weekly) `github-actions` update
pull requests against `/`. It proposes updated SHAs and release tags for the
actions already pinned in the workflows.

When reviewing or merging a Dependabot action update, contributors must verify
that the proposed SHA refers to the same commit as the documented release tag
by resolving the tag from the canonical action repository (for example via
`git ls-remote --tags` or the GitHub API). Annotated tags must be dereferenced
to their underlying commit SHA; the pinned value is always the commit SHA, not
the tag-object SHA.

Reusable workflows are also pinned to full immutable SHAs. The central
PR-title and dependency-review callers use the released
`abijith-suresh/workflows` v0.1.0 commit
`b42be9571985efb1ce10970340250fcccc657050`. The npm-quality caller uses
central PR #7's immutable head
`9bdb73a2291cd38324751293f02062b6c303744e5` and intentionally has no inputs;
the central workflow owns Node and npm setup from the caller repository's root
contract.

## Release Process

1. PRs that change CLI source or package behavior merge to `main` with changesets.
2. The [Changesets Action](https://github.com/changesets/action) opens or updates a `chore: version packages` PR.
3. The version command updates the CLI package and regenerates the root lockfile.
4. Merging that PR publishes through npm trusted publishing (`npm run publish:release`).

Publication runs are non-cancellable: the Release workflow sets
`cancel-in-progress: false`, so a newer push to `main` must not terminate an
in-progress publication.

Published workspace releases use Changesets package-qualified Git tags, such
as `@abijith-suresh/outpost@0.0.25`.

See `.github/workflows/release.yml` for details.

## Website Development

The marketing landing page lives in `apps/website/` as a private npm workspace.
It shares the root lockfile and is never published with the CLI.

### Setup

```bash
npm install
```

### Development

```bash
npm run dev --workspace outpost-website
npm run build --workspace outpost-website
npm run preview --workspace outpost-website
npm run verify --workspace outpost-website
```

### CI

The website is verified by the Node.js 24 jobs in
`.github/workflows/ci.yml`. The site is deployed to GitHub Pages via
`.github/workflows/pages.yml` after pushes to `main` that touch the website,
`.node-version`, root workspace manifests, or Pages workflow files, and through
manual
dispatch. Pull requests validate without deploying.

The Pages deployment step allows up to 20 minutes for GitHub's deployment
queue before failing. This bounded window tolerates queue backlogs without
indicating that deployments are expected to take that long.
