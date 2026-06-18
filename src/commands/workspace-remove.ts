import * as Command from "@effect/platform/Command";
import type * as CommandExecutor from "@effect/platform/CommandExecutor";
import * as FileSystem from "@effect/platform/FileSystem";
import * as Path from "@effect/platform/Path";
import { Console, Effect, Schema } from "effect";

import { loadConfig, loadRepoRegistry, resolveOutpostHome } from "../config.js";
import {
  getCanonicalPortablePathKey,
  resolvePathWithinRoot,
  validatePathSegment,
} from "../path-safety.js";
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

function resolveManagedRepoPath(
  worktreePath: string,
): Effect.Effect<
  string,
  WorkspaceRemoveError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const gitFilePath = path.join(worktreePath, ".git");
    const gitFile = yield* fs.readFileString(gitFilePath).pipe(
      Effect.mapError(
        (error) =>
          new WorkspaceRemoveError({
            message: `Failed to read worktree metadata ${gitFilePath}: ${error.message}`,
          }),
      ),
    );
    const match = /^gitdir:\s*(.+)\s*$/m.exec(gitFile);

    if (!match?.[1]) {
      return yield* Effect.fail(
        new WorkspaceRemoveError({
          message: `Invalid worktree metadata ${gitFilePath}`,
        }),
      );
    }

    const gitDirectory = path.resolve(worktreePath, match[1]);
    const worktreesDirectory = path.dirname(gitDirectory);

    if (path.basename(worktreesDirectory) !== "worktrees") {
      return yield* Effect.fail(
        new WorkspaceRemoveError({
          message: `Invalid worktree git directory ${gitDirectory}`,
        }),
      );
    }

    return path.dirname(worktreesDirectory);
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
    const path = yield* Path.Path;
    const outpostHome = yield* resolveOutpostHome();
    const config = yield* loadConfig(outpostHome).pipe(
      Effect.mapError(
        (error) => new WorkspaceRemoveError({ message: error.message }),
      ),
    );
    const ticketDirectory = yield* resolvePathWithinRoot(
      config.worktreesRoot,
      ticket,
    ).pipe(
      Effect.mapError(
        (error) => new WorkspaceRemoveError({ message: error.message }),
      ),
    );
    const exists = yield* fs
      .exists(ticketDirectory)
      .pipe(
        Effect.mapError(
          (error) => new WorkspaceRemoveError({ message: error.message }),
        ),
      );

    if (!exists) {
      return yield* Effect.fail(
        new WorkspaceRemoveError({
          message: `Unknown workspace ticket: ${ticket}`,
        }),
      );
    }

    const entries = yield* fs
      .readDirectory(ticketDirectory)
      .pipe(
        Effect.mapError(
          (error) => new WorkspaceRemoveError({ message: error.message }),
        ),
      );
    const worktreeNames = [...entries].sort((left, right) =>
      left.localeCompare(right),
    );

    const registry = yield* loadRepoRegistry(outpostHome).pipe(
      Effect.mapError(
        (error) => new WorkspaceRemoveError({ message: error.message }),
      ),
    );
    const registryReposWithPathKeys = yield* Effect.forEach(
      registry.repos,
      (repo) =>
        getCanonicalPortablePathKey(repo.managedRepoPath).pipe(
          Effect.map((managedRepoPathKey) => ({
            managedRepoPathKey,
            repo,
          })),
        ),
    );

    for (const entry of entries) {
      const worktreePath = path.join(ticketDirectory, entry);
      const managedRepoPath = yield* resolveManagedRepoPath(worktreePath).pipe(
        Effect.catchAll(() => Effect.succeed(undefined)),
      );
      if (!managedRepoPath) continue;

      const managedRepoPathKey =
        yield* getCanonicalPortablePathKey(managedRepoPath);
      const repo = registryReposWithPathKeys.find(
        (candidate) => candidate.managedRepoPathKey === managedRepoPathKey,
      )?.repo;
      if (!repo) continue;

      yield* Command.exitCode(
        gitCommand(
          "--git-dir",
          repo.managedRepoPath,
          "worktree",
          "remove",
          "--force",
          worktreePath,
        ),
      ).pipe(
        Effect.catchAll(() => Effect.succeed(1)),
        Effect.flatMap((exitCode) =>
          exitCode === 0
            ? Effect.void
            : Console.log(
                `Warning: failed to prune worktree ${worktreePath} from ${repo.managedRepoPath}`,
              ),
        ),
      );
    }

    yield* fs
      .remove(ticketDirectory, { recursive: true })
      .pipe(
        Effect.mapError(
          (error) => new WorkspaceRemoveError({ message: error.message }),
        ),
      );

    return {
      command: "workspace remove",
      data: {
        ticket,
        ticketDirectory,
        worktreeCount: worktreeNames.length,
        worktreeNames,
      },
    } satisfies CommandOutput;
  });
}
