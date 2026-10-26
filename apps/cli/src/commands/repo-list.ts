import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { parseCommandInput, requireCommand } from "../command-spec.js";
import {
  getRepoHealthDiagnostics,
  loadConfig,
  loadRepoRegistry,
  matchesTags,
  resolveOutpostHome,
  validateTag,
} from "../config.js";
import { domainDetails, ErrorDetailFields } from "../error-details.js";
import type { CommandOutput } from "../types.js";

export class RepoListError extends Schema.TaggedError<RepoListError>()("RepoListError", {
  ...ErrorDetailFields,
  message: Schema.String,
}) {}

export function runRepoList(
  args: readonly string[] = []
): Effect.Effect<CommandOutput<"repo list">, RepoListError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const parsed = parseCommandInput(requireCommand(["repo", "list"]), args);
    const tagOption = parsed.options["--tag"];
    const tags = Array.isArray(tagOption) ? tagOption : [];
    for (const tag of tags)
      yield* validateTag(tag).pipe(
        Effect.mapError((error) => new RepoListError({ message: error.message }))
      );
    const fs = yield* FileSystem.FileSystem;
    const outpostHome = yield* resolveOutpostHome();

    yield* loadConfig(outpostHome).pipe(
      Effect.mapError(
        (error) => new RepoListError({ message: error.message, ...domainDetails(error) })
      )
    );

    const registry = yield* loadRepoRegistry(outpostHome).pipe(
      Effect.mapError(
        (error) => new RepoListError({ message: error.message, ...domainDetails(error) })
      )
    );
    const { missingRepoCount, repos } = yield* getRepoHealthDiagnostics(
      (parsed.options["--retained"]
        ? (registry.retainedRepositories ?? [])
        : registry.repos
      ).filter((repo) => matchesTags(repo, tags))
    ).pipe(Effect.provideService(FileSystem.FileSystem, fs));

    return {
      command: "repo list",
      data: {
        missingRepoCount,
        repos,
      },
    } satisfies CommandOutput<"repo list">;
  });
}
