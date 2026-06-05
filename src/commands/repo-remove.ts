import * as FileSystem from "@effect/platform/FileSystem";
import type * as Path from "@effect/platform/Path";
import { Effect, Schema } from "effect";

import {
  loadConfig,
  loadRepoRegistry,
  resolveOutpostHome,
  writeRepoRegistry,
} from "../config.js";
import type { CommandOutput } from "../types.js";

export class RepoRemoveError extends Schema.TaggedError<RepoRemoveError>()(
  "RepoRemoveError",
  {
    message: Schema.String,
  },
) {}

export function runRepoRemove(
  repoId: string,
): Effect.Effect<
  CommandOutput,
  RepoRemoveError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    if (!repoId) {
      return yield* Effect.fail(
        new RepoRemoveError({
          message: "Usage: outpost repo remove <id>",
        }),
      );
    }

    const fs = yield* FileSystem.FileSystem;
    const outpostHome = yield* resolveOutpostHome();

    yield* loadConfig(outpostHome).pipe(
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
