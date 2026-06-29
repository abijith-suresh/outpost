import * as FileSystem from "@effect/platform/FileSystem";
import type * as Path from "@effect/platform/Path";
import { Console, Effect, Either, Schema } from "effect";

import {
  loadConfig,
  loadRepoRegistry,
  resolveOutpostHome,
  writeRepoRegistry,
} from "../config.js";
import { getCanonicalPortablePathKey } from "../path-safety.js";
import type { CommandOutput } from "../types.js";
import {
  listManifestTickets,
  readManifest,
  resolveManagedPath,
  scanWorktreesRoot,
} from "../workspace-manifest.js";

export class RepoRemoveError extends Schema.TaggedError<RepoRemoveError>()(
  "RepoRemoveError",
  {
    message: Schema.String,
  },
) {}

export function runRepoRemove(
  repoId: string | undefined,
  extraArgs: ReadonlyArray<string>,
): Effect.Effect<
  CommandOutput,
  RepoRemoveError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    if (!repoId || extraArgs.length > 0) {
      return yield* Effect.fail(
        new RepoRemoveError({
          message: "Usage: outpost repo remove <id> [--json]",
        }),
      );
    }

    const fs = yield* FileSystem.FileSystem;
    const outpostHome = yield* resolveOutpostHome();

    const config = yield* loadConfig(outpostHome).pipe(
      Effect.mapError(
        (error) => new RepoRemoveError({ message: error.message }),
      ),
    );

    const registry = yield* loadRepoRegistry(outpostHome).pipe(
      Effect.mapError(
        (error) => new RepoRemoveError({ message: error.message }),
      ),
    );

    const existingRepo = registry.repos.find((repo) => repo.id === repoId);

    if (!existingRepo) {
      return yield* Effect.fail(
        new RepoRemoveError({ message: `Unknown repo id: ${repoId}` }),
      );
    }

    const tickets = yield* listManifestTickets(outpostHome).pipe(
      Effect.mapError(
        (error) => new RepoRemoveError({ message: error.message }),
      ),
    );

    const referencingWorkspaces: Array<string> = [];
    const uninspectableManifests: Array<string> = [];

    for (const ticket of tickets) {
      const manifestResult = yield* readManifest(outpostHome, ticket).pipe(
        Effect.either,
      );

      if (Either.isLeft(manifestResult)) {
        uninspectableManifests.push(ticket);
        continue;
      }

      const manifest = manifestResult.right;
      let isReferencing = false;

      for (const repo of manifest.repositories) {
        if (repo.id === existingRepo.id) {
          isReferencing = true;
          break;
        }

        const resolvedManagedPathResult = yield* Effect.either(
          resolveManagedPath(config.reposRoot, repo.managedPath),
        );

        if (Either.isRight(resolvedManagedPathResult)) {
          const manifestPathKey = yield* getCanonicalPortablePathKey(
            resolvedManagedPathResult.right,
          );
          const repoPathKey = yield* getCanonicalPortablePathKey(
            existingRepo.managedRepoPath,
          );

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
      const manifestList = uninspectableManifests
        .map((t) => `"${t}"`)
        .join(", ");
      return yield* Effect.fail(
        new RepoRemoveError({
          message: `Cannot remove repo ${existingRepo.id}: workspace manifest(s) for ${manifestList} could not be inspected and may still reference this repository`,
        }),
      );
    }

    if (referencingWorkspaces.length > 0) {
      const wsList = referencingWorkspaces.map((t) => `"${t}"`).join(", ");
      return yield* Effect.fail(
        new RepoRemoveError({
          message: `Cannot remove repo ${existingRepo.id}: referenced by workspace(s): ${wsList}`,
        }),
      );
    }

    const unmanagedTickets = yield* scanWorktreesRoot(
      config.worktreesRoot,
      outpostHome,
    ).pipe(
      Effect.mapError(
        (error) => new RepoRemoveError({ message: error.message }),
      ),
    );

    if (unmanagedTickets.length > 0) {
      yield* Console.warn(
        `Warning: ${unmanagedTickets.length} unmanaged workspace(s) found under worktreesRoot. They have no manifests and cannot reference repos, but consider cleaning them up.`,
      );
    }

    yield* fs.remove(existingRepo.managedRepoPath, { recursive: true }).pipe(
      Effect.mapError(
        (error) =>
          new RepoRemoveError({
            message: `Failed to remove repo directory: ${error.message}`,
          }),
      ),
    );

    const nextRegistry = {
      ...registry,
      repos: registry.repos.filter((repo) => repo.id !== repoId),
    };

    yield* writeRepoRegistry(outpostHome, nextRegistry).pipe(
      Effect.mapError(
        (error) => new RepoRemoveError({ message: error.message }),
      ),
    );

    return {
      command: "repo remove",
      data: {
        id: existingRepo.id,
        name: existingRepo.name,
        managedRepoPath: existingRepo.managedRepoPath,
        remoteUrl: existingRepo.remoteUrl,
        sourceRepoPath: existingRepo.sourceRepoPath,
      },
    } satisfies CommandOutput;
  });
}
