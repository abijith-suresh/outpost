# outpost

`outpost` is a TypeScript CLI for managing local repository workspaces.

## Status

This project is in pre-release bootstrap mode. The repository is public, but the package is intentionally versioned as `0.0.1` and is not ready for mainstream production use.

## Development

```bash
npm install
npm run lint
npm run typecheck
npm run test
npm run build
```

## Release Flow

- User-facing changes should include a changeset in `.changeset/`.
- Merging to `main` updates or creates a release PR.
- Merging the release PR publishes the package from GitHub Actions.
- npm trusted publishing should be configured for `.github/workflows/release.yml`.
