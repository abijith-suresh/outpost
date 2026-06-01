import * as FileSystem from "@effect/platform/FileSystem";
import type * as Path from "@effect/platform/Path";
import { Effect, Schema } from "effect";

import {
  getRepoHealthDiagnostics,
  loadConfig,
  loadRepoRegistry,
  resolveOutpostHome,
} from "../config.js";
import type { CommandOutput } from "../types.js";

export class RepoListError extends Schema.TaggedError<RepoListError>()(
  "RepoListError",
  {
    message: Schema.String,
  },
) {}

export function runRepoList(): Effect.Effect<
  CommandOutput,
  RepoListError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const outpostHome = yield* resolveOutpostHome();

    yield* loadConfig(outpostHome).pipe(
      Effect.mapError((error) => new RepoListError({ message: error.message })),
    );

    const registry = yield* loadRepoRegistry(outpostHome).pipe(
      Effect.mapError((error) => new RepoListError({ message: error.message })),
    );
    const { missingRepoCount, repos } = yield* getRepoHealthDiagnostics(
      registry.repos,
    ).pipe(Effect.provideService(FileSystem.FileSystem, fs));

    return {
      command: "repo list",
      data: {
        missingRepoCount,
        repos,
      },
    } satisfies CommandOutput;
  });
}
