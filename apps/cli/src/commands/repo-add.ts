import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as ChildProcess from "effect/process/ChildProcess";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import { commandExitCode, commandString, gitCommand } from "../child-process.js";
import { loadConfig, loadRepoRegistry, resolveOutpostHome, writeRepoRegistry } from "../config.js";
import { domainDetails, ErrorDetailFields, reasonDetails } from "../error-details.js";
import {
  markManagedRepository,
  validateManagedRepoPath,
  verifyManagedRepository,
} from "../managed-repo.js";
import { acquireHomeMutationLock } from "../mutation-lock.js";
import { validateSemanticIdentifier } from "../path-safety.js";
import { getManagedRepoPath, resolveRemoteIdentity } from "../remote-identity.js";
import { DiagnosticTruncationSchema } from "../result-schemas.js";
import type { CommandOutput } from "../types.js";
import {
  cloneBareRepository,
  fetchBareRepository,
  RepoMirrorDiagnosticSchema,
  updateBareRepositoryRemote,
} from "./repo-mirror.js";

export class RepoAddError extends Schema.TaggedError<RepoAddError>()("RepoAddError", {
  ...ErrorDetailFields,
  message: Schema.String,
  diagnostics: Schema.optional(Schema.Array(RepoMirrorDiagnosticSchema)),
  diagnosticTruncation: Schema.optional(DiagnosticTruncationSchema),
}) {}

type RepoImportResult = {
  action: "cloned" | "fetched";
  registryAction: "created" | "updated";
  remoteName: string;
  remoteUrl: string;
  sourceRepoPath: string;
  repoName: string;
  repoPath: string;
  outpostHome: string;
  reposRoot: string;
  worktreesRoot: string;
  ready: boolean;
  blockers: ReadonlyArray<string>;
};

type RepoAddOptions = {
  remoteName?: string;
};

function checkGitRepository(
  repoPath: string
): Effect.Effect<boolean, PlatformError, ChildProcessSpawner.ChildProcessSpawner> {
  return commandExitCode(
    gitCommand("rev-parse", "--is-inside-work-tree").pipe(ChildProcess.setCwd(repoPath))
  ).pipe(Effect.map((exitCode) => exitCode === 0));
}

function getRemoteNames(
  repoPath: string
): Effect.Effect<ReadonlyArray<string>, PlatformError, ChildProcessSpawner.ChildProcessSpawner> {
  return commandString(gitCommand("remote").pipe(ChildProcess.setCwd(repoPath))).pipe(
    Effect.map((output) =>
      output
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
    )
  );
}

function getRemoteUrl(
  repoPath: string,
  remoteName: string
): Effect.Effect<string, PlatformError, ChildProcessSpawner.ChildProcessSpawner> {
  return commandString(
    gitCommand("remote", "get-url", remoteName).pipe(ChildProcess.setCwd(repoPath))
  ).pipe(Effect.map((output) => output.trim()));
}

function selectRemoteName(
  remoteNames: ReadonlyArray<string>,
  requestedRemoteName: string | undefined
): Effect.Effect<string, RepoAddError> {
  if (requestedRemoteName) {
    if (!remoteNames.includes(requestedRemoteName)) {
      return Effect.fail(
        new RepoAddError({
          ...reasonDetails("invalid-arguments"),
          message: `Unknown remote: ${requestedRemoteName}. Available remotes: ${remoteNames.join(", ")}.`,
        })
      );
    }

    return Effect.succeed(requestedRemoteName);
  }

  if (remoteNames.length > 1) {
    return Effect.fail(
      new RepoAddError({
        message: `Repository has multiple remotes (${remoteNames.join(", ")}). Use --remote <name> to choose which remote to import.`,
      })
    );
  }

  return Effect.succeed(remoteNames[0] as string);
}

