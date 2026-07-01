import * as FileSystem from "@effect/platform/FileSystem";
import * as Path from "@effect/platform/Path";
import { Effect } from "effect";

import {
  buildInitialConfig,
  emptyRepoRegistry,
  getRepoHealthDiagnostics,
  getConfigFilePath,
  getRepoRegistryFilePath,
  loadConfig,
  loadRepoRegistry,
  resolveOutpostHome,
} from "../config.js";
import type { CommandOutput } from "../types.js";

function formatErrorStatus(diagnostics: ReadonlyArray<string>): string {
  const summaries = diagnostics.map(
    (diagnostic) => diagnostic.split(/\r?\n/)[0] ?? diagnostic,
  );
  return `error: ${summaries.join("; ")}`;
}

export function runDoctor(): Effect.Effect<
  CommandOutput,
  never,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const outpostHome = yield* resolveOutpostHome();
    const configFilePath = yield* getConfigFilePath(outpostHome);
    const repoRegistryFilePath = yield* getRepoRegistryFilePath(outpostHome);
    const initialized = yield* fs
      .exists(configFilePath)
      .pipe(Effect.orElseSucceed(() => false));

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
          diagnostics: [],
          status: "not-initialized",
        },
      } satisfies CommandOutput;
    }

    const diagnostics: Array<string> = [];
    const configResult = yield* loadConfig(outpostHome).pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          buildInitialConfig(outpostHome).pipe(
            Effect.map((config) => ({
              config,
              diagnostic: error.message,
            })),
          ),
        onSuccess: (config) =>
          Effect.succeed({
            config,
            diagnostic: undefined,
          }),
      }),
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
      }),
    );

    if (repoRegistryResult.diagnostic !== undefined) {
      diagnostics.push(repoRegistryResult.diagnostic);
    }

    const { missingRepoCount, missingRepos } = yield* getRepoHealthDiagnostics(
      repoRegistryResult.repoRegistry.repos,
    );
    const status =
      diagnostics.length > 0
        ? formatErrorStatus(diagnostics)
        : missingRepoCount > 0
          ? "degraded"
          : "ok";

    return {
      command: "doctor",
      data: {
        configFilePath,
        cwd: process.cwd(),
        diagnostics,
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
    } satisfies CommandOutput;
  });
}
