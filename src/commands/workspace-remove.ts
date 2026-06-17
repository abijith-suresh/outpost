import * as FileSystem from "@effect/platform/FileSystem";
import * as Path from "@effect/platform/Path";
import { Effect, Schema } from "effect";

import { loadConfig, resolveOutpostHome } from "../config.js";
import type { CommandOutput } from "../types.js";

export class WorkspaceRemoveError extends Schema.TaggedError<WorkspaceRemoveError>()(
  "WorkspaceRemoveError",
  {
    message: Schema.String,
  },
) {}

export function runWorkspaceRemove(
  ticket: string | undefined,
  extraArgs: ReadonlyArray<string>,
): Effect.Effect<
  CommandOutput,
  WorkspaceRemoveError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    if (!ticket || extraArgs.length > 0) {
      return yield* Effect.fail(
        new WorkspaceRemoveError({
          message: "Usage: outpost workspace remove <ticket> [--json]",
        }),
      );
    }

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
