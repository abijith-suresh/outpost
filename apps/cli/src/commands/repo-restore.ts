import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import { loadConfig, loadRepoRegistry, resolveOutpostHome, writeRepoRegistry } from "../config.js";
import { domainDetails, ErrorDetailFields, reasonDetails } from "../error-details.js";
import { verifyRetainedRepository } from "../managed-repo.js";
import { acquireHomeMutationLock } from "../mutation-lock.js";
import { validateSemanticIdentifier } from "../path-safety.js";
import type { CommandOutput } from "../types.js";
import { validateWindowsInvocationCwd, validateWindowsManagedGitDir } from "../windows-git-path.js";
import { transferBorrowed } from "./repo-register.js";

export class RepoRestoreError extends Schema.TaggedError<RepoRestoreError>()("RepoRestoreError", {
  ...ErrorDetailFields,
  message: Schema.String,
}) {}

export function runRepoRestore(
  repoId: string | undefined,
  extraArgs: readonly string[]
): Effect.Effect<
  CommandOutput<"repo restore">,
  RepoRestoreError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  return Effect.gen(function* () {
    const dryRun = extraArgs.length === 1 && extraArgs[0] === "--dry-run";
    if (!repoId || (extraArgs.length > 0 && !dryRun))
      return yield* Effect.fail(
        new RepoRestoreError({
          ...reasonDetails("invalid-arguments"),
          message: "Usage: outpost repo restore <id> [--dry-run] [--json]",
        })
      );
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
