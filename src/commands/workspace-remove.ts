import { rmdir } from "node:fs/promises";

import * as Command from "@effect/platform/Command";
import type * as CommandExecutor from "@effect/platform/CommandExecutor";
import * as FileSystem from "@effect/platform/FileSystem";
import * as Path from "@effect/platform/Path";
import { Effect, Either, Schema, Stream } from "effect";

import { loadConfig, resolveOutpostHome } from "../config.js";
import { resolvePathWithinRoot, validatePathSegment } from "../path-safety.js";
import {
  classifyAgentsOwnership,
  deleteAgentsIfExists,
  getAgentsBodyHash,
  renderAgentsMarkdown,
  validateAgentsFingerprint,
} from "../workspace-agents.js";
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

export async function promptAgentsRemovalConsent(
  ticket: string,
  agentsFilePath: string,
  ownership: "modified" | "foreign",
): Promise<boolean> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  const message =
    ownership === "modified"
      ? `Workspace AGENTS.md has been modified. Delete it and continue removing workspace ${ticket}? [y/N] `
      : `Workspace AGENTS.md is not managed by outpost. Delete it and continue removing workspace ${ticket}? [y/N] `;

  return new Promise<boolean>((resolve) => {
    let handled = false;

    rl.on("SIGINT", () => {
      handled = true;
      rl.close();
      resolve(false);
    });

    rl.question(message)
      .then((answer: string) => {
        if (handled) return;
        handled = true;
        rl.close();
        const trimmed = answer.trim().toLowerCase();
        resolve(trimmed === "y" || trimmed === "yes");
      })
      .catch(() => {
        if (handled) return;
        handled = true;
        rl.close();
        resolve(false);
      });
  });
}

function partialRemovalOutput(
  ticket: string,
  workspaceDir: string,
  worktreeNames: ReadonlyArray<string>,
  completed: ReadonlyArray<string>,
  remaining: ReadonlyArray<string>,
  diagnostics: ReadonlyArray<string>,
): CommandOutput {
  return {
    command: "workspace remove",
    data: {
      ticket,
      ticketDirectory: workspaceDir,
      worktreeCount: worktreeNames.length,
      worktreeNames,
      completed,
      remaining,
      diagnostics,
      status: "partial",
    },
    exitCode: 1,
  };
}

