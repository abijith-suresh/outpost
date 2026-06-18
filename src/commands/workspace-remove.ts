import * as Command from "@effect/platform/Command";
import type * as CommandExecutor from "@effect/platform/CommandExecutor";
import * as FileSystem from "@effect/platform/FileSystem";
import * as Path from "@effect/platform/Path";
import { Effect, Either, Schema } from "effect";

import { loadConfig, resolveOutpostHome } from "../config.js";
import { resolvePathWithinRoot, validatePathSegment } from "../path-safety.js";
import {
  acquireTicketLock,
  deleteManifest,
  manifestExists,
  readManifest,
  releaseTicketLock,
  resolveManagedPath,
  resolveWorkspacePath,
  resolveWorktreePath,
  verifyWorktreeOwnership,
} from "../workspace-manifest.js";
import type { CommandOutput } from "../types.js";

export class WorkspaceRemoveError extends Schema.TaggedError<WorkspaceRemoveError>()(
  "WorkspaceRemoveError",
  {
    message: Schema.String,
  },
) {}

function gitCommand(...args: ReadonlyArray<string>) {
  return Command.make("git", ...args).pipe(
    Command.env({
      GCM_INTERACTIVE: "never",
      GIT_TERMINAL_PROMPT: "0",
    }),
  );
}

function toMapError(error: unknown): WorkspaceRemoveError {
  return new WorkspaceRemoveError({
    message: error instanceof Error ? error.message : "Unknown workspace error",
  });
}

export function runWorkspaceRemove(
  ticket: string | undefined,
  extraArgs: ReadonlyArray<string>,
): Effect.Effect<
  CommandOutput,
  WorkspaceRemoveError,
  FileSystem.FileSystem | Path.Path | CommandExecutor.CommandExecutor
