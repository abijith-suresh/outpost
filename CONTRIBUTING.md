# Contributing to Outpost

Welcome to Outpost — a CLI tool for managing local Git repository workspaces. Outpost is built with TypeScript and [Effect-TS](https://effect.website). We're glad you're here.

## Getting Started

**Prerequisites:** Node >= 22.14.0, npm >= 11.5.1.

```bash
git clone https://github.com/your-org/outpost.git
cd outpost
npm install
npm run build
```

## Development Workflow

**Branch naming.** Use descriptive branch names prefixed by category:

- `feat/add-workspace-command`
- `fix/handle-empty-state`
- `chore/update-dependencies`
- `docs/readme-examples`

**Commit messages.** Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add list workspaces command
fix: crash when config file is missing
docs: update CLI examples in README
```

Allowed types: `feat`, `fix`, `chore`, `docs`, `style`, `refactor`, `test`.

**Before pushing.** Run the full verification suite:

```bash
npm run verify
```

This runs formatting, linting, type-checking, and tests in sequence.

**Pre-commit hooks.** Husky and lint-staged are configured to auto-fix formatting and lint issues on commit. If a hook rejects your changes, stage the fixes and try again.

## Pull Request Process

1. Every PR that changes source code **must** include a changeset:
   ```bash
   npx changeset
   ```
2. While Outpost is pre-v1, all changesets use the `patch` bump level.
3. CI must pass on every PR — this includes:
   - `format:check` – Prettier formatting
   - `lint` – ESLint
   - `typecheck` – TypeScript strict mode
   - `test` – Vitest integration tests
   - `build` – Compile to ESM
4. The [Changeset Bot](https://github.com/apps/changeset-bot) will comment on your PR if a changeset is missing.
5. Provide a clear description of what the PR does and a brief test plan.

## Project Structure

```
src/
  commands/     CLI command implementations — one file per command
  config.ts     Config file I/O and Effect Schema definitions
  program.ts    CLI routing, argument parsing, output formatting
tests/
  helpers.ts    Shared fixtures, git helpers, registry utilities
  doctor.test.ts
  repo-add.test.ts
  repo-fetch.test.ts
  repo-list.test.ts
  repo-remove.test.ts
  create.test.ts
  workspace.test.ts
  help.test.ts
  misc.test.ts   Edge-case and error-handling tests
```

- `src/commands/` — Each file exports a single command function wired up in `program.ts`.
- `src/config.ts` — Reads/writes the Outpost config file. Uses `Schema.TaggedError` for typed errors.
- `src/program.ts` — Parses raw `argv`, maps to commands, handles formatting and exit codes.
- `tests/` — Integration tests split per CLI command domain. Tests create real temporary directories and Git repositories to exercise the full CLI end-to-end, then assert against expected stdout/stderr output. Shared fixtures live in `helpers.ts`.

## Code Style

- **TypeScript strict mode** with ES modules (`"type": "module"` in package.json).
- **Effect-TS conventions.** Use `Effect.gen` for effectful logic, `Schema.TaggedError` for typed error variants, and `pipe` for composition.
- **No CLI framework.** Arguments are parsed manually from `process.argv` — learn the existing pattern before adding new flags.
- **Formatting.** Prettier with the project config.
- **Linting.** ESLint with the project config.

## Testing

```bash
npm test          # Run once
npm run test:watch  # Watch mode
```

Tests use Vitest and operate on real temporary directories. Each test scaffolds a minimal Git repository, runs Outpost against it, and compares the output. This means tests are slower than unit tests but provide high confidence in CLI behavior.

Test files are organized by CLI command domain. When adding a new command, create a corresponding test file (e.g. `tests/my-command.test.ts`) that imports shared helpers from `tests/helpers.ts`.