export function runRepoAdd(
  inputPath: string | undefined,
  options: RepoAddOptions = {}
): Effect.Effect<
  CommandOutput<"repo add">,
  RepoAddError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  return Effect.gen(function* () {
    if (!inputPath) {
      return yield* Effect.fail(
        new RepoAddError({
          ...reasonDetails("invalid-arguments"),
          message: "Usage: outpost repo add <path> [--remote <name>]",
        })
      );
    }

    if (options.remoteName !== undefined) {
      yield* validateSemanticIdentifier("--remote", options.remoteName).pipe(
        Effect.mapError(
          (error) => new RepoAddError({ message: error.message, ...domainDetails(error) })
        )
      );
    }

    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const outpostHome = yield* resolveOutpostHome();
    const config = yield* loadConfig(outpostHome).pipe(
      Effect.mapError(
        (error) => new RepoAddError({ message: error.message, ...domainDetails(error) })
      )
    );
    const mutation = yield* acquireHomeMutationLock(outpostHome, "repo add").pipe(
      Effect.mapError(
        (error) => new RepoAddError({ message: error.message, ...domainDetails(error) })
      )
    );
    const sourceRepoPath = path.resolve(inputPath);
    const exists = yield* fs
      .exists(sourceRepoPath)
      .pipe(
        Effect.mapError(
          (error) => new RepoAddError({ message: error.message, ...domainDetails(error) })
        )
      );

    if (!exists) {
      return yield* Effect.fail(
        new RepoAddError({
          message: `Repository path does not exist: ${sourceRepoPath}`,
        })
      );
    }

    const isGitRepository = yield* checkGitRepository(sourceRepoPath).pipe(
      Effect.mapError(
        (error) => new RepoAddError({ message: error.message, ...domainDetails(error) })
      )
    );

    if (!isGitRepository) {
      return yield* Effect.fail(new RepoAddError({ message: "Path is not a Git working tree." }));
    }

    const remoteNames = yield* getRemoteNames(sourceRepoPath).pipe(
      Effect.mapError(
        (error) => new RepoAddError({ message: error.message, ...domainDetails(error) })
      )
    );

    if (remoteNames.length === 0) {
      return yield* Effect.fail(
        new RepoAddError({
          message: "Repository has no remotes to import from.",
        })
      );
    }

    const remoteName = yield* selectRemoteName(remoteNames, options.remoteName);
    yield* validateSemanticIdentifier("remote name", remoteName).pipe(
      Effect.mapError(
        (error) => new RepoAddError({ message: error.message, ...domainDetails(error) })
      )
    );
    const remoteUrl = yield* getRemoteUrl(sourceRepoPath, remoteName).pipe(
      Effect.mapError(
        (error) => new RepoAddError({ message: error.message, ...domainDetails(error) })
      )
    );
    const identity = yield* resolveRemoteIdentity(remoteUrl, sourceRepoPath).pipe(
      Effect.mapError(
        (error) => new RepoAddError({ message: error.message, ...domainDetails(error) })
      )
    );
    yield* validateSemanticIdentifier("repository id", identity.id).pipe(
      Effect.mapError(
        (error) => new RepoAddError({ message: error.message, ...domainDetails(error) })
      )
    );
    yield* validateSemanticIdentifier("repository name", identity.name).pipe(
      Effect.mapError(
        (error) => new RepoAddError({ message: error.message, ...domainDetails(error) })
      )
    );
    const derivedManagedRepoPath = yield* getManagedRepoPath(config.reposRoot, identity).pipe(
      Effect.mapError(
        (error) => new RepoAddError({ message: error.message, ...domainDetails(error) })
      )
    );
    const registry = yield* loadRepoRegistry(outpostHome).pipe(
      Effect.mapError(
        (error) => new RepoAddError({ message: error.message, ...domainDetails(error) })
      )
    );
    const existingRecord = registry.repos.find((repo) => repo.id === identity.id);
    const managedRepoPath = existingRecord?.managedRepoPath ?? derivedManagedRepoPath;
    yield* validateManagedRepoPath(
      config.reposRoot,
      existingRecord ?? {
        id: identity.id,
        name: identity.name,
        remoteUrl: identity.transportUrl,
        managedRepoPath,
        remoteName,
        sourceRepoPath,
        importedAt: "",
        lastFetchedAt: "",
      }
    ).pipe(
      Effect.mapError(
        (error) => new RepoAddError({ message: error.message, ...domainDetails(error) })
      )
    );
    const managedRepoExists = yield* fs
      .exists(managedRepoPath)
      .pipe(
        Effect.mapError(
          (error) => new RepoAddError({ message: error.message, ...domainDetails(error) })
        )
      );

    yield* mutation
      .record({
        action: "import-repository",
        repoId: identity.id,
        managedRepoPath,
        sourceRepoPath,
        remoteUrl: identity.transportUrl,
        existing: managedRepoExists,
      })
      .pipe(
        Effect.mapError(
          (error) => new RepoAddError({ message: error.message, ...domainDetails(error) })
        )
      );
    if (managedRepoExists) {
      if (!existingRecord) {
        return yield* Effect.fail(
          new RepoAddError({
            message: `Refusing unregistered repository directory at ${managedRepoPath}. Inspect it before retrying.`,
          })
        );
      }
      yield* verifyManagedRepository(config.reposRoot, existingRecord).pipe(
        Effect.mapError(
          (error) => new RepoAddError({ message: error.message, ...domainDetails(error) })
        )
      );
      yield* updateBareRepositoryRemote(managedRepoPath, identity.transportUrl).pipe(
        Effect.mapError(
          (error) =>
            new RepoAddError({
              message: error.message,
              ...domainDetails(error),
              ...(error.diagnosticTruncation
                ? { diagnosticTruncation: error.diagnosticTruncation }
                : {}),
              ...(error.diagnostics.length > 0 ? { diagnostics: error.diagnostics } : {}),
            })
        )
      );
      yield* fetchBareRepository(managedRepoPath).pipe(
        Effect.mapError(
          (error) =>
            new RepoAddError({
              message: error.message,
              ...domainDetails(error),
              ...(error.diagnosticTruncation
                ? { diagnosticTruncation: error.diagnosticTruncation }
                : {}),
              ...(error.diagnostics.length > 0 ? { diagnostics: error.diagnostics } : {}),
            })
        )
      );
    } else {
      yield* fs
        .makeDirectory(path.dirname(managedRepoPath), {
          recursive: true,
        })
        .pipe(
          Effect.mapError(
            (error) => new RepoAddError({ message: error.message, ...domainDetails(error) })
          )
        );
      yield* cloneBareRepository(identity.transportUrl, managedRepoPath).pipe(
        Effect.mapError(
          (error) =>
            new RepoAddError({
              message: error.message,
              ...domainDetails(error),
              ...(error.diagnosticTruncation
                ? { diagnosticTruncation: error.diagnosticTruncation }
                : {}),
              ...(error.diagnostics.length > 0 ? { diagnostics: error.diagnostics } : {}),
            })
        )
      );
    }

    yield* markManagedRepository(managedRepoPath, identity.id).pipe(
      Effect.mapError(
        (error) => new RepoAddError({ message: error.message, ...domainDetails(error) })
      )
    );
    const now = new Date().toISOString();
    const updatedRecord = {
      id: identity.id,
      importedAt: existingRecord?.importedAt ?? now,
      lastFetchedAt: now,
      managedRepoPath,
      name: identity.name,
      remoteName,
      remoteUrl: identity.transportUrl,
      sourceRepoPath,
    };
    const nextRegistry = {
      ...registry,
      repos: existingRecord
        ? registry.repos.map((repo) => (repo.id === identity.id ? updatedRecord : repo))
        : [...registry.repos, updatedRecord],
    };

    yield* writeRepoRegistry(outpostHome, nextRegistry).pipe(
      Effect.mapError(
        (error) => new RepoAddError({ message: error.message, ...domainDetails(error) })
      )
    );

    const data: RepoImportResult = {
      action: managedRepoExists ? "fetched" : "cloned",
      registryAction: existingRecord ? "updated" : "created",
      remoteName,
      remoteUrl: identity.transportUrl,
      sourceRepoPath,
      repoName: identity.name,
      repoPath: managedRepoPath,
      outpostHome: config.outpostHome,
      reposRoot: config.reposRoot,
      worktreesRoot: config.worktreesRoot,
      ready: true,
      blockers: [],
    };

    return {
      command: "repo add",
      data,
    } satisfies CommandOutput<"repo add">;
  }).pipe(Effect.scoped);
}