> {
  return Effect.gen(function* () {
    if (!ticket || extraArgs.length > 0) {
      return yield* Effect.fail(
        new WorkspaceRemoveError({
          message: "Usage: outpost workspace remove <ticket> [--json]",
        }),
      );
    }

    yield* validatePathSegment("--ticket", ticket).pipe(
      Effect.mapError(
        (error) => new WorkspaceRemoveError({ message: error.message }),
      ),
    );

    const fs = yield* FileSystem.FileSystem;
    const outpostHome = yield* resolveOutpostHome();
    const config = yield* loadConfig(outpostHome).pipe(
      Effect.mapError(
        (error) => new WorkspaceRemoveError({ message: error.message }),
      ),
    );

    const hasManifest = yield* manifestExists(outpostHome, ticket).pipe(
      Effect.mapError(
        (error) => new WorkspaceRemoveError({ message: error.message }),
      ),
    );

    if (!hasManifest) {
      const ticketDirResult = yield* resolvePathWithinRoot(
        config.worktreesRoot,
        ticket,
      ).pipe(Effect.either);

      if (Either.isRight(ticketDirResult)) {
        const ticketDir = ticketDirResult.right;
        const dirExists = yield* fs
          .exists(ticketDir)
          .pipe(
            Effect.mapError(
              (error) => new WorkspaceRemoveError({ message: error.message }),
            ),
          );

        if (dirExists) {
          return yield* Effect.fail(
            new WorkspaceRemoveError({
              message: `No manifest found for ticket ${ticket}. The workspace directory exists at ${ticketDir} but is unmanaged. Managed removal requires a manifest.`,
            }),
          );
        }
      }

      return yield* Effect.fail(
        new WorkspaceRemoveError({
          message: `Unknown workspace ticket: ${ticket}`,
        }),
      );
    }

    const result = yield* Effect.scoped(
      Effect.acquireRelease(
        acquireTicketLock(outpostHome, ticket).pipe(
          Effect.mapError(toMapError),
        ),
        () =>
          releaseTicketLock(outpostHome, ticket).pipe(
            Effect.catchAll(() => Effect.void),
          ),
      ).pipe(
        Effect.flatMap(() =>
          Effect.gen(function* () {
            const manifest = yield* readManifest(outpostHome, ticket).pipe(
              Effect.mapError(toMapError),
            );

            const workspaceDir = yield* resolveWorkspacePath(
              config.worktreesRoot,
              manifest.workspacePath,
            ).pipe(Effect.mapError(toMapError));

            for (const repo of manifest.repositories) {
              const resolvedWorktreePath = yield* resolveWorktreePath(
                workspaceDir,
                repo.worktreePath,
              ).pipe(Effect.mapError(toMapError));

              const worktreeExists = yield* fs
                .exists(resolvedWorktreePath)
                .pipe(Effect.mapError(toMapError));

              if (!worktreeExists) {
                continue;
              }

              const resolvedManagedPath = yield* resolveManagedPath(
                config.reposRoot,
                repo.managedPath,
              ).pipe(Effect.mapError(toMapError));

              const ownershipValid = yield* verifyWorktreeOwnership(
                resolvedWorktreePath,
                resolvedManagedPath,
              ).pipe(Effect.mapError(toMapError));

              if (!ownershipValid) {
                return yield* Effect.fail(
                  new WorkspaceRemoveError({
                    message: `Worktree ${resolvedWorktreePath} ownership mismatch: its .git does not point to the expected managed repository. Refusing removal to protect data.`,
                  }),
                );
              }

              const porcelainOutput = yield* Command.string(
                gitCommand("-C", resolvedWorktreePath, "status", "--porcelain"),
              ).pipe(Effect.catchAll(() => Effect.succeed("")));

              if (porcelainOutput.trim().length > 0) {
                return yield* Effect.fail(
                  new WorkspaceRemoveError({
                    message: `Worktree ${resolvedWorktreePath} has uncommitted changes. Refusing removal. Commit or discard changes first.`,
                  }),
                );
              }
            }

            const completed: Array<string> = [];
            const remaining: Array<string> = [];

            for (const repo of manifest.repositories) {
              const resolvedManagedPath = yield* resolveManagedPath(
                config.reposRoot,
                repo.managedPath,
              ).pipe(Effect.mapError(toMapError));

              const resolvedWorktreePath = yield* resolveWorktreePath(
                workspaceDir,
                repo.worktreePath,
              ).pipe(Effect.mapError(toMapError));

              const worktreeExists = yield* fs
                .exists(resolvedWorktreePath)
                .pipe(Effect.mapError(toMapError));

              if (!worktreeExists) {
                completed.push(repo.worktreePath);
                continue;
              }

              const exitCode = yield* Command.exitCode(
                gitCommand(
                  "--git-dir",
                  resolvedManagedPath,
                  "worktree",
                  "remove",
                  resolvedWorktreePath,
                ),
              ).pipe(Effect.catchAll(() => Effect.succeed(1)));

              if (exitCode === 0) {
                completed.push(repo.worktreePath);
                continue;
              }

              const managedRepoExists = yield* fs
                .exists(resolvedManagedPath)
                .pipe(Effect.mapError(toMapError));

              if (!managedRepoExists) {
                yield* fs
                  .remove(resolvedWorktreePath, { recursive: true })
                  .pipe(Effect.mapError(toMapError));
                completed.push(repo.worktreePath);
              } else {
                remaining.push(repo.worktreePath);
              }
            }

            if (remaining.length > 0) {
              return {
                command: "workspace remove",
                data: {
                  ticket,
                  ticketDirectory: workspaceDir,
                  worktreeCount: manifest.repositories.length,
                  worktreeNames: manifest.repositories.map(
                    (repo) => repo.worktreePath,
                  ),
                  completed,
                  remaining,
                  status: "partial",
                },
              } satisfies CommandOutput;
            }

            const dirExists = yield* fs
              .exists(workspaceDir)
              .pipe(Effect.mapError(toMapError));

            if (dirExists) {
              const remainingEntries = yield* fs
                .readDirectory(workspaceDir)
                .pipe(
                  Effect.catchAll(() => Effect.succeed([] as Array<string>)),
                );

              if (remainingEntries.length === 0) {
                yield* fs
                  .remove(workspaceDir, { recursive: true })
                  .pipe(Effect.mapError(toMapError));
              }
            }

            yield* deleteManifest(outpostHome, ticket).pipe(
              Effect.mapError(toMapError),
            );

            return {
              command: "workspace remove",
              data: {
                ticket,
                ticketDirectory: workspaceDir,
                worktreeCount: manifest.repositories.length,
                worktreeNames: manifest.repositories.map(
                  (repo) => repo.worktreePath,
                ),
                completed,
                remaining: [],
                status: "success",
              },
            } satisfies CommandOutput;
          }),
        ),
      ),
    );

    return result;
  });
}
