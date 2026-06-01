import * as FileSystem from "@effect/platform/FileSystem";
import * as Path from "@effect/platform/Path";
import { Effect, Schema } from "effect";

import { loadConfig, resolveOutpostHome } from "../config.js";
import type { CommandOutput } from "../types.js";

export class WorkspaceListError extends Schema.TaggedError<WorkspaceListError>()(
  "WorkspaceListError",
  {
    message: Schema.String,
  },
) {}

export function runWorkspaceList(): Effect.Effect<
  CommandOutput,
  WorkspaceListError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const outpostHome = yield* resolveOutpostHome();
    const config = yield* loadConfig(outpostHome).pipe(
      Effect.mapError(
        (error) => new WorkspaceListError({ message: error.message }),
      ),
    );
    const entries = yield* fs
      .readDirectory(config.worktreesRoot)
      .pipe(
        Effect.mapError(
          (error) => new WorkspaceListError({ message: error.message }),
        ),
      );
    const workspaces = yield* Effect.forEach(entries, (entry) => {
      const ticketDirectory = path.join(config.worktreesRoot, entry);

      return fs.stat(ticketDirectory).pipe(
        Effect.mapError(
          (error) => new WorkspaceListError({ message: error.message }),
        ),
        Effect.flatMap((info) => {
          if (info.type !== "Directory") {
            return Effect.succeed(undefined);
          }

          return fs.readDirectory(ticketDirectory).pipe(
            Effect.mapError(
              (error) => new WorkspaceListError({ message: error.message }),
            ),
            Effect.map((worktreeEntries) => ({
              ticket: entry,
              ticketDirectory,
              worktreeCount: worktreeEntries.length,
            })),
          );
        }),
      );
    }).pipe(
      Effect.map((items) =>
        items
          .filter((item) => item !== undefined)
          .sort((left, right) => left.ticket.localeCompare(right.ticket)),
      ),
    );

    return {
      command: "workspace list",
      data: {
        workspaces,
      },
    } satisfies CommandOutput;
  });
}
