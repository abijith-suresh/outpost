# apps/website — agent brief

The public landing page for the CLI: a private Astro workspace, never published, so it never needs a changeset.

## The Project
Core promise: explain what Outpost does and how to install it. The site is static files served from GitHub Pages under the `/outpost` base path.
Non-goals: no CLI behavior, no npm release.

## Sources of Truth
| Fact | Where |
|---|---|
| Runtime behavior | `apps/website/src` |
| Commands & deps | `apps/website/package.json` |
| How to work here | root `CONTRIBUTING.md` |
| Deploy pipeline | `.github/workflows/pages.yml` |
