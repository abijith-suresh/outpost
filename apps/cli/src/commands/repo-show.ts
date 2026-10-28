import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import { commandString, readOnlyGitCommand as gitCommand } from "../child-process.js";
import {
  getRepoHealthDiagnostics,
  loadConfig,
  loadRepoRegistry,
  resolveOutpostHome,
} from "../config.js";
import { domainDetails, ErrorDetailFields, reasonDetails } from "../error-details.js";
import { verifyRetainedRepository } from "../managed-repo.js";
import { validateSemanticIdentifier } from "../path-safety.js";
import type { CommandOutput } from "../types.js";
import { validateWindowsInvocationCwd, validateWindowsManagedGitDir } from "../windows-git-path.js";

export class RepoShowError extends Schema.TaggedError<RepoShowError>()("RepoShowError", {
  ...ErrorDetailFields,
  message: Schema.String,
}) {}

export function runRepoShow(
  repoId: string | undefined,
  extraArgs: ReadonlyArray<string>
): Effect.Effect<
  CommandOutput<"repo show">,
  RepoShowError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  return Effect.gen(function* () {
    const retained = extraArgs.length === 1 && extraArgs[0] === "--retained";
    if (!repoId || (extraArgs.length > 0 && !retained)) {
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

    const config = yield* loadConfig(outpostHome).pipe(
      Effect.mapError(
        (error) => new RepoShowError({ message: error.message, ...domainDetails(error) })
      )
    );

    const registry = yield* loadRepoRegistry(outpostHome).pipe(
      Effect.mapError(
        (error) => new RepoShowError({ message: error.message, ...domainDetails(error) })
      )
    );
    const matches = (retained ? (registry.retainedRepositories ?? []) : registry.repos).filter(
      (repo) => repo.id === repoId
    );

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
    if (retained) {
      const inspection = yield* Effect.gen(function* () {
        yield* validateWindowsInvocationCwd();
        yield* validateWindowsManagedGitDir(shown.managedRepoPath);
        yield* verifyRetainedRepository(config.reposRoot, shown, gitCommand);
        const output = yield* commandString(
          gitCommand(
            "--git-dir",
            shown.managedRepoPath,
            "for-each-ref",
            "--format=%(refname)%09%(objectname)"
          )
        );
        const refs = output
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const [name, objectId] = line.split("\t");
            return { name, objectId };
          });
        return { status: "ok" as const, refs, diagnostics: [] as string[] };
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed({ status: "unavailable" as const, refs: [], diagnostics: [error.message] })
        )
      );
      return {
        command: "repo show",
        data: { ...shown, inspection },
      } satisfies CommandOutput<"repo show">;
    }
    return {
      command: "repo show",
      data: shown,
    } satisfies CommandOutput<"repo show">;
  });
}
