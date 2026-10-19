# Outpost

Outpost manages deterministic local Git workspaces for tickets that span
multiple repositories. It is designed for developers and coding agents working
on restricted machines where npm packages and the system Git CLI are available.

## Projects

- [`apps/cli`](apps/cli/README.md) contains the published
  [`@abijith-suresh/outpost`](https://www.npmjs.com/package/@abijith-suresh/outpost)
  CLI and its complete usage documentation.
- [`apps/website`](apps/website/) contains the Astro marketing website deployed
  to [GitHub Pages](https://abijith-suresh.github.io/outpost/).

## Development

Install every workspace from the repository root:

```bash
npm install
npm run verify
npm run build
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the complete development and
release workflow.

## Architecture

The root package is a private npm workspace coordinator: one lockfile,
aggregate scripts, and nothing published. Workspaces live under `apps/*` and
are provisioned by a single root install.

- [`apps/cli/`](apps/cli/) — the published CLI. `src/cli.ts` is the `outpost`
  binary entry point and `src/index.ts` the import-safe `runCli()` API.
  `src/program.ts` parses arguments and dispatches through the registry in
  `src/command-spec.ts` — the single source for command metadata, help, and
  `outpost describe` — to handlers in `src/commands/`. Filesystem, path,
  process, and console work goes through Effect services. Package invariants
  are summarized in [`apps/cli/AGENTS.md`](apps/cli/AGENTS.md).
- [`apps/website/`](apps/website/) — the private Astro site, built to static
  output and deployed to GitHub Pages under the `/outpost` base path.

Runtime state lives under `$OUTPOST_HOME` (default `~/.outpost`): `config.json`
and `repos.json` at the root, `repos/` for managed bare mirrors, `workspaces/`
for ticket manifests and lock files, and `worktrees/<ticket>/` for the
checkouts Outpost creates, including a generated workspace `AGENTS.md`.
