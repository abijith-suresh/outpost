import * as FileSystem from "@effect/platform/FileSystem";
import type { PlatformError } from "@effect/platform/Error";
import * as Path from "@effect/platform/Path";
import { Effect, Schema } from "effect";

import {
  buildInitialConfig,
  emptyRepoRegistry,
  getConfigFilePath,
  getRepoRegistryFilePath,
  resolveOutpostHome,
} from "../config.js";
import { writeJsonFileAtomic } from "../store.js";
import type { CommandOutput } from "../types.js";

export class InitError extends Schema.TaggedError<InitError>()("InitError", {
  message: Schema.String,
}) {}

export function runInit(): Effect.Effect<
  CommandOutput,
  InitError | PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const outpostHome = yield* resolveOutpostHome();
    const configFilePath = yield* getConfigFilePath(outpostHome);
    const repoRegistryFilePath = yield* getRepoRegistryFilePath(outpostHome);
    const configExists = yield* fs.exists(configFilePath);

    if (configExists) {
      return yield* new InitError({
        message: `Outpost is already initialized at ${outpostHome}`,
      });
    }

    const config = yield* buildInitialConfig(outpostHome);

    yield* fs.makeDirectory(outpostHome, { recursive: true }).pipe(
      Effect.mapError(
        (error) =>
          new InitError({
            message: `Failed to create Outpost home ${outpostHome}: ${error.message}`,
          }),
      ),
    );

    yield* fs.makeDirectory(config.worktreesRoot, { recursive: true }).pipe(
      Effect.mapError(
        (error) =>
          new InitError({
            message: `Failed to create worktrees root ${config.worktreesRoot}: ${error.message}`,
          }),
      ),
    );

    yield* fs.makeDirectory(config.reposRoot, { recursive: true }).pipe(
      Effect.mapError(
        (error) =>
          new InitError({
            message: `Failed to create repos root ${config.reposRoot}: ${error.message}`,
          }),
      ),
    );

    yield* writeJsonFileAtomic(configFilePath, config).pipe(
      Effect.mapError(
        (error) =>
          new InitError({
            message: `Failed to write config file ${configFilePath}: ${error.message}`,
          }),
      ),
    );

    yield* writeJsonFileAtomic(repoRegistryFilePath, emptyRepoRegistry).pipe(
      Effect.mapError(
        (error) =>
          new InitError({
            message: `Failed to write repo registry ${repoRegistryFilePath}: ${error.message}`,
          }),
      ),
    );

    return {
      command: "init",
      data: {
        outpostHome,
        reposRoot: config.reposRoot,
        worktreesRoot: config.worktreesRoot,
        configFilePath: path.normalize(configFilePath),
        initialized: true,
      },
    } satisfies CommandOutput;
  });
}
