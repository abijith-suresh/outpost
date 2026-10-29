import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import type { RepoRecord, RepoRegistry } from "../config.js";
import { loadConfig, loadRepoRegistry, resolveOutpostHome, writeRepoRegistry } from "../config.js";
import type { ErrorDetails } from "../error-details.js";
import { domainDetails, ErrorDetailFields, reasonDetails } from "../error-details.js";
import { verifyManagedRepository } from "../managed-repo.js";
import { acquireHomeMutationLock } from "../mutation-lock.js";
import type { CommandOutput, DiagnosticTruncation } from "../types.js";
import {
  validateWindowsInvocationCwd,
  validateWindowsLocalTransport,
  validateWindowsManagedGitDir,
} from "../windows-git-path.js";
import { fetchBareRepository, type RepoMirrorDiagnostic } from "./repo-mirror.js";

export class RepoFetchError extends Schema.TaggedError<RepoFetchError>()("RepoFetchError", {
  ...ErrorDetailFields,
  message: Schema.String,
}) {}

type RepoFetchResult = {
  id: string;
  name: string;
  managedRepoPath: string;
  remoteName: string;
  remoteUrl: string;
  sourceRepoPath: string;
  fetchStatus: "fetched" | "failed";
  lastFetchedAt: string;
  error?: string;
  diagnostics?: ReadonlyArray<RepoMirrorDiagnostic>;
  diagnosticTruncation?: DiagnosticTruncation;
  reason?: string;
  retryable?: boolean;
  action?: string;
};

function usageError(): RepoFetchError {
  return new RepoFetchError({
    ...reasonDetails("invalid-arguments"),
    message: "Usage: outpost repo fetch --all [--json]",
  });
}

function buildSuccessResult(repo: RepoRecord, lastFetchedAt: string): RepoFetchResult {
  return {
    id: repo.id,
    name: repo.name,
    managedRepoPath: repo.managedRepoPath,
    remoteName: repo.remoteName,
    remoteUrl: repo.remoteUrl,
    sourceRepoPath: repo.sourceRepoPath,
    fetchStatus: "fetched",
    lastFetchedAt,
  };
}

function buildFailureResult(
  repo: RepoRecord,
  error: string,
  diagnostics: ReadonlyArray<RepoMirrorDiagnostic>,
  details: ErrorDetails,
  diagnosticTruncation?: DiagnosticTruncation
): RepoFetchResult {
  return {
    id: repo.id,
    name: repo.name,
    managedRepoPath: repo.managedRepoPath,
    remoteName: repo.remoteName,
    remoteUrl: repo.remoteUrl,
    sourceRepoPath: repo.sourceRepoPath,
    fetchStatus: "failed",
    lastFetchedAt: repo.lastFetchedAt,
    error,
    ...details,
    ...(diagnosticTruncation ? { diagnosticTruncation } : {}),
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
  };
}

type RepoProcessResult = {
  registryRepo: RepoRecord;
  result: RepoFetchResult;
};

function fetchOneRepo(
  repo: RepoRecord,
  reposRoot: string
): Effect.Effect<
  RepoProcessResult,
  never,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  return verifyManagedRepository(reposRoot, repo).pipe(
    Effect.flatMap(() => fetchBareRepository(repo.managedRepoPath)),
    Effect.map(() => {
      const lastFetchedAt = new Date().toISOString();

      return {
        registryRepo: {
          ...repo,
          lastFetchedAt,
        },
        result: buildSuccessResult(repo, lastFetchedAt),
      } satisfies RepoProcessResult;
    }),
    Effect.catch((error) =>
      Effect.succeed({
        registryRepo: repo,
        result: buildFailureResult(
          repo,
          error.message,
          "diagnostics" in error ? error.diagnostics : [],
          domainDetails(error, "operation-failed"),
          "diagnosticTruncation" in error ? error.diagnosticTruncation : undefined
        ),
      } satisfies RepoProcessResult)
    )
  );
}

function buildUpdatedRegistry(
  registry: RepoRegistry,
  processedRepos: ReadonlyArray<RepoProcessResult>
): RepoRegistry {
  return {
    ...registry,
    repos: processedRepos.map((processedRepo) => processedRepo.registryRepo),
  };
}

export function runRepoFetch(
  args: ReadonlyArray<string>
): Effect.Effect<
  CommandOutput<"repo fetch">,
  RepoFetchError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  return Effect.gen(function* () {
    if (args.length !== 1 || args[0] !== "--all") {
      return yield* Effect.fail(usageError());
    }

    yield* validateWindowsInvocationCwd().pipe(
      Effect.mapError(
        (error) => new RepoFetchError({ message: error.message, ...domainDetails(error) })
      )
    );
    const outpostHome = yield* resolveOutpostHome();

    const config = yield* loadConfig(outpostHome).pipe(
      Effect.mapError(
        (error) => new RepoFetchError({ message: error.message, ...domainDetails(error) })
      )
    );

    const mutation = yield* acquireHomeMutationLock(outpostHome, "repo fetch").pipe(
      Effect.mapError(
        (error) => new RepoFetchError({ message: error.message, ...domainDetails(error) })
      )
    );
    const registry = yield* loadRepoRegistry(outpostHome).pipe(
      Effect.mapError(
        (error) => new RepoFetchError({ message: error.message, ...domainDetails(error) })
      )
    );
    if (registry.borrowedRepositories?.length)
      return yield* new RepoFetchError({
        message:
          "Borrowed clone fetch is unsupported. No selected repository was fetched or mutated.",
      });
    // Refuse an unsupported target before any repository's refspec or refs change.
    for (const repo of registry.repos) {
      yield* validateWindowsManagedGitDir(repo.managedRepoPath).pipe(
        Effect.mapError(
          (error) => new RepoFetchError({ message: error.message, ...domainDetails(error) })
        )
      );
      yield* validateWindowsLocalTransport(repo.remoteUrl, repo.sourceRepoPath).pipe(
        Effect.mapError(
          (error) => new RepoFetchError({ message: error.message, ...domainDetails(error) })
        )
      );
    }
    yield* mutation
      .record({
        action: "fetch-repositories",
        repositories: registry.repos.map((repo) => ({
          id: repo.id,
          managedRepoPath: repo.managedRepoPath,
        })),
      })
      .pipe(
        Effect.mapError(
          (error) => new RepoFetchError({ message: error.message, ...domainDetails(error) })
        )
      );
    const processedRepos = yield* Effect.forEach(registry.repos, (repo) =>
      fetchOneRepo(repo, config.reposRoot)
    );
    const nextRegistry = buildUpdatedRegistry(registry, processedRepos);

    yield* writeRepoRegistry(outpostHome, nextRegistry).pipe(
      Effect.mapError(
        (error) => new RepoFetchError({ message: error.message, ...domainDetails(error) })
      )
    );

    const results = processedRepos.map((processedRepo) => processedRepo.result);
    const fetchedCount = results.filter((result) => result.fetchStatus === "fetched").length;
    const failedCount = results.length - fetchedCount;

    return {
      command: "repo fetch",
      data: {
        failedCount,
        fetchedCount,
        repoCount: results.length,
        results,
      },
      exitCode: failedCount > 0 ? 1 : 0,
    } satisfies CommandOutput<"repo fetch">;
  }).pipe(Effect.scoped);
}
