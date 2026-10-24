import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import {
  getRepoHealthDiagnostics,
  loadConfig,
  loadRepoRegistry,
  resolveOutpostHome,
} from "../config.js";
import { domainDetails, ErrorDetailFields, reasonDetails } from "../error-details.js";
import { validateSemanticIdentifier } from "../path-safety.js";
import type { CommandOutput } from "../types.js";

export class RepoShowError extends Schema.TaggedError<RepoShowError>()("RepoShowError", {
  ...ErrorDetailFields,
  message: Schema.String,
}) {}

export function runRepoShow(
  repoId: string | undefined,
  extraArgs: ReadonlyArray<string>
): Effect.Effect<CommandOutput<"repo show">, RepoShowError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    if (!repoId || extraArgs.length > 0) {
      return yield* Effect.fail(
        new RepoShowError({
          ...reasonDetails("invalid-arguments"),
          message: "Usage: outpost repo show <id> [--json]",
        })
      );
    }

    yield* validateSemanticIdentifier("repo id", repoId).pipe(
      Effect.mapError(
        (error) => new RepoShowError({ message: error.message, ...domainDetails(error) })
      )
    );

    const fs = yield* FileSystem.FileSystem;
    const outpostHome = yield* resolveOutpostHome();

    yield* loadConfig(outpostHome).pipe(
      Effect.mapError(
        (error) => new RepoShowError({ message: error.message, ...domainDetails(error) })
      )
    );

    const registry = yield* loadRepoRegistry(outpostHome).pipe(
      Effect.mapError(
        (error) => new RepoShowError({ message: error.message, ...domainDetails(error) })
      )
    );
    const matches = registry.repos.filter((repo) => repo.id === repoId);

    if (matches.length === 0) {
      return yield* Effect.fail(
        new RepoShowError({
          ...reasonDetails("repo-missing"),
          message: `Unknown repo id: ${repoId}`,
        })
      );
    }

    if (matches.length > 1) {
      return yield* Effect.fail(
        new RepoShowError({
          message: `Duplicate repo id in registry: ${repoId}`,
        })
      );
    }

    const { repos } = yield* getRepoHealthDiagnostics(matches).pipe(
      Effect.provideService(FileSystem.FileSystem, fs)
    );

    const shown = repos[0];
    if (!shown)
      return yield* Effect.fail(
        new RepoShowError({
          message: `Unknown repo id: ${repoId}`,
          ...reasonDetails("repo-missing"),
        })
      );
    return {
      command: "repo show",
      data: shown,
    } satisfies CommandOutput<"repo show">;
  });
}
