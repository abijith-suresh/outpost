import * as Effect from "effect/Effect";
import { RepoRemoveError, unregisterRepository } from "../application/repo-remove.js";
import { reasonDetails } from "../error-details.js";

export { RepoRemoveError } from "../application/repo-remove.js";
export function runRepoRemove(repoId: string | undefined, extraArgs: readonly string[]) {
  const dryRun = extraArgs.length === 1 && extraArgs[0] === "--dry-run";
  if (!repoId || (extraArgs.length > 0 && !dryRun))
    return Effect.fail(
      new RepoRemoveError({
        ...reasonDetails("invalid-arguments"),
        message: "Usage: outpost repo remove <id> [--json]",
      })
    );
  return unregisterRepository(repoId, dryRun);
}
