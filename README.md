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

See [`docs/CONTRIBUTING.md`](docs/CONTRIBUTING.md) for the complete development
and release workflow.

## Optional human manager

Run `outpost manage` for a foreground local manager, or `outpost manage --open` to explicitly open its pairing link. It serves bundled production assets. Ordinary CLI commands remain daemon-free. The first manager supports recorded inventory, clone registration and retained unregister/restore, managed tags and future-workspace settings. Current Git content state and workspace lifecycle actions remain explicit CLI operations. Stop the manager with Ctrl+C or its Stop manager action.
