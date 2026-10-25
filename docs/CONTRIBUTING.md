# Contributing to Outpost

Welcome to Outpost — a CLI tool for managing local Git repository workspaces. Outpost is built with TypeScript and [Effect-TS](https://effect.website). We're glad you're here.

## Getting Started

**Prerequisites:** Node.js >= 24.19.0 <25 (Node.js 24 only), npm >= 11.5.1.

Use a version manager that reads the checked-in `.node-version` for the local
and CI runtime. Use the exact npm release declared in root `packageManager`.

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

1. `format:check` — repository-wide Biome formatting check
2. `lint` — repository-wide Biome lint
3. `test:policy` — Changeset policy and command tests
4. CLI verification — TypeScript strict mode and Vitest
5. Website verification — Astro check and TypeScript

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
| `pre-commit` | Runs lint-staged: Biome checks and fixes on staged code, styles, and data files |
| `commit-msg` | Validates the commit message against `@commitlint/config-conventional`                        |
| `pre-push`   | Runs repository-wide `npm run verify`                                                         |

## Code Style

- **TypeScript strict mode** with ES modules (`"type": "module"` in package.json)
- **Effect-TS conventions:** use `Effect.gen` for effectful logic, `Schema.TaggedError` for typed error variants, `pipe` for composition
- **No CLI framework:** arguments are parsed manually from `process.argv` — follow the existing pattern in `apps/cli/src/program.ts` when adding flags
- **Formatting and linting:** Biome, configured in `biome.json`. Run `npm run format` for formatting and `npm run lint:fix` for lint fixes. Markdown files are not included in the staged-code hook.
- **Runtime types:** the CLI declares Node.js types directly for the supported runtime major. Keep the website compiler within the Astro checker's peer dependency range.

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
  `.github/workflows/npm-quality.yml` workflow pinned in the local CI caller.
  The central workflow reads
  `.node-version` and `packageManager` from the repository, installs
  dependencies with `npm ci`, and runs root `npm run verify`.
- `Changeset policy` remains local because it needs pull-request base/head
  metadata and the Outpost-specific release-path rules. It reads the same
  `.node-version` file.
- `CLI build and smoke (Node 24, <OS>)` runs on Ubuntu and native Windows. Each
  matrix job builds the CLI, runs focused settings/path regressions, packs and
  installs the actual tarball, then exercises installed commands and offline
  schemas from an unrelated directory. Windows uses the npm-generated `.cmd`
  shim through native PowerShell, with spaces and Unicode in fixture paths.
  This matrix does not claim the entire POSIX process-shutdown suite is portable
  or that the owner's managed laptop has been tested.
- `Website build (Node 24)` remains local because website compilation is an
  Outpost-specific application check; website verification runs through the
  central quality command. Pages deployment and release validation also read
  `.node-version`.
- Outpost supports the Node.js major and minimum patch declared in the root and
  published CLI manifests. `.node-version` selects the CI and development patch;
  update it when supported security releases arrive. The root `packageManager`
  field is authoritative for npm. Package manifests and workflow files contain
  the current versions and pins.
- Main branch protection still requires `validate (22)` and `validate (24)`.
  Those names are retained as documented temporary aggregation aliases only;
  both report the same Node 24 jobs and neither sets up or tests Node 22. A
  later settings PR should replace those historical required names with the
  actual Node 24 job names and remove the aliases.

The dependency-review and conventional-commit-title callers are pinned in their
respective `.github/workflows/` files. Dependency review remains enabled through
the central caller; if its check is blocked, a repository owner must enable the
dependency graph in repository settings. The central npm-quality workflow owns
Node and npm setup from the caller repository's root contract.

The Release workflow remains disabled while publication is paused. Quality,
package installation and Changeset checks do not require publication. Do not
enable the workflow as part of testing feature changes.

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

Reusable workflows follow the same immutable-SHA rule. Their `uses:` references
and release comments in `.github/workflows/` are authoritative; avoid duplicating
changing pins in documentation.

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

The release action reads structured Changesets publication events through
`CHANGESETS_OUTPUT` to identify published packages and push their tags. Custom
publish scripts must preserve that environment variable. The workflow passes
the release token through the action's explicit `github-token` input and keeps
Git CLI pushes for version commits and tags.

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

## Shipped guidance and schemas

After changing the command registry or result schemas, run
`npm run docs:generate --workspace @abijith-suresh/outpost` and commit the updated
command reference, man page and schemas. Both CLI build and verify reject drift.
The assets are checked in so installed packages work offline with scripts disabled.
Use `npm run test:smoke` to test the actual packed global install, including its
scoped-package man link. Validate skill edits with the skill creator's
`quick_validate.py` when available and review lifecycle/recovery decisions against
current behavior.

Changes to shipped `apps/cli/skills/`, `apps/cli/man/` or `apps/cli/schemas/` are
releasable package changes and require a patch changeset, including asset-only PRs.
Repository documentation that does not ship remains exempt under the usual policy.

To reproduce CLI latency, run `npm run benchmark --workspace @abijith-suresh/outpost`.
It builds the CLI, creates temporary local Git fixtures and reports three-process
medians for cheap startup paths and listing 1/10/50/100 real workspaces. Run before
and after on the same Node version and machine without other test suites running;
fixture setup is not timed. Keep raw samples and distinguish this measurement from
prior audit baselines.

Schema generation also updates `apps/cli/src/schema-integrity.ts`, whose compiled
per-command digests identify installed output assets. Commit it with generated
schema changes. `docs:generate` compiles the definitions, generates assets and
the digest map, then recompiles so `dist describe` immediately uses the new map.
Build and docs checks reject stale digest metadata as well as asset drift. Do not
generate expected digests from installed assets at runtime.
