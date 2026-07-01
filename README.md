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
