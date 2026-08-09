import { Effect, Result, Schema } from "effect";
import type * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { loadConfig, resolveOutpostHome } from "../config.js";
import type { CommandOutput } from "../types.js";
import {
  deriveWorkspaceStatus,
  listManifestTickets,
  readManifest,
  resolveWorkspacePath,
  scanWorktreesRoot,
  type WorkspaceStatus,
} from "../workspace-manifest.js";

export type WorkspaceSummary = {
  ticket: string;
  ticketDirectory: string | undefined;
  type: string | undefined;
  branch: string | undefined;
  createdAt: string | undefined;
  worktreeCount: number;
  status: WorkspaceStatus;
  diagnostics: Array<string>;
};

export class WorkspaceListError extends Schema.TaggedError<WorkspaceListError>()(
  "WorkspaceListError",
  {
    message: Schema.String,
  }
) {}

export function runWorkspaceList(): Effect.Effect<
  CommandOutput,
  WorkspaceListError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const outpostHome = yield* resolveOutpostHome();
    const config = yield* loadConfig(outpostHome).pipe(
      Effect.mapError((error) => new WorkspaceListError({ message: error.message }))
    );

    const managedTickets = yield* listManifestTickets(outpostHome).pipe(
      Effect.mapError((error) => new WorkspaceListError({ message: error.message }))
    );

    const managedResults: Array<WorkspaceSummary> = [];
    for (const ticket of managedTickets) {
      const manifestResult = yield* readManifest(outpostHome, ticket).pipe(Effect.result);

      if (Result.isFailure(manifestResult)) {
        managedResults.push({
          ticket,
          ticketDirectory: undefined,
          type: undefined,
          branch: undefined,
          createdAt: undefined,
          worktreeCount: 0,
          status: "invalid",
          diagnostics: [manifestResult.failure.message],
        });
        continue;
      }

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

      managedResults.push({
        ticket,
        ticketDirectory,
        type: manifest.type,
        branch: manifest.branch,
        createdAt: manifest.createdAt,
        worktreeCount: manifest.repositories.length,
        status,
        diagnostics: [],
      });
    }

    const managedTicketSet = new Set(managedTickets);
    const unmanagedDirs = yield* scanWorktreesRoot(config.worktreesRoot, outpostHome).pipe(
      Effect.mapError((error) => new WorkspaceListError({ message: error.message }))
    );

    const unmanagedResults: Array<WorkspaceSummary> = [];
    for (const dir of unmanagedDirs) {
      if (managedTicketSet.has(dir)) continue;

      unmanagedResults.push({
        ticket: dir,
        ticketDirectory: path.join(config.worktreesRoot, dir),
        type: undefined,
        branch: undefined,
        createdAt: undefined,
        worktreeCount: 0,
        status: "unmanaged",
        diagnostics: [
          "No workspace manifest exists; directory contents are not treated as managed worktrees.",
        ],
      });
    }

    const allWorkspaces = [...managedResults, ...unmanagedResults].sort((left, right) =>
      left.ticket.localeCompare(right.ticket)
    );

    return {
      command: "workspace list",
      data: {
        workspaces: allWorkspaces,
      },
    } satisfies CommandOutput;
  });
}
