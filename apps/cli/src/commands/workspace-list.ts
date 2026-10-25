import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { knownWorktreesRoots, loadConfig, resolveOutpostHome } from "../config.js";
import { domainDetails, ErrorDetailFields } from "../error-details.js";
import type { CommandOutput } from "../types.js";
import {
  buildManifestReadSnapshot,
  deriveManifestStatus,
  readManifest,
  resolveManifestWorkspacePath,
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
    ...ErrorDetailFields,
    message: Schema.String,
  }
) {}

export function runWorkspaceList(): Effect.Effect<
  CommandOutput<"workspace list">,
  WorkspaceListError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const outpostHome = yield* resolveOutpostHome();
    const config = yield* loadConfig(outpostHome).pipe(
      Effect.mapError(
        (error) => new WorkspaceListError({ message: error.message, ...domainDetails(error) })
      )
    );

    const snapshot = yield* buildManifestReadSnapshot(outpostHome, config).pipe(
      Effect.mapError(
        (error) => new WorkspaceListError({ message: error.message, ...domainDetails(error) })
      )
    );

    const managedTickets = snapshot.tickets;
    const managedResults: Array<WorkspaceSummary> = [];
    for (const ticket of managedTickets) {
      const manifestResult = yield* readManifest(outpostHome, ticket, snapshot).pipe(Effect.result);

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
      const status = yield* deriveManifestStatus(config, manifest).pipe(
        Effect.catch(() => Effect.succeed("invalid" as WorkspaceStatus))
      );

      let ticketDirectory: string | undefined;
      const workspacePathResult = yield* resolveManifestWorkspacePath(config, manifest).pipe(
        Effect.result
      );
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

    const managedPathSet = new Set(managedResults.map((result) => result.ticketDirectory));
    const invalidTickets = new Set(
      managedResults.filter((result) => result.status === "invalid").map((result) => result.ticket)
    );
    const unmanagedResults: Array<WorkspaceSummary> = [];
    for (const root of knownWorktreesRoots(config)) {
      const unmanagedDirs = yield* scanWorktreesRoot(root, outpostHome, {
        includeRegisteredDirectories: true,
      }).pipe(
        Effect.mapError(
          (error) => new WorkspaceListError({ message: error.message, ...domainDetails(error) })
        )
      );
      for (const dir of unmanagedDirs) {
        const ticketDirectory = path.join(root, dir);
        // Invalid or colliding manifests remain explicit blockers. Do not
        // downgrade them to unmanaged merely because their path is unresolved.
        if (managedPathSet.has(ticketDirectory) || invalidTickets.has(dir)) continue;
        unmanagedResults.push({
          ticket: dir,
          ticketDirectory,
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
    }

    const allWorkspaces = [...managedResults, ...unmanagedResults].sort((left, right) =>
      left.ticket.localeCompare(right.ticket)
    );

    return {
      command: "workspace list",
      data: {
        workspaces: allWorkspaces,
      },
    } satisfies CommandOutput<"workspace list">;
  });
}
