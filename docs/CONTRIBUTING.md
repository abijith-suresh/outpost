# Contributing to Outpost

Welcome to Outpost — a CLI tool for managing local Git repository workspaces. Outpost is built with TypeScript and [Effect-TS](https://effect.website). We're glad you're here.

## Getting Started

**Prerequisites:** Node.js >= 22.14.0, npm >= 11.5.1.

```bash
git clone https://github.com/abijith-suresh/outpost.git
cd outpost
npm install
npm run build
```

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

Website-only PRs that touch `website/`, website-specific workflows, or website-specific docs/config do not require a CLI package changeset because the website is not published with `@abijith-suresh/outpost`.

The [Changeset Bot](https://github.com/apps/changeset-bot) comments on PRs if a changeset is missing.

### Verification

Before pushing, run the full verification suite:

```bash
npm run verify
```

This runs, in order:

1. `format:check` — Prettier formatting check
2. `lint` — ESLint
3. `typecheck` — TypeScript strict mode (src + tests)
4. `test` — Vitest test suite

If any step fails, the remaining steps do not run. Fix the issue and re-run.

### Build

```bash
npm run build
```

Compiles TypeScript to ESM in `dist/`. Required before running the CLI locally.

## Hooks

Husky manages Git hooks. They run automatically — never use `--no-verify` to bypass them.

| Hook         | Action                                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------------------------- |
| `pre-commit` | Runs lint-staged: ESLint fix + Prettier on staged TypeScript/JavaScript files, Prettier on JSON/Markdown/YAML files |
| `commit-msg` | Validates the commit message against `@commitlint/config-conventional`                                              |
| `pre-push`   | Runs `npm run verify` (format:check, lint, typecheck, test)                                                         |

## Code Style

- **TypeScript strict mode** with ES modules (`"type": "module"` in package.json)
- **Effect-TS conventions:** use `Effect.gen` for effectful logic, `Schema.TaggedError` for typed error variants, `pipe` for composition
- **No CLI framework:** arguments are parsed manually from `process.argv` — follow the existing pattern in `src/program.ts` when adding flags
- **Formatting:** Prettier (double quotes, semicolons, trailing commas)
- **Linting:** ESLint with the TypeScript recommended rules; tests disable project-service parsing

## Testing

```bash
npm test              # Run once
npm run test:watch    # Watch mode
```

Tests use [Vitest](https://vitest.dev) and run sequentially (`fileParallelism: false`) to prevent temp directory conflicts.

**Integration tests** exercise the full CLI pipeline via `runCli()` from `src/index.ts`. Lifecycle tests scaffold real temporary directories and Git repositories, run Outpost against them, and assert against stdout/stderr output and filesystem state. Test files are organized by CLI command domain (e.g., `tests/create.test.ts`, `tests/workspace.test.ts`).

**Focused unit/module tests:**

- `tests/store.test.ts` — atomic file writes with mocked FileSystem layers
- `tests/path-safety.test.ts` — path containment and validation
- `tests/remote-identity.test.ts` — remote URL parsing and identity encoding
- `tests/workspace-agents.test.ts` — AGENTS.md generation, classification, and deletion

**Shared helpers** in `tests/helpers.ts` provide temp directory management, Git repo fixtures, registry helpers, and TTY mocking.

**Test isolation:** `afterEach` restores `process.env`, resets Vitest mocks, and recursively deletes all tracked temp directories.

## CI

GitHub Actions run on every PR and push to `main`:

1. `format:check` — Prettier formatting
2. `lint` — ESLint
3. `typecheck` — TypeScript strict mode
4. `test` — Vitest test suite
5. `build` — Compile to ESM

CI runs on Node.js 22 and 24 (`fail-fast: false`).

## Release Process

1. PRs that change source or package behavior merge to `main` with changesets.
2. The [Changesets Action](https://github.com/changesets/action) opens or updates a `chore: version packages` PR.
3. Merging that PR publishes to npm via trusted publishing (`npm run publish:release`).

See `.github/workflows/release.yml` for details.

## Website Development

The marketing landing page lives in `website/` as a standalone npm package with its own `package.json` and lockfile. It is not an npm workspace and is not published with the CLI.

### Setup

```bash
npm ci --prefix website
```

### Development

```bash
npm run --prefix website dev      # Start dev server
npm run --prefix website build    # Build static output to website/dist/
npm run --prefix website preview  # Preview built output
npm run --prefix website verify   # Type-check with astro check and tsc
```

### CI

The website is verified in CI via the `website` job in `.github/workflows/ci.yml`. The site is deployed to GitHub Pages via `.github/workflows/pages.yml` after pushes to `main` that touch website or Pages workflow files, and through manual dispatch. Pull requests validate without deploying.
