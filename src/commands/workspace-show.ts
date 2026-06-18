import * as FileSystem from "@effect/platform/FileSystem";
import * as Path from "@effect/platform/Path";
import { Either, Effect, Schema } from "effect";

import { loadConfig, resolveOutpostHome } from "../config.js";
import { resolvePathWithinRoot, validatePathSegment } from "../path-safety.js";
import {
  deriveWorkspaceStatus,
  getManifestFilePath,
  readManifest,
  resolveManagedPath,
  resolveWorkspacePath,
  resolveWorktreePath,
  type WorkspaceStatus,
} from "../workspace-manifest.js";
import type { CommandOutput } from "../types.js";

export class WorkspaceShowError extends Schema.TaggedError<WorkspaceShowError>()(
  "WorkspaceShowError",
  {
    message: Schema.String,
  },
) {}

export function runWorkspaceShow(
  ticket: string | undefined,
  extraArgs: ReadonlyArray<string>,
): Effect.Effect<
  CommandOutput,
  WorkspaceShowError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    if (!ticket || extraArgs.length > 0) {
      return yield* Effect.fail(
        new WorkspaceShowError({
          message: "Usage: outpost workspace show <ticket> [--json]",
        }),
      );
    }

    yield* validatePathSegment("--ticket", ticket).pipe(
      Effect.mapError(
        (error) => new WorkspaceShowError({ message: error.message }),
      ),
    );

    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const outpostHome = yield* resolveOutpostHome();
    const config = yield* loadConfig(outpostHome).pipe(
      Effect.mapError(
        (error) => new WorkspaceShowError({ message: error.message }),
      ),
    );

    const manifestFilePath = yield* getManifestFilePath(outpostHome, ticket);
    const manifestResult = yield* readManifest(outpostHome, ticket).pipe(
      Effect.either,
    );

    if (Either.isRight(manifestResult)) {
      const manifest = manifestResult.right;
      const status = yield* deriveWorkspaceStatus(
        outpostHome,
        config,
        ticket,
      ).pipe(
        Effect.catchAll(() => Effect.succeed("invalid" as WorkspaceStatus)),
      );

      let ticketDirectory: string | undefined;
      const workspacePathResult = yield* resolveWorkspacePath(
        config.worktreesRoot,
        manifest.workspacePath,
      ).pipe(Effect.either);
      if (Either.isRight(workspacePathResult)) {
        ticketDirectory = workspacePathResult.right;
      }

      const worktrees: Array<Record<string, unknown>> = [];
      for (const repo of manifest.repositories) {
        const managedPathResult = yield* resolveManagedPath(
          config.reposRoot,
          repo.managedPath,
        ).pipe(Effect.either);
        const resolvedManagedPath = Either.isRight(managedPathResult)
          ? managedPathResult.right
          : undefined;

        let resolvedWorktreePath: string | undefined;
        if (ticketDirectory) {
          const wtResult = yield* resolveWorktreePath(
            ticketDirectory,
            repo.worktreePath,
          ).pipe(Effect.either);
          if (Either.isRight(wtResult)) {
            resolvedWorktreePath = wtResult.right;
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
            .pipe(Effect.catchAll(() => Effect.succeed(false)));
          worktreeEntry.worktreeExists = worktreeExists;
        }

        if (resolvedManagedPath) {
          const managedExists = yield* fs
            .exists(resolvedManagedPath)
            .pipe(Effect.catchAll(() => Effect.succeed(false)));
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

    const manifestError = manifestResult.left;
    const isNotFound =
      manifestError instanceof Error &&
      manifestError.message?.includes("No manifest found");

    const ticketDirResult = yield* resolvePathWithinRoot(
      config.worktreesRoot,
      ticket,
    ).pipe(Effect.either);

    if (Either.isRight(ticketDirResult)) {
      const ticketDir = ticketDirResult.right;
      const exists = yield* fs
        .exists(ticketDir)
        .pipe(Effect.catchAll(() => Effect.succeed(false)));

      if (exists) {
        const entries = yield* fs
          .readDirectory(ticketDir)
          .pipe(Effect.catchAll(() => Effect.succeed([] as Array<string>)));
        const worktrees = entries
          .sort((left, right) => left.localeCompare(right))
          .map((entry) => ({
            path: path.join(ticketDir, entry),
            repoName: entry,
          }));

        return {
          command: "workspace show",
          data: {
            ticket,
            ticketDirectory: ticketDir,
            status: "unmanaged",
            worktrees,
          },
        } satisfies CommandOutput;
      }
    }

    if (!isNotFound) {
      return yield* Effect.fail(
        new WorkspaceShowError({
          message: `Manifest for ticket ${ticket} is invalid: ${manifestError.message}`,
        }),
      );
    }

    return yield* Effect.fail(
      new WorkspaceShowError({
        message: `Unknown workspace ticket: ${ticket}`,
      }),
    );
  });
}
