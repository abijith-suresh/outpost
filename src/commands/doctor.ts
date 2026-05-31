import * as FileSystem from "@effect/platform/FileSystem";
import * as Path from "@effect/platform/Path";
import { Effect } from "effect";

import {
  buildInitialConfig,
  emptyRepoRegistry,
  getConfigFilePath,
  getRepoRegistryFilePath,
  loadConfig,
  loadRepoRegistry,
  resolveOutpostHome,
} from "../config.js";
import type { CommandOutput } from "../types.js";

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
          status: "not-initialized",
        },
      } satisfies CommandOutput;
    }

    const config = yield* loadConfig(outpostHome).pipe(
      Effect.catchAll(() => buildInitialConfig(outpostHome)),
    );
    const repoRegistry = yield* loadRepoRegistry(outpostHome).pipe(
      Effect.catchAll(() => Effect.succeed(emptyRepoRegistry)),
    );
    const missingRepos = yield* Effect.forEach(repoRegistry.repos, (repo) =>
      fs.exists(repo.managedRepoPath).pipe(
        Effect.orElseSucceed(() => false),
        Effect.map((exists) => (exists ? null : repo.managedRepoPath)),
      ),
    ).pipe(
      Effect.map((paths) =>
        [
          ...new Set(paths.filter((path): path is string => path !== null)),
        ].sort(),
      ),
    );
    const missingRepoCount = missingRepos.length;

    return {
      command: "doctor",
      data: {
        configFilePath,
        cwd: process.cwd(),
        initialized: true,
        missingRepoCount,
        missingRepos,
        node: process.version,
        outpostHome,
        platform: process.platform,
        repoCount: repoRegistry.repos.length,
        repoRegistryFilePath,
        reposRoot: config.reposRoot,
        status: missingRepoCount > 0 ? "degraded" : "ok",
        worktreesRoot: config.worktreesRoot,
      },
    } satisfies CommandOutput;
  });
}
