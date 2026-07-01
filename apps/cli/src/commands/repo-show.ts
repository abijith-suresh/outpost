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

export class RepoShowError extends Schema.TaggedError<RepoShowError>()(
  "RepoShowError",
  {
    message: Schema.String,
  },
) {}

export function runRepoShow(
  repoId: string | undefined,
  extraArgs: ReadonlyArray<string>,
): Effect.Effect<
  CommandOutput,
  RepoShowError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    if (!repoId || extraArgs.length > 0) {
      return yield* Effect.fail(
        new RepoShowError({
          message: "Usage: outpost repo show <id> [--json]",
        }),
      );
    }

    const fs = yield* FileSystem.FileSystem;
    const outpostHome = yield* resolveOutpostHome();

    yield* loadConfig(outpostHome).pipe(
      Effect.mapError((error) => new RepoShowError({ message: error.message })),
    );

    const registry = yield* loadRepoRegistry(outpostHome).pipe(
      Effect.mapError((error) => new RepoShowError({ message: error.message })),
    );
    const matches = registry.repos.filter((repo) => repo.id === repoId);

    if (matches.length === 0) {
      return yield* Effect.fail(
        new RepoShowError({ message: `Unknown repo id: ${repoId}` }),
      );
    }

    if (matches.length > 1) {
      return yield* Effect.fail(
        new RepoShowError({
          message: `Duplicate repo id in registry: ${repoId}`,
        }),
      );
    }

    const { repos } = yield* getRepoHealthDiagnostics(matches).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
    );

    return {
      command: "repo show",
      data: repos[0] ?? {},
    } satisfies CommandOutput;
  });
}
