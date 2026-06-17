import * as FileSystem from "@effect/platform/FileSystem";
import * as Path from "@effect/platform/Path";
import { Effect, Schema } from "effect";

import { loadConfig, resolveOutpostHome } from "../config.js";
import type { CommandOutput } from "../types.js";

export class WorkspaceShowError extends Schema.TaggedError<WorkspaceShowError>()(
  "WorkspaceShowError",
  {
    message: Schema.String,
  },
) {}

function validateTicket(
  ticket: string,
): Effect.Effect<void, WorkspaceShowError> {
  if (ticket.includes("/") || ticket.includes("\\")) {
    return Effect.fail(
      new WorkspaceShowError({
        message: "--ticket may not contain path separators.",
      }),
    );
  }

  if (ticket === "." || ticket === "..") {
    return Effect.fail(
      new WorkspaceShowError({
        message: "--ticket may not contain path traversal.",
      }),
    );
  }

  return Effect.void;
}

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

    yield* validateTicket(ticket);

    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const outpostHome = yield* resolveOutpostHome();
    const config = yield* loadConfig(outpostHome).pipe(
      Effect.mapError(
        (error) => new WorkspaceShowError({ message: error.message }),
      ),
    );
    const ticketDirectory = path.join(config.worktreesRoot, ticket);
    const exists = yield* fs
      .exists(ticketDirectory)
      .pipe(
        Effect.mapError(
          (error) => new WorkspaceShowError({ message: error.message }),
        ),
      );

    if (!exists) {
      return yield* Effect.fail(
        new WorkspaceShowError({
          message: `Unknown workspace ticket: ${ticket}`,
        }),
      );
    }

    const entries = yield* fs
      .readDirectory(ticketDirectory)
      .pipe(
        Effect.mapError(
          (error) => new WorkspaceShowError({ message: error.message }),
        ),
      );
    const worktrees = yield* Effect.forEach(entries, (entry) => {
      const worktreePath = path.join(ticketDirectory, entry);

      return fs.stat(worktreePath).pipe(
        Effect.mapError(
          (error) => new WorkspaceShowError({ message: error.message }),
        ),
        Effect.map((info) =>
          info.type === "Directory"
            ? {
                path: worktreePath,
                repoName: entry,
              }
            : undefined,
        ),
      );
    }).pipe(
      Effect.map((items) =>
        items
          .filter((item) => item !== undefined)
          .sort((left, right) => left.repoName.localeCompare(right.repoName)),
      ),
    );

    return {
      command: "workspace show",
      data: {
        ticket,
        ticketDirectory,
        worktrees,
      },
    } satisfies CommandOutput;
  });
}
