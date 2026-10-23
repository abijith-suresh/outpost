import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import {
  buildInitialConfig,
  emptyRepoRegistry,
  getConfigFilePath,
  getRepoHealthDiagnostics,
  getRepoRegistryFilePath,
  loadConfig,
  loadRepoRegistry,
  resolveOutpostHome,
} from "../config.js";
import { inspectMutationState } from "../mutation-lock.js";
import type { CommandOutput } from "../types.js";
import { deriveWorkspaceStatus, listManifestTickets } from "../workspace-manifest.js";

function formatErrorStatus(diagnostics: ReadonlyArray<string>): string {
  const summaries = diagnostics.map((diagnostic) => diagnostic.split(/\r?\n/)[0] ?? diagnostic);
  return `error: ${summaries.join("; ")}`;
}

export function runDoctor(): Effect.Effect<
  CommandOutput<"doctor">,
  never,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const outpostHome = yield* resolveOutpostHome();
    const configFilePath = yield* getConfigFilePath(outpostHome);
    const repoRegistryFilePath = yield* getRepoRegistryFilePath(outpostHome);
    const initialized = yield* fs.exists(configFilePath).pipe(Effect.orElseSucceed(() => false));

    const operationRecords = yield* inspectMutationState(outpostHome);
    if (!initialized) {
      return {
        command: "doctor",
        data: {
          cwd: process.cwd(),
          initialized: false,
          missingRepoCount: 0,
          missingRepos: [],
          node: process.version,
          outpostHome,
          platform: process.platform,
          diagnostics:
            operationRecords.length > 0
              ? [
                  "Incomplete operations or held locks require inspection before retrying initialization.",
                ]
              : [],
          ...(operationRecords.length > 0 ? { operationRecords } : {}),
          status: "not-initialized",
        },
      } satisfies CommandOutput<"doctor">;
    }

    const diagnostics: Array<string> = [];
    const configResult = yield* loadConfig(outpostHome).pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          buildInitialConfig(outpostHome).pipe(
            Effect.map((config) => ({
              config,
              diagnostic: error.message,
            }))
          ),
        onSuccess: (config) =>
          Effect.succeed({
            config,
            diagnostic: undefined,
          }),
      })
    );

    if (configResult.diagnostic !== undefined) {
      diagnostics.push(configResult.diagnostic);
    }

    const repoRegistryResult = yield* loadRepoRegistry(outpostHome).pipe(
      Effect.match({
        onFailure: (error) => ({
          repoRegistry: emptyRepoRegistry,
          diagnostic: error.message,
        }),
        onSuccess: (repoRegistry) => ({
          repoRegistry,
          diagnostic: undefined,
        }),
      })
    );

    if (repoRegistryResult.diagnostic !== undefined) {
      diagnostics.push(repoRegistryResult.diagnostic);
    }

    const { missingRepoCount, missingRepos } = yield* getRepoHealthDiagnostics(
      repoRegistryResult.repoRegistry.repos
    );
    const ticketResult = yield* listManifestTickets(outpostHome).pipe(Effect.result);
    if (ticketResult._tag === "Failure")
      diagnostics.push(`Could not inspect workspace manifests: ${ticketResult.failure.message}`);
    const tickets = ticketResult._tag === "Success" ? ticketResult.success : [];
    const workspaceHealth = yield* Effect.forEach(tickets, (ticket) =>
      deriveWorkspaceStatus(outpostHome, configResult.config, ticket).pipe(
        Effect.orElseSucceed(() => "invalid" as const),
        Effect.map((status) => ({ ticket, status }))
      )
    );
    const unhealthyWorkspaces = workspaceHealth.filter((workspace) => workspace.status !== "ready");
    const status =
      diagnostics.length > 0
        ? formatErrorStatus(diagnostics)
        : missingRepoCount > 0 || unhealthyWorkspaces.length > 0 || operationRecords.length > 0
          ? "degraded"
          : "ok";

    if (operationRecords.length > 0)
      diagnostics.push(
        "Incomplete operations or held locks require inspection. Metadata records intent only; verify the owner process, Git worktrees, branches, and files before manual recovery. No locks or artifacts were removed."
      );

    return {
      command: "doctor",
      data: {
        configFilePath,
        cwd: process.cwd(),
        diagnostics,
        operationRecords,
        workspaceHealth,
        unhealthyWorkspaceCount: unhealthyWorkspaces.length,
        initialized: true,
        missingRepoCount,
        missingRepos,
        node: process.version,
        outpostHome,
        platform: process.platform,
        repoCount: repoRegistryResult.repoRegistry.repos.length,
        repoRegistryFilePath,
        reposRoot: configResult.config.reposRoot,
        status,
        worktreesRoot: configResult.config.worktreesRoot,
      },
    } satisfies CommandOutput<"doctor">;
  });
}
