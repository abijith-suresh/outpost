# @abijith-suresh/outpost — agent brief
Package-level agreements for the published CLI; the root `AGENTS.md` brief applies.

## The Project
Core promise: this package is the whole product — the `outpost` binary plus an import-safe `runCli()` API. Its behavior is defined by what it refuses as much as by what it does.
Non-goals: no push, pull, merge, or remote mutation beyond fetching managed mirrors.

## How I Work Here
- Refusals are the feature: removal refuses dirty worktrees and foreign or modified guidance, and creation rolls back rather than leaving partial state. Fix the cause, never the check.
- Error codes are assigned explicitly at parser, router, and handler boundaries; never infer a code from message text.
- Non-TTY and `--json` runs must fail predictably instead of assuming; mutation commands report what they did or why they refused.
- The generated workspace `AGENTS.md` is hash-owned: never hand-edit one, and always compare the classified snapshot before deleting.
- TTY detection, `process.env`, `Date`, and readline prompts are deliberately direct Node — don't migrate them into Effect services without a reason.
- State writes stay atomic and reads stay validating; ticket locks stay create-if-absent.

## Sources of Truth
| Fact | Where |
|---|---|
| Runtime behavior and invariants | `apps/cli/src` + `apps/cli/tests` |
| Commands & deps | `apps/cli/package.json` |
| User-facing docs | `apps/cli/README.md` |
