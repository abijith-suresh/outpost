# Agents

This file defines conventions for AI coding agents working on this project.
For the full contributing guide, see [CONTRIBUTING.md](./CONTRIBUTING.md).

## Key Rules

1. **Changesets required** — every PR with source changes must include a changeset. Create one with `npx changeset`.
2. **Pre-v1: all bumps are `patch`** — never use `minor` or `major` in a changeset.
3. **Run `npm run verify` before pushing** — this runs format:check, lint, typecheck, and test.
4. **Never use `--no-verify`** — it bypasses husky hooks (lint-staged, commitlint) and can cause CI failures.
5. **Conventional commits** — use `feat:`, `fix:`, `chore:`, `docs:`, `style:`, `refactor:`, `test:` prefixes.
6. **Branch naming** — use `feat/`, `fix/`, `chore/`, `docs/` prefixes.

## Stack

- **Language:** TypeScript 6 (strict, ES2022, ES modules)
- **Runtime:** Node.js >= 22.14.0
- **Effects system:** Effect-TS (v3.21.2) — all side effects return `Effect.Effect`
- **Config/Schema:** `Schema.TaggedError` for errors, `Schema.Struct` for config validation
- **Testing:** Vitest (integration tests with real temp Git repos)
- **CI:** GitHub Actions (format:check, lint, typecheck, test, build)
- **Changeset enforcement:** [Changeset Bot](https://github.com/apps/changeset-bot) comments on PRs, documented in CONTRIBUTING.md
