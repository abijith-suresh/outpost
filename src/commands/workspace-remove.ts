import * as Command from "@effect/platform/Command";
import type * as CommandExecutor from "@effect/platform/CommandExecutor";
import * as FileSystem from "@effect/platform/FileSystem";
import * as Path from "@effect/platform/Path";
import { Console, Effect, Schema } from "effect";

import { loadConfig, loadRepoRegistry, resolveOutpostHome } from "../config.js";
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

function validateTicket(
  ticket: string,
): Effect.Effect<void, WorkspaceRemoveError> {
  if (ticket.includes("/") || ticket.includes("\\")) {
    return Effect.fail(
      new WorkspaceRemoveError({
        message: "--ticket may not contain path separators.",
      }),
    );
  }

  if (ticket === "." || ticket === "..") {
    return Effect.fail(
      new WorkspaceRemoveError({
        message: "--ticket may not contain path traversal.",
      }),
    );
  }

  return Effect.void;
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

    yield* validateTicket(ticket);

    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const outpostHome = yield* resolveOutpostHome();
    const config = yield* loadConfig(outpostHome).pipe(
      Effect.mapError(
        (error) => new WorkspaceRemoveError({ message: error.message }),
      ),
    );
    const ticketDirectory = path.join(config.worktreesRoot, ticket);
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

    for (const entry of entries) {
      const repo = registry.repos.find((r) => r.name === entry);
      if (!repo) continue;

      const worktreePath = path.join(ticketDirectory, entry);
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
