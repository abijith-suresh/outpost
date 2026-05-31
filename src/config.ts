import * as FileSystem from "@effect/platform/FileSystem";
import type { PlatformError } from "@effect/platform/Error";
import * as Path from "@effect/platform/Path";
import { Effect, Schema } from "effect";

export const OUTPOST_HOME_ENV = "OUTPOST_HOME";

export class ConfigError extends Schema.TaggedError<ConfigError>()(
  "ConfigError",
  {
    message: Schema.String,
  },
) {}

export const OutpostConfigSchema = Schema.Struct({
  version: Schema.Literal(1),
  outpostHome: Schema.String,
  reposRoot: Schema.String,
  worktreesRoot: Schema.String,
});

export type OutpostConfig = Schema.Schema.Type<typeof OutpostConfigSchema>;

export function getDefaultOutpostHome(): Effect.Effect<
  string,
  never,
  Path.Path
> {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const homeDirectory =
      process.env.HOME ?? process.env.USERPROFILE ?? process.cwd();

    return path.resolve(homeDirectory, ".outpost");
  });
}

export function resolveOutpostHome(): Effect.Effect<string, never, Path.Path> {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const configuredHome = process.env[OUTPOST_HOME_ENV];

    if (configuredHome) {
      return path.resolve(configuredHome);
    }

    return yield* getDefaultOutpostHome();
  });
}

export function getConfigFilePath(
  outpostHome: string,
): Effect.Effect<string, never, Path.Path> {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    return path.join(outpostHome, "config.json");
  });
}

export function buildInitialConfig(
  outpostHome: string,
): Effect.Effect<OutpostConfig, never, Path.Path> {
  return Effect.gen(function* () {
    const path = yield* Path.Path;

    return {
      version: 1,
      outpostHome,
      reposRoot: path.join(outpostHome, "repos"),
      worktreesRoot: path.join(outpostHome, "worktrees"),
    };
  });
}

export function loadConfig(
  outpostHome: string,
): Effect.Effect<
  OutpostConfig,
  ConfigError | PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const configFilePath = yield* getConfigFilePath(outpostHome);
    const exists = yield* fs.exists(configFilePath);

    if (!exists) {
      return yield* new ConfigError({
        message: `Outpost is not initialized at ${outpostHome}`,
      });
    }

    const contents = yield* fs.readFileString(configFilePath).pipe(
      Effect.mapError(
        (error) =>
          new ConfigError({
            message: `Failed to read config file ${configFilePath}: ${error.message}`,
          }),
      ),
    );

    const parsedJson = yield* Effect.try({
      try: () => JSON.parse(contents) as unknown,
      catch: (error) =>
        new ConfigError({
          message: `Invalid JSON in config file ${configFilePath}: ${String(error)}`,
        }),
    });

    return yield* Schema.decodeUnknown(OutpostConfigSchema)(parsedJson).pipe(
      Effect.mapError(
        (error) =>
          new ConfigError({
            message: `Invalid config file ${configFilePath}: ${error.message}`,
          }),
      ),
    );
  });
}
