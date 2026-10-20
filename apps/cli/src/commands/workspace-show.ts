import { Effect, Result, Schema } from "effect";
import * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

import { loadConfig, resolveOutpostHome } from "../config.js";
import {
  resolvePathWithinRoot,
  validatePathSegment,
  validateSemanticIdentifier,
} from "../path-safety.js";
import type { CommandOutput } from "../types.js";
import {
  deriveWorkspaceStatus,
  getManifestFilePath,
  readManifest,
  resolveManagedPath,
  resolveWorkspacePath,
  resolveWorktreePath,
  type WorkspaceStatus,
} from "../workspace-manifest.js";

export class WorkspaceShowError extends Schema.TaggedError<WorkspaceShowError>()(
  "WorkspaceShowError",
  {
    message: Schema.String,
  }
) {}

export function runWorkspaceShow(
  ticket: string | undefined,
  extraArgs: ReadonlyArray<string>
): Effect.Effect<CommandOutput, WorkspaceShowError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    if (!ticket || extraArgs.length > 0) {
      return yield* Effect.fail(
        new WorkspaceShowError({
          message: "Usage: outpost workspace show <ticket> [--json]",
        })
      );
    }

    yield* validateSemanticIdentifier("--ticket", ticket).pipe(
      Effect.mapError((error) => new WorkspaceShowError({ message: error.message }))
    );
    yield* validatePathSegment("--ticket", ticket).pipe(
      Effect.mapError((error) => new WorkspaceShowError({ message: error.message }))
    );

    const fs = yield* FileSystem.FileSystem;
    const outpostHome = yield* resolveOutpostHome();
    const config = yield* loadConfig(outpostHome).pipe(
      Effect.mapError((error) => new WorkspaceShowError({ message: error.message }))
    );

    const manifestFilePath = yield* getManifestFilePath(outpostHome, ticket);
    const manifestResult = yield* readManifest(outpostHome, ticket).pipe(Effect.result);

    if (Result.isSuccess(manifestResult)) {
      const manifest = manifestResult.success;
      const status = yield* deriveWorkspaceStatus(outpostHome, config, ticket).pipe(
        Effect.catch(() => Effect.succeed("invalid" as WorkspaceStatus))
      );

      let ticketDirectory: string | undefined;
      const workspacePathResult = yield* resolveWorkspacePath(
        config.worktreesRoot,
        manifest.workspacePath
      ).pipe(Effect.result);
      if (Result.isSuccess(workspacePathResult)) {
        ticketDirectory = workspacePathResult.success;
      }

      const worktrees: Array<Record<string, unknown>> = [];
      for (const repo of manifest.repositories) {
        const managedPathResult = yield* resolveManagedPath(
          config.reposRoot,
          repo.managedPath
        ).pipe(Effect.result);
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

        const worktreeEntry: Record<string, unknown> = {
          id: repo.id,
          name: repo.name,
          base: repo.base,
          managedPath: repo.managedPath,
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
      } satisfies CommandOutput;
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
      } satisfies CommandOutput;
    }

    const ticketDirResult = yield* resolvePathWithinRoot(config.worktreesRoot, ticket).pipe(
      Effect.result
    );

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
        } satisfies CommandOutput;
      }
    }

    return yield* Effect.fail(
      new WorkspaceShowError({
        message: `Unknown workspace ticket: ${ticket}`,
      })
    );
  });
}
