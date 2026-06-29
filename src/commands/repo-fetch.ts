import type * as CommandExecutor from "@effect/platform/CommandExecutor";
import * as FileSystem from "@effect/platform/FileSystem";
import * as Path from "@effect/platform/Path";
import { Effect, Schema } from "effect";

import {
  loadConfig,
  loadRepoRegistry,
  resolveOutpostHome,
  writeRepoRegistry,
} from "../config.js";
import type { RepoRecord, RepoRegistry } from "../config.js";
import type { CommandOutput } from "../types.js";
import {
  fetchBareRepository,
  type RepoMirrorDiagnostic,
} from "./repo-mirror.js";

export class RepoFetchError extends Schema.TaggedError<RepoFetchError>()(
  "RepoFetchError",
  {
    message: Schema.String,
  },
) {}

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
};

function usageError(): RepoFetchError {
  return new RepoFetchError({
    message: "Usage: outpost repo fetch --all [--json]",
  });
}

function buildSuccessResult(
  repo: RepoRecord,
  lastFetchedAt: string,
): RepoFetchResult {
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
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
  };
}

type RepoProcessResult = {
  registryRepo: RepoRecord;
  result: RepoFetchResult;
};

function fetchOneRepo(
  repo: RepoRecord,
): Effect.Effect<RepoProcessResult, never, CommandExecutor.CommandExecutor> {
  return fetchBareRepository(repo.managedRepoPath).pipe(
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
    Effect.catchAll((error) =>
      Effect.succeed({
        registryRepo: repo,
        result: buildFailureResult(repo, error.message, error.diagnostics),
      } satisfies RepoProcessResult),
    ),
  );
}

function buildUpdatedRegistry(
  registry: RepoRegistry,
  processedRepos: ReadonlyArray<RepoProcessResult>,
): RepoRegistry {
  return {
    ...registry,
    repos: processedRepos.map((processedRepo) => processedRepo.registryRepo),
  };
}

export function runRepoFetch(
  args: ReadonlyArray<string>,
): Effect.Effect<
  CommandOutput,
  RepoFetchError,
  FileSystem.FileSystem | Path.Path | CommandExecutor.CommandExecutor
> {
  return Effect.gen(function* () {
    if (args.length !== 1 || args[0] !== "--all") {
      return yield* Effect.fail(usageError());
    }

    const outpostHome = yield* resolveOutpostHome();

    yield* loadConfig(outpostHome).pipe(
      Effect.mapError(
        (error) => new RepoFetchError({ message: error.message }),
      ),
    );

    const registry = yield* loadRepoRegistry(outpostHome).pipe(
      Effect.mapError(
        (error) => new RepoFetchError({ message: error.message }),
      ),
    );
    const processedRepos = yield* Effect.forEach(registry.repos, fetchOneRepo);
    const nextRegistry = buildUpdatedRegistry(registry, processedRepos);

    yield* writeRepoRegistry(outpostHome, nextRegistry).pipe(
      Effect.mapError(
        (error) => new RepoFetchError({ message: error.message }),
      ),
    );

    const results = processedRepos.map((processedRepo) => processedRepo.result);
    const fetchedCount = results.filter(
      (result) => result.fetchStatus === "fetched",
    ).length;
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
    } satisfies CommandOutput;
  });
}
