import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { loadConfig, loadRepoRegistry, resolveOutpostHome, writeRepoRegistry } from "../config.js";
import { domainDetails, ErrorDetailFields, reasonDetails } from "../error-details.js";
import { verifyRetainedRepository } from "../managed-repo.js";
import { acquireHomeMutationLock } from "../mutation-lock.js";
import { validateSemanticIdentifier } from "../path-safety.js";
import type { CommandOutput } from "../types.js";
import { validateWindowsInvocationCwd, validateWindowsManagedGitDir } from "../windows-git-path.js";
import { transferBorrowed } from "./repositories.js";

export class RepoRestoreError extends Schema.TaggedError<RepoRestoreError>()("RepoRestoreError", {
  ...ErrorDetailFields,
  message: Schema.String,
}) {}

export function restoreRepository(repoId: string, dryRun = false) {
  return Effect.gen(function* () {
    yield* validateSemanticIdentifier("repo id", repoId);
    yield* validateWindowsInvocationCwd();
    const outpostHome = yield* resolveOutpostHome();
    const config = yield* loadConfig(outpostHome);
    const mutation = dryRun
      ? undefined
      : yield* acquireHomeMutationLock(outpostHome, "repo restore");
    if (mutation) yield* mutation.record({ action: "inspect-registration-transfer", repoId });
    const borrowed = yield* transferBorrowed(outpostHome, repoId, "restore", dryRun);
    if (borrowed) {
      if (mutation && !dryRun)
        yield* mutation.record({ action: "borrowed-registration-restore-completed", repoId });
      return { command: "repo restore" as const, data: borrowed };
    }
    const registry = yield* loadRepoRegistry(outpostHome);
    const retained = registry.retainedRepositories?.find((repo) => repo.id === repoId);
    if (!retained)
      return yield* Effect.fail(
        new RepoRestoreError({
          ...reasonDetails("repo-missing"),
          message: `No retained repository with id ${repoId}. Inspect outpost repo list --retained. Arbitrary directories cannot be adopted.`,
        })
      );
    yield* validateWindowsManagedGitDir(retained.managedRepoPath);
    yield* verifyRetainedRepository(config.reposRoot, retained);
    const data = {
      id: retained.id,
      name: retained.name,
      managedRepoPath: retained.managedRepoPath,
      action: "restored" as const,
      storage: "retained" as const,
    };
    if (dryRun)
      return {
        command: "repo restore",
        data: { ...data, dryRun: true },
      } satisfies CommandOutput<"repo restore">;
    if (!mutation)
      return yield* Effect.fail(new RepoRestoreError({ message: "Missing mutation lock" }));
    yield* mutation.record({
      action: "restore-repository-registration",
      repoId,
      managedRepoPath: retained.managedRepoPath,
    });
    const { retainedAt: _, ...restored } = retained;
    yield* writeRepoRegistry(outpostHome, {
      ...registry,
      repos: [...registry.repos, restored],
      retainedRepositories:
        registry.retainedRepositories?.filter((repo) => repo.id !== repoId) ?? [],
    });
    return { command: "repo restore", data } satisfies CommandOutput<"repo restore">;
  }).pipe(
    Effect.scoped,
    Effect.mapError(
      (error) => new RepoRestoreError({ message: error.message, ...domainDetails(error) })
    )
  );
}
