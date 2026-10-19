# outpost-website — agent brief
Package-level notes for the private marketing site; the root `AGENTS.md` brief still applies.

## The Project
Core promise: a static Astro landing page for the CLI, served from GitHub Pages under the `/outpost` base path.
Non-goals: no npm publication, no changeset, no CLI behavior.
Status: live — redeployed by pushes to `main`.

## How I Work Here
- Quality gate: `verify` — here that is `npm run check && npm run typecheck` (Astro check, then `tsc --noEmit`).
- Website-only PRs need no changeset; changesets cover the published CLI only.
- Deploys are path-filtered: pushes to `main` touching `apps/website/**`, `package.json`, `package-lock.json`, `.node-version`, or the Pages workflow redeploy the site; pull requests validate without deploying.
- Keep routes and asset URLs base-path-aware — the site is served from `/outpost`, not the domain root.

## Sources of Truth
| Fact | Where |
|---|---|
| Runtime behavior | `apps/website/src` |
| Commands & deps | `apps/website/package.json` |
| Deploy pipeline | `.github/workflows/pages.yml` |

## Getting Around
- `src/pages/` — routes; `src/components/` — shared UI; `src/styles/` — CSS
- `src/assets/` — processed assets; `public/` — copied verbatim
- `astro.config.ts` — `site`, the `/outpost` base, and trailing-slash mode
