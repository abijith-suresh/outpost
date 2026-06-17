import * as FileSystem from "@effect/platform/FileSystem";
import type { PlatformError } from "@effect/platform/Error";
import * as Path from "@effect/platform/Path";
import { Effect, Schema } from "effect";

export const OUTPOST_HOME_ENV = "OUTPOST_HOME";
export const CURRENT_CONFIG_VERSION = 1;

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

export function migrateConfig(
  raw: unknown,
): Effect.Effect<unknown, ConfigError> {
  return Effect.gen(function* () {
    if (typeof raw !== "object" || raw === null) {
      return raw;
    }
    const obj = raw as Record<string, unknown>;
    const version =
      typeof obj.version === "number" ? obj.version : CURRENT_CONFIG_VERSION;

    if (version > CURRENT_CONFIG_VERSION) {
      return yield* Effect.fail(
        new ConfigError({
          message: `Config version ${version} is newer than the supported version ${CURRENT_CONFIG_VERSION}. Please upgrade outpost.`,
        }),
      );
    }

    return { ...obj, version: CURRENT_CONFIG_VERSION };
  });
}

export const RepoRecordSchema = Schema.Struct({
  id: Schema.String,
  importedAt: Schema.String,
  lastFetchedAt: Schema.String,
  managedRepoPath: Schema.String,
  name: Schema.String,
  remoteName: Schema.String,
  remoteUrl: Schema.String,
  sourceRepoPath: Schema.String,
});

export type RepoRecord = Schema.Schema.Type<typeof RepoRecordSchema>;

export type RepoHealthStatus = "ok" | "missing";

export type RepoRecordWithStatus = RepoRecord & {
  status: RepoHealthStatus;
};

export const RepoRegistrySchema = Schema.Struct({
  repos: Schema.Array(RepoRecordSchema),
  version: Schema.Literal(1),
});

export type RepoRegistry = Schema.Schema.Type<typeof RepoRegistrySchema>;

export function getRepoHealthDiagnostics(
  repos: ReadonlyArray<RepoRecord>,
): Effect.Effect<
  {
    missingRepoCount: number;
    missingRepos: Array<string>;
    repos: Array<RepoRecordWithStatus>;
  },
  never,
  FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const reposWithStatus = yield* Effect.forEach(repos, (repo) =>
      fs.exists(repo.managedRepoPath).pipe(
        Effect.orElseSucceed(() => false),
        Effect.map(
          (exists) =>
            ({
              ...repo,
              status: exists ? "ok" : "missing",
            }) satisfies RepoRecordWithStatus,
        ),
      ),
    );
    const missingRepos = [
      ...new Set(
        reposWithStatus
          .filter((repo) => repo.status === "missing")
          .map((repo) => repo.managedRepoPath),
      ),
    ].sort();

    return {
      missingRepoCount: missingRepos.length,
      missingRepos,
      repos: reposWithStatus,
    };
  });
}

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

export function getRepoRegistryFilePath(
  outpostHome: string,
): Effect.Effect<string, never, Path.Path> {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    return path.join(outpostHome, "repos.json");
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

export const emptyRepoRegistry: RepoRegistry = {
  repos: [],
  version: 1,
};

export function loadRepoRegistry(
  outpostHome: string,
): Effect.Effect<
  RepoRegistry,
  ConfigError | PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const registryFilePath = yield* getRepoRegistryFilePath(outpostHome);
    const exists = yield* fs.exists(registryFilePath);

    if (!exists) {
      return yield* new ConfigError({
        message: `Repo registry does not exist at ${registryFilePath}`,
      });
    }

    const contents = yield* fs.readFileString(registryFilePath).pipe(
      Effect.mapError(
        (error) =>
          new ConfigError({
            message: `Failed to read repo registry ${registryFilePath}: ${error.message}`,
          }),
      ),
    );

    const parsedJson = yield* Effect.try({
      try: () => JSON.parse(contents) as unknown,
      catch: (error) =>
        new ConfigError({
          message: `Invalid JSON in repo registry ${registryFilePath}: ${String(error)}`,
        }),
    });

    return yield* Schema.decodeUnknown(RepoRegistrySchema)(parsedJson).pipe(
      Effect.mapError(
        (error) =>
          new ConfigError({
            message: `Invalid repo registry ${registryFilePath}: ${error.message}`,
          }),
      ),
    );
  });
}

export function writeRepoRegistry(
  outpostHome: string,
  registry: RepoRegistry,
): Effect.Effect<
  void,
  ConfigError | PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const registryFilePath = yield* getRepoRegistryFilePath(outpostHome);

    yield* fs
      .writeFileString(
        registryFilePath,
        `${JSON.stringify(registry, null, 2)}\n`,
      )
      .pipe(
        Effect.mapError(
          (error) =>
            new ConfigError({
              message: `Failed to write repo registry ${registryFilePath}: ${error.message}`,
            }),
        ),
      );
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

    const migrated = yield* migrateConfig(parsedJson).pipe(
      Effect.mapError(
        (error) =>
          new ConfigError({
            message: `Invalid config file ${configFilePath}: ${error.message}`,
          }),
      ),
    );

    return yield* Schema.decodeUnknown(OutpostConfigSchema)(migrated).pipe(
      Effect.mapError(
        (error) =>
          new ConfigError({
            message: `Invalid config file ${configFilePath}: ${error.message}`,
          }),
      ),
    );
  });
}
