# outpost-website — agent brief
Package-level notes for the private marketing site; the root `AGENTS.md` brief applies.

## The Project
Core promise: the public landing page for the CLI. It is a private workspace, never published, so it never needs a changeset.
Non-goals: no CLI behavior, no npm release.
Status: live — served from GitHub Pages under the `/outpost` base path.

## How I Work Here
- Routes and asset URLs must stay base-path-aware; the site is not served from the domain root.
- Pages serves static files only — no server runtime, so don't add features that assume one.
- Pull requests validate only; merging to `main` is what deploys.

## Sources of Truth
| Fact | Where |
|---|---|
| Runtime behavior | `apps/website/src` |
| Commands & deps | `apps/website/package.json` |
| Deploy pipeline | `.github/workflows/pages.yml` |
