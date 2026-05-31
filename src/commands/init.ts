import * as FileSystem from "@effect/platform/FileSystem";
import type { PlatformError } from "@effect/platform/Error";
import * as Path from "@effect/platform/Path";
import { Effect, Schema } from "effect";

import {
  buildInitialConfig,
  getConfigFilePath,
  resolveOutpostHome,
} from "../config.js";
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
    const configExists = yield* fs.exists(configFilePath);

    if (configExists) {
      return yield* new InitError({
        message: `Outpost is already initialized at ${outpostHome}`,
      });
    }

    const config = yield* buildInitialConfig(outpostHome);
    const configJson = JSON.stringify(config, null, 2);

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

    yield* fs.writeFileString(configFilePath, `${configJson}\n`).pipe(
      Effect.mapError(
        (error) =>
          new InitError({
            message: `Failed to write config file ${configFilePath}: ${error.message}`,
          }),
      ),
    );

    return {
      command: "init",
      data: {
        outpostHome,
        worktreesRoot: config.worktreesRoot,
        configFilePath: path.normalize(configFilePath),
        initialized: true,
      },
    } satisfies CommandOutput;
  });
}