export function runWorkspaceRemove(
  ticket: string | undefined,
  extraArgs: ReadonlyArray<string>,
  options: { interactive: boolean },
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

            // --- AGENTS.md classification ---
            const agentsFilePath = yield* resolvePathWithinRoot(
              workspaceDir,
              "AGENTS.md",
            ).pipe(Effect.mapError(toMapError));

            const renderedContent = yield* renderAgentsMarkdown(
              manifest,
              config,
            ).pipe(Effect.mapError(toMapError));
            const expectedBodyHash = getAgentsBodyHash(renderedContent);

            const ownership = yield* classifyAgentsOwnership(
              agentsFilePath,
              expectedBodyHash,
            ).pipe(Effect.mapError(toMapError));

            if (ownership === "foreign" || ownership === "modified") {
              if (options.interactive) {
                const consent = yield* Effect.tryPromise({
                  try: () =>
                    promptAgentsRemovalConsent(
                      ticket as string,
                      agentsFilePath,
                      ownership,
                    ),
                  catch: (error) =>
                    new WorkspaceRemoveError({
                      message: `Consent prompt failed: ${String(error)}`,
                    }),
                });

                if (!consent) {
                  return yield* Effect.fail(
                    new WorkspaceRemoveError({
                      message: `AGENTS.md at ${agentsFilePath} has been ${ownership === "modified" ? "modified" : "replaced"} and removal was declined. Delete AGENTS.md manually or approve its removal.`,
                    }),
                  );
                }
                // proceed
              } else {
                return yield* Effect.fail(
                  new WorkspaceRemoveError({
                    message:
                      ownership === "modified"
                        ? `AGENTS.md at ${agentsFilePath} has been modified since generation. Delete it manually and rerun, or retry in interactive mode.`
                        : `AGENTS.md at ${agentsFilePath} is not managed by outpost. Delete it manually and rerun, or retry in interactive mode.`,
                  }),
                );
              }
            }

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
                continue;
              }

              const managedRepoExists = yield* fs
                .exists(resolvedManagedPath)
                .pipe(Effect.mapError(toMapError));

              if (!managedRepoExists) {
                return yield* Effect.fail(
                  new WorkspaceRemoveError({
                    message: `Cannot establish cleanliness for worktree ${resolvedWorktreePath}: managed repository ${resolvedManagedPath} is missing. Refusing removal.`,
                  }),
                );
              }

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

              const statusCommand = gitCommand(
                "-C",
                resolvedWorktreePath,
                "status",
                "--porcelain",
              );
              const statusResult = yield* Effect.scoped(
                Effect.gen(function* () {
                  const process = yield* Command.start(statusCommand);
                  const output = yield* process.stdout.pipe(
                    Stream.decodeText(),
                    Stream.runFold("", (all, chunk) => all + chunk),
                  );
                  const exitCode = yield* process.exitCode;
                  return { exitCode, output };
                }),
              ).pipe(Effect.mapError(toMapError));

              if (statusResult.exitCode !== 0) {
                return yield* Effect.fail(
                  new WorkspaceRemoveError({
                    message: `Failed to establish cleanliness for worktree ${resolvedWorktreePath}: git status exited with status ${statusResult.exitCode}. Refusing removal.`,
                  }),
                );
              }

              if (statusResult.output.trim().length > 0) {
                return yield* Effect.fail(
                  new WorkspaceRemoveError({
                    message: `Worktree ${resolvedWorktreePath} has uncommitted changes. Refusing removal. Commit or discard changes first.`,
                  }),
                );
              }
            }

            const completed: Array<string> = [];
            const remaining: Array<string> = [];
            const diagnostics: Array<string> = [];
            const worktreeNames = manifest.repositories.map(
              (repo) => repo.worktreePath,
            );

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

              const removalResult = yield* Command.exitCode(
                gitCommand(
                  "--git-dir",
                  resolvedManagedPath,
                  "worktree",
                  "remove",
                  resolvedWorktreePath,
                ),
              ).pipe(Effect.either);

              if (Either.isRight(removalResult) && removalResult.right === 0) {
                completed.push(repo.worktreePath);
                continue;
              }

              remaining.push(repo.worktreePath);
              diagnostics.push(
                Either.isLeft(removalResult)
                  ? `Failed to remove worktree ${resolvedWorktreePath}: ${removalResult.left.message}`
                  : `Failed to remove worktree ${resolvedWorktreePath}: git exited with status ${removalResult.right}`,
              );
            }

            if (remaining.length > 0) {
              return partialRemovalOutput(
                ticket,
                workspaceDir,
                worktreeNames,
                completed,
                remaining,
                diagnostics,
              );
            }

            // --- Revalidate AGENTS.md fingerprint before deletion ---
            const fingerprintChanged = yield* validateAgentsFingerprint(
              agentsFilePath,
              expectedBodyHash,
            ).pipe(Effect.mapError(toMapError));

            if (!fingerprintChanged) {
              return yield* Effect.fail(
                new WorkspaceRemoveError({
                  message: `AGENTS.md at ${agentsFilePath} was modified concurrently during removal. Preserving file; manifest retained for retry.`,
                }),
              );
            }

            yield* deleteAgentsIfExists(workspaceDir).pipe(
              Effect.mapError(toMapError),
            );

            const dirExists = yield* fs
              .exists(workspaceDir)
              .pipe(Effect.mapError(toMapError));

            if (dirExists) {
              const directoryResult = yield* fs
                .readDirectory(workspaceDir)
                .pipe(Effect.either);

              if (Either.isLeft(directoryResult)) {
                return partialRemovalOutput(
                  ticket,
                  workspaceDir,
                  worktreeNames,
                  completed,
                  [],
                  [
                    `Failed to inspect workspace directory ${workspaceDir}: ${directoryResult.left.message}`,
                  ],
                );
              }

              const remainingEntries = directoryResult.right;
              if (remainingEntries.length > 0) {
                return partialRemovalOutput(
                  ticket,
                  workspaceDir,
                  worktreeNames,
                  completed,
                  remainingEntries,
                  [
                    `Workspace directory ${workspaceDir} contains unrecognized or residual entries: ${remainingEntries.join(", ")}`,
                  ],
                );
              }

              const removeDirectoryResult = yield* Effect.tryPromise({
                try: () => rmdir(workspaceDir),
                catch: (error) =>
                  new WorkspaceRemoveError({
                    message:
                      error instanceof Error ? error.message : String(error),
                  }),
              }).pipe(Effect.either);

              if (Either.isLeft(removeDirectoryResult)) {
                return partialRemovalOutput(
                  ticket,
                  workspaceDir,
                  worktreeNames,
                  completed,
                  [],
                  [
                    `Failed to remove empty workspace directory ${workspaceDir}: ${removeDirectoryResult.left.message}`,
                  ],
                );
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
                worktreeNames,
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
