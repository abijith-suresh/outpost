import { Effect, Result, Schema } from "effect";
import * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { commandString, gitCommand } from "../child-process.js";
import { loadConfig, loadRepoRegistry, resolveOutpostHome, writeRepoRegistry } from "../config.js";
import { validateManagedRepoPath, verifyManagedRepository } from "../managed-repo.js";
import { acquireHomeMutationLock } from "../mutation-lock.js";
import { getCanonicalPortablePathKey, validateSemanticIdentifier } from "../path-safety.js";
import type { CommandOutput } from "../types.js";
import {
  listManifestTickets,
  readManifest,
  resolveManagedPath,
  scanWorktreesRoot,
} from "../workspace-manifest.js";

export class RepoRemoveError extends Schema.TaggedError<RepoRemoveError>()("RepoRemoveError", {
  message: Schema.String,
}) {}

export function runRepoRemove(
  repoId: string | undefined,
  extraArgs: ReadonlyArray<string>
): Effect.Effect<
  CommandOutput,
  RepoRemoveError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  return Effect.gen(function* () {
    if (!repoId || extraArgs.length > 0) {
      return yield* Effect.fail(
        new RepoRemoveError({
          message: "Usage: outpost repo remove <id> [--json]",
        })
      );
    }

    yield* validateSemanticIdentifier("repo id", repoId).pipe(
      Effect.mapError((error) => new RepoRemoveError({ message: error.message }))
    );

    const fs = yield* FileSystem.FileSystem;
    const outpostHome = yield* resolveOutpostHome();

    const config = yield* loadConfig(outpostHome).pipe(
      Effect.mapError((error) => new RepoRemoveError({ message: error.message }))
    );

    const mutation = yield* acquireHomeMutationLock(outpostHome, "repo remove").pipe(
      Effect.mapError((error) => new RepoRemoveError({ message: error.message }))
    );
    const registry = yield* loadRepoRegistry(outpostHome).pipe(
      Effect.mapError((error) => new RepoRemoveError({ message: error.message }))
    );

    const existingRepo = registry.repos.find((repo) => repo.id === repoId);

    if (!existingRepo) {
      return yield* Effect.fail(new RepoRemoveError({ message: `Unknown repo id: ${repoId}` }));
    }

    const tickets = yield* listManifestTickets(outpostHome).pipe(
      Effect.mapError((error) => new RepoRemoveError({ message: error.message }))
    );

    const referencingWorkspaces: Array<string> = [];
    const uninspectableManifests: Array<string> = [];

    for (const ticket of tickets) {
      const manifestResult = yield* readManifest(outpostHome, ticket).pipe(Effect.result);

      if (Result.isFailure(manifestResult)) {
        uninspectableManifests.push(ticket);
        continue;
      }

      const manifest = manifestResult.success;
      let isReferencing = false;

      for (const repo of manifest.repositories) {
        if (repo.id === existingRepo.id) {
          isReferencing = true;
          break;
        }

        const resolvedManagedPathResult = yield* Effect.result(
          resolveManagedPath(config.reposRoot, repo.managedPath)
        );

        if (Result.isSuccess(resolvedManagedPathResult)) {
          const manifestPathKey = yield* getCanonicalPortablePathKey(
            resolvedManagedPathResult.success
          );
          const repoPathKey = yield* getCanonicalPortablePathKey(existingRepo.managedRepoPath);

          if (manifestPathKey === repoPathKey) {
            isReferencing = true;
            break;
          }
        }
      }

      if (isReferencing) {
        referencingWorkspaces.push(ticket);
      }
    }

    if (uninspectableManifests.length > 0) {
      const manifestList = uninspectableManifests.map((t) => `"${t}"`).join(", ");
      return yield* Effect.fail(
        new RepoRemoveError({
          message: `Cannot remove repo ${existingRepo.id}: workspace manifest(s) for ${manifestList} could not be inspected and may still reference this repository`,
        })
      );
    }

    if (referencingWorkspaces.length > 0) {
      const wsList = referencingWorkspaces.map((t) => `"${t}"`).join(", ");
      return yield* Effect.fail(
        new RepoRemoveError({
          message: `Cannot remove repo ${existingRepo.id}: referenced by workspace(s): ${wsList}`,
        })
      );
    }

    const unmanagedTickets = yield* scanWorktreesRoot(config.worktreesRoot, outpostHome).pipe(
      Effect.mapError((error) => new RepoRemoveError({ message: error.message }))
    );

    const warnings =
      unmanagedTickets.length > 0
        ? [
            `${unmanagedTickets.length} unmanaged workspace(s) found under worktreesRoot. Inspect them before cleanup; Git-linked worktrees still block repository removal.`,
          ]
        : [];
    const managedPath = yield* validateManagedRepoPath(config.reposRoot, existingRepo).pipe(
      Effect.mapError((error) => new RepoRemoveError({ message: error.message }))
    );
    const exists = yield* fs
      .exists(managedPath)
      .pipe(Effect.mapError((error) => new RepoRemoveError({ message: error.message })));
    if (exists) {
      yield* verifyManagedRepository(config.reposRoot, existingRepo).pipe(
        Effect.mapError((error) => new RepoRemoveError({ message: error.message }))
      );
      const worktrees = yield* commandString(
        gitCommand("--git-dir", managedPath, "worktree", "list", "--porcelain", "-z")
      ).pipe(
        Effect.mapError(
          (error) =>
            new RepoRemoveError({ message: `Cannot inspect Git worktrees: ${error.message}` })
        )
      );
      // The first record describes the bare repository itself. Any subsequent
      // record protects an actual link, even if its path or manifest is missing.
      if (worktrees.split("\0").filter((field) => field.startsWith("worktree ")).length > 1) {
        return yield* Effect.fail(
          new RepoRemoveError({
            message: `Cannot remove repo ${existingRepo.id}: linked Git worktrees still exist. Inspect them with git worktree list before retrying.`,
          })
        );
      }
      yield* mutation
        .record({
          action: "remove-repository",
          repoId: existingRepo.id,
          managedRepoPath: managedPath,
        })
        .pipe(Effect.mapError((error) => new RepoRemoveError({ message: error.message })));
      yield* fs.remove(managedPath, { recursive: true }).pipe(
        Effect.mapError(
          (error) =>
            new RepoRemoveError({
              message: `Failed to remove repo directory: ${error.message}`,
            })
        )
      );
    }

    const nextRegistry = {
      ...registry,
      repos: registry.repos.filter((repo) => repo.id !== repoId),
    };

    yield* mutation
      .record({
        action: "unregister-repository",
        repoId: existingRepo.id,
        managedRepoPath: managedPath,
      })
      .pipe(Effect.mapError((error) => new RepoRemoveError({ message: error.message })));
    yield* writeRepoRegistry(outpostHome, nextRegistry).pipe(
      Effect.mapError((error) => new RepoRemoveError({ message: error.message }))
    );

    return {
      command: "repo remove",
      data: {
        id: existingRepo.id,
        name: existingRepo.name,
        managedRepoPath: existingRepo.managedRepoPath,
        remoteUrl: existingRepo.remoteUrl,
        sourceRepoPath: existingRepo.sourceRepoPath,
        warnings,
      },
    } satisfies CommandOutput;
  }).pipe(Effect.scoped);
}
