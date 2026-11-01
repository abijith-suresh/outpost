import * as Effect from "effect/Effect";
import { RepoRestoreError, restoreRepository } from "../application/repo-restore.js";
import { reasonDetails } from "../error-details.js";

export { RepoRestoreError } from "../application/repo-restore.js";
export function runRepoRestore(repoId: string | undefined, extraArgs: readonly string[]) {
  const dryRun = extraArgs.length === 1 && extraArgs[0] === "--dry-run";
  if (!repoId || (extraArgs.length > 0 && !dryRun))
    return Effect.fail(
      new RepoRestoreError({
        ...reasonDetails("invalid-arguments"),
        message: "Usage: outpost repo restore <id> [--dry-run] [--json]",
      })
    );
  return restoreRepository(repoId, dryRun);
}
