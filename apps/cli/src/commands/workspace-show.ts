import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { knownWorktreesRoots, loadConfig, resolveOutpostHome } from "../config.js";
import { domainDetails, ErrorDetailFields, reasonDetails } from "../error-details.js";
import {
  resolvePathWithinRoot,
  validatePathSegment,
  validateSemanticIdentifier,
} from "../path-safety.js";
import type { ResultData } from "../result-schemas.js";
import type { CommandOutput } from "../types.js";
import {
  deriveWorkspaceStatus,
  getManifestFilePath,
  readManifest,
  resolveManifestWorkspacePath,
  resolveRepositoryStoragePath,
  resolveWorktreePath,
  type WorkspaceStatus,
} from "../workspace-manifest.js";

export class WorkspaceShowError extends Schema.TaggedError<WorkspaceShowError>()(
  "WorkspaceShowError",
  {
    ...ErrorDetailFields,
    message: Schema.String,
  }
) {}

export function runWorkspaceShow(
  ticket: string | undefined,
  extraArgs: ReadonlyArray<string>
): Effect.Effect<
  CommandOutput<"workspace show">,
  WorkspaceShowError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  return Effect.gen(function* () {
    if (!ticket || extraArgs.length > 0) {
      return yield* Effect.fail(
        new WorkspaceShowError({
          ...reasonDetails("invalid-arguments"),
          message: "Usage: outpost workspace show <ticket> [--json]",
        })
      );
    }

    yield* validateSemanticIdentifier("--ticket", ticket).pipe(
      Effect.mapError(
        (error) => new WorkspaceShowError({ message: error.message, ...domainDetails(error) })
      )
    );
    yield* validatePathSegment("--ticket", ticket).pipe(
      Effect.mapError(
        (error) => new WorkspaceShowError({ message: error.message, ...domainDetails(error) })
      )
    );

    const fs = yield* FileSystem.FileSystem;
    const outpostHome = yield* resolveOutpostHome();
    const config = yield* loadConfig(outpostHome).pipe(
      Effect.mapError(
        (error) => new WorkspaceShowError({ message: error.message, ...domainDetails(error) })
      )
    );

    const manifestFilePath = yield* getManifestFilePath(outpostHome, ticket);
    const manifestResult = yield* readManifest(outpostHome, ticket).pipe(Effect.result);

    if (Result.isSuccess(manifestResult)) {
      const manifest = manifestResult.success;
      const status = yield* deriveWorkspaceStatus(outpostHome, config, ticket).pipe(
        Effect.catch(() => Effect.succeed("invalid" as WorkspaceStatus))
      );

      let ticketDirectory: string | undefined;
      const workspacePathResult = yield* resolveManifestWorkspacePath(config, manifest).pipe(
        Effect.result
      );
      if (Result.isSuccess(workspacePathResult)) {
        ticketDirectory = workspacePathResult.success;
      }

      const worktrees: Array<ResultData["workspace show"]["worktrees"][number]> = [];
      for (const repo of manifest.repositories) {
        const managedPathResult = yield* resolveRepositoryStoragePath(config.reposRoot, repo).pipe(
          Effect.result
        );
        const resolvedManagedPath = Result.isSuccess(managedPathResult)
          ? managedPathResult.success
          : undefined;

        let resolvedWorktreePath: string | undefined;
        if (ticketDirectory) {
          const wtResult = yield* resolveWorktreePath(ticketDirectory, repo.worktreePath).pipe(
            Effect.result
          );
          if (Result.isSuccess(wtResult)) {
            resolvedWorktreePath = wtResult.success;
          }
        }

        const worktreeEntry: {
          -readonly [K in keyof ResultData["workspace show"]["worktrees"][number]]: ResultData["workspace show"]["worktrees"][number][K];
        } = {
          id: repo.id,
          name: repo.name,
          base: repo.base,
          ...(repo.baseSource === undefined
            ? {}
            : {
                baseSource: repo.baseSource,
                requestedBase: repo.requestedBase,
                baseRef: repo.baseRef,
                ...(repo.baseRemote
                  ? { baseRemote: repo.baseRemote, remoteRef: repo.remoteRef }
                  : {}),
                baseCommit: repo.baseCommit,
                ...(repo.branchDisposition === undefined
                  ? {}
                  : { branchDisposition: repo.branchDisposition }),
              }),
          managedPath: repo.managedPath,
          storage: repo.storage,
          resolvedManagedPath,
          worktreePath: repo.worktreePath,
          resolvedWorktreePath,
        };

        if (resolvedWorktreePath) {
          const worktreeExists = yield* fs
            .exists(resolvedWorktreePath)
            .pipe(Effect.catch(() => Effect.succeed(false)));
          worktreeEntry.worktreeExists = worktreeExists;
        }

        if (resolvedManagedPath) {
          const managedExists = yield* fs
            .exists(resolvedManagedPath)
            .pipe(Effect.catch(() => Effect.succeed(false)));
          worktreeEntry.managedExists = managedExists;
        }

        worktrees.push(worktreeEntry);
      }

      return {
        command: "workspace show",
        data: {
          ticket: manifest.ticket,
          ticketDirectory,
          type: manifest.type,
          branch: manifest.branch,
          createdAt: manifest.createdAt,
          workspacePath: manifest.workspacePath,
          status,
          manifestPath: manifestFilePath,
          worktrees,
        },
      } satisfies CommandOutput<"workspace show">;
    }

    const manifestError = manifestResult.failure;
    const isNotFound = manifestError._tag === "ManifestNotFoundError";

    if (!isNotFound) {
      return {
        command: "workspace show",
        data: {
          ticket,
          status: "invalid",
          manifestPath: manifestFilePath,
          diagnostics: [manifestError.message],
          worktrees: [],
        },
      } satisfies CommandOutput<"workspace show">;
    }

    for (const root of knownWorktreesRoots(config)) {
      const ticketDirResult = yield* resolvePathWithinRoot(root, ticket).pipe(Effect.result);

      if (Result.isSuccess(ticketDirResult)) {
        const ticketDir = ticketDirResult.success;
        const exists = yield* fs.exists(ticketDir).pipe(Effect.catch(() => Effect.succeed(false)));

        if (exists) {
          return {
            command: "workspace show",
            data: {
              ticket,
              ticketDirectory: ticketDir,
              status: "unmanaged",
              diagnostics: [
                "No workspace manifest exists; directory contents are not treated as managed worktrees.",
              ],
              worktrees: [],
            },
          } satisfies CommandOutput<"workspace show">;
        }
      }
    }

    return yield* Effect.fail(
      new WorkspaceShowError({
        ...reasonDetails("workspace-missing"),
        message: `Unknown workspace ticket: ${ticket}`,
      })
    );
  });
}
