import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { BorrowedRecordSchema, RetainedBorrowedRecordSchema } from "./borrowed-schema.js";

import {
  getCanonicalPortablePathKey,
  getPortablePathKey,
  semanticIdentifierSchema,
} from "./path-safety.js";
import { writeJsonFileAtomic } from "./store.js";

export const OUTPOST_HOME_ENV = "OUTPOST_HOME";
export const CURRENT_CONFIG_VERSION = 3;

export class ConfigError extends Schema.TaggedError<ConfigError>()("ConfigError", {
  message: Schema.String,
}) {}

export const OutpostConfigSchema = Schema.Struct({
  version: Schema.Literals([1, 2, 3]),
  outpostHome: Schema.String,
  reposRoot: Schema.String,
  worktreesRoot: Schema.String,
  legacyWorktreesRoot: Schema.optional(Schema.String),
  trustedWorktreesRoots: Schema.optional(Schema.Array(Schema.String)),
  extraInstructions: Schema.optional(Schema.String),
});

export type OutpostConfig = Schema.Schema.Type<typeof OutpostConfigSchema>;

export function migrateConfig(raw: unknown): Effect.Effect<unknown, ConfigError> {
  return Effect.gen(function* () {
    if (typeof raw !== "object" || raw === null) {
      return raw;
    }
    const obj = raw as Record<string, unknown>;
    const version = obj.version === undefined ? 1 : obj.version;
    if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) {
      return yield* Effect.fail(new ConfigError({ message: "Invalid config version." }));
    }
    if (version > CURRENT_CONFIG_VERSION) {
      return yield* Effect.fail(
        new ConfigError({
          message: `Config version ${version} is newer than the supported version ${CURRENT_CONFIG_VERSION}. Please upgrade outpost.`,
        })
      );
    }
    return { ...obj, version };
  });
}

export const RepoRecordSchema = Schema.Struct({
  id: semanticIdentifierSchema("repository id"),
  importedAt: Schema.String,
  lastFetchedAt: Schema.String,
  managedRepoPath: Schema.String,
  name: semanticIdentifierSchema("repository name"),
  remoteName: semanticIdentifierSchema("remote name"),
  remoteUrl: Schema.String,
  sourceRepoPath: Schema.String,
  tags: Schema.optional(Schema.Array(Schema.String)),
});

export type RepoRecord = Schema.Schema.Type<typeof RepoRecordSchema>;
export const RetainedRepoRecordSchema = Schema.Struct({
  ...RepoRecordSchema.fields,
  retainedAt: Schema.String,
});
export type RetainedRepoRecord = Schema.Schema.Type<typeof RetainedRepoRecordSchema>;

export type RepoHealthStatus = "ok" | "missing";

export type RepoRecordWithStatus = RepoRecord & {
  status: RepoHealthStatus;
};

export const RepoRegistrySchema = Schema.Struct({
  version: Schema.optional(Schema.Literals([2, 3, 4])),
  repos: Schema.Array(RepoRecordSchema),
  borrowedRepositories: Schema.optional(Schema.Array(BorrowedRecordSchema)),
  retainedBorrowedRepositories: Schema.optional(Schema.Array(RetainedBorrowedRecordSchema)),
  retainedRepositories: Schema.optional(Schema.Array(RetainedRepoRecordSchema)),
});

export type RepoRegistry = Schema.Schema.Type<typeof RepoRegistrySchema>;

// Deliberately incompatible with the legacy { repos } decoder. An older process
// may have read config before waiting on the home lock, but rereads this file
// after acquiring it and must fail before changing repositories or workspaces.
const TaggedRepositorySchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("managed"), record: RepoRecordSchema }),
  Schema.Struct({ kind: Schema.Literal("borrowed"), record: BorrowedRecordSchema }),
]);
const TaggedRetainedSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("managed"), record: RetainedRepoRecordSchema }),
  Schema.Struct({ kind: Schema.Literal("borrowed"), record: RetainedBorrowedRecordSchema }),
]);
const StoredRepoRegistrySchema = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(4),
    repositories: Schema.Array(TaggedRepositorySchema),
    retainedRepositories: Schema.Array(TaggedRetainedSchema),
  }),
  Schema.Struct({ repos: Schema.Array(RepoRecordSchema) }),
  Schema.Struct({ version: Schema.Literal(2), repositories: Schema.Array(RepoRecordSchema) }),
  Schema.Struct({
    version: Schema.Literal(3),
    repositories: Schema.Array(RepoRecordSchema),
    retainedRepositories: Schema.Array(RetainedRepoRecordSchema),
  }),
]);

export function getRepoHealthDiagnostics(repos: ReadonlyArray<RepoRecord>): Effect.Effect<
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
            }) satisfies RepoRecordWithStatus
        )
      )
    );
    const missingRepos = [
      ...new Set(
        reposWithStatus
          .filter((repo) => repo.status === "missing")
          .map((repo) => repo.managedRepoPath)
      ),
    ].sort();

    return {
      missingRepoCount: missingRepos.length,
      missingRepos,
      repos: reposWithStatus,
    };
  });
}

export function getDefaultOutpostHome(): Effect.Effect<string, never, Path.Path> {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const homeDirectory = process.env.HOME ?? process.env.USERPROFILE ?? process.cwd();

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

export function getConfigFilePath(outpostHome: string): Effect.Effect<string, never, Path.Path> {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    return path.join(outpostHome, "config.json");
  });
}

export function getRepoRegistryFilePath(
  outpostHome: string
): Effect.Effect<string, never, Path.Path> {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    return path.join(outpostHome, "repos.json");
  });
}

export function buildInitialConfig(
  outpostHome: string
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
};

function validateRepoRegistryUniqueness(
  registry: RepoRegistry,
  canonicalPaths = true
): Effect.Effect<RepoRegistry, ConfigError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const ids = new Set<string>();
    const managedRepoPaths = new Set<string>();

    if (
      (registry.version === 3 || registry.version === 4) !==
      (registry.retainedRepositories !== undefined)
    )
      return yield* Effect.fail(
        new ConfigError({
          message:
            "Retained repositories require registry version 3 with a retainedRepositories array.",
        })
      );
    for (const repo of [...registry.repos, ...(registry.retainedRepositories ?? [])]) {
      if (
        repo.tags !== undefined &&
        registry.version !== 2 &&
        registry.version !== 3 &&
        registry.version !== 4
      )
        return yield* Effect.fail(
          new ConfigError({ message: "Repository tags require registry version 2." })
        );
      for (const tag of repo.tags ?? []) yield* validateTag(tag);
      if (new Set(repo.tags).size !== (repo.tags?.length ?? 0))
        return yield* Effect.fail(
          new ConfigError({ message: `Duplicate tags on repository ${repo.id}.` })
        );
      if (ids.has(repo.id)) {
        return yield* Effect.fail(
          new ConfigError({
            message: `Repo registry contains duplicate id: ${repo.id}`,
          })
        );
      }
      ids.add(repo.id);

      const managedRepoPathKey = yield* canonicalPaths
        ? getCanonicalPortablePathKey(repo.managedRepoPath)
        : getPortablePathKey(repo.managedRepoPath);
      if (managedRepoPaths.has(managedRepoPathKey)) {
        return yield* Effect.fail(
          new ConfigError({
            message: `Repo registry contains duplicate managed path: ${repo.managedRepoPath}`,
          })
        );
      }
      managedRepoPaths.add(managedRepoPathKey);
    }

    if (
      registry.version !== 4 &&
      (registry.borrowedRepositories !== undefined ||
        registry.retainedBorrowedRepositories !== undefined)
    )
      return yield* new ConfigError({ message: "Borrowed storage requires registry version 4." });
    for (const repo of [
      ...(registry.borrowedRepositories ?? []),
      ...(registry.retainedBorrowedRepositories ?? []),
    ]) {
      const key = yield* canonicalPaths
        ? getCanonicalPortablePathKey(repo.common.path)
        : getPortablePathKey(repo.common.path);
      if (ids.has(repo.id) || managedRepoPaths.has(key))
        return yield* new ConfigError({
          message: "Conflicting borrowed repository identity or common directory.",
        });
      ids.add(repo.id);
      managedRepoPaths.add(key);
    }
    return registry;
  });
}

export function loadRepoRegistry(
  outpostHome: string,
  options: { canonicalPaths?: boolean; contents?: string } = {}
): Effect.Effect<RepoRegistry, ConfigError | PlatformError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const registryFilePath = yield* getRepoRegistryFilePath(outpostHome);
    const exists = yield* fs.exists(registryFilePath);

    if (!exists) {
      return yield* new ConfigError({
        message: `Repo registry does not exist at ${registryFilePath}`,
      });
    }

    const contents =
      options.contents ??
      (yield* fs.readFileString(registryFilePath).pipe(
        Effect.mapError(
          (error) =>
            new ConfigError({
              message: `Failed to read repo registry ${registryFilePath}: ${error.message}`,
            })
        )
      ));

    const parsedJson = yield* Effect.try({
      try: () => JSON.parse(contents) as unknown,
      catch: (error) =>
        new ConfigError({
          message: `Invalid JSON in repo registry ${registryFilePath}: ${String(error)}`,
        }),
    });

    const stored = yield* Schema.decodeUnknownEffect(StoredRepoRegistrySchema)(parsedJson, {
      onExcessProperty: "error",
    }).pipe(
      Effect.mapError(
        (error) =>
          new ConfigError({
            message: `Invalid repo registry ${registryFilePath}: ${error.message}`,
          })
      )
    );

    const registry: RepoRegistry =
      "version" in stored && stored.version === 4
        ? {
            version: 4,
            repos: stored.repositories.flatMap((entry) =>
              entry.kind === "managed" ? [entry.record] : []
            ),
            borrowedRepositories: stored.repositories.flatMap((entry) =>
              entry.kind === "borrowed" ? [entry.record] : []
            ),
            retainedRepositories: stored.retainedRepositories.flatMap((entry) =>
              entry.kind === "managed" ? [entry.record] : []
            ),
            retainedBorrowedRepositories: stored.retainedRepositories.flatMap((entry) =>
              entry.kind === "borrowed" ? [entry.record] : []
            ),
          }
        : "repositories" in stored
          ? {
              version: stored.version,
              repos: stored.repositories,
              ...(stored.version === 3
                ? { retainedRepositories: stored.retainedRepositories }
                : {}),
            }
          : stored;
    return yield* validateRepoRegistryUniqueness(registry, options.canonicalPaths ?? true);
  });
}

export function writeRepoRegistry(
  outpostHome: string,
  registry: RepoRegistry
): Effect.Effect<void, ConfigError | PlatformError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const validatedRegistry = yield* Schema.decodeUnknownEffect(RepoRegistrySchema)(registry, {
      onExcessProperty: "error",
    }).pipe(
      Effect.mapError(
        (error) =>
          new ConfigError({
            message: `Invalid repo registry: ${error.message}`,
          })
      )
    );
    yield* validateRepoRegistryUniqueness(validatedRegistry);
    const registryFilePath = yield* getRepoRegistryFilePath(outpostHome);

    const stored =
      validatedRegistry.version === 4
        ? {
            version: 4,
            repositories: [
              ...validatedRegistry.repos.map((record) => ({ kind: "managed", record })),
              ...(validatedRegistry.borrowedRepositories ?? []).map((record) => ({
                kind: "borrowed",
                record,
              })),
            ],
            retainedRepositories: [
              ...(validatedRegistry.retainedRepositories ?? []).map((record) => ({
                kind: "managed",
                record,
              })),
              ...(validatedRegistry.retainedBorrowedRepositories ?? []).map((record) => ({
                kind: "borrowed",
                record,
              })),
            ],
          }
        : validatedRegistry.version === 3
          ? {
              version: 3,
              repositories: validatedRegistry.repos,
              retainedRepositories: validatedRegistry.retainedRepositories,
            }
          : validatedRegistry.version === 2
            ? { version: 2, repositories: validatedRegistry.repos }
            : { repos: validatedRegistry.repos };
    yield* writeJsonFileAtomic(registryFilePath, stored).pipe(
      Effect.mapError(
        (error) =>
          new ConfigError({
            message: `Failed to write repo registry ${registryFilePath}: ${error.message}`,
          })
      )
    );
  });
}

export function loadConfig(
  outpostHome: string,
  options: { contents?: string } = {}
): Effect.Effect<OutpostConfig, ConfigError | PlatformError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const configFilePath = yield* getConfigFilePath(outpostHome);
    const exists = yield* fs.exists(configFilePath);

    if (!exists) {
      return yield* new ConfigError({
        message: `Outpost is not initialized at ${outpostHome}`,
      });
    }

    const contents =
      options.contents ??
      (yield* fs.readFileString(configFilePath).pipe(
        Effect.mapError(
          (error) =>
            new ConfigError({
              message: `Failed to read config file ${configFilePath}: ${error.message}`,
            })
        )
      ));

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
          })
      )
    );

    const config = yield* Schema.decodeUnknownEffect(OutpostConfigSchema)(migrated, {
      onExcessProperty: "error",
    }).pipe(
      Effect.mapError(
        (error) =>
          new ConfigError({
            message: `Invalid config file ${configFilePath}: ${error.message}`,
          })
      )
    );
    yield* validateConfig(config, outpostHome);
    return config;
  });
}

/** Extended state is installed only after this single-file older-writer barrier. */
export function upgradeConfig(config: OutpostConfig): OutpostConfig {
  return config.version >= 2
    ? config
    : {
        ...config,
        version: 2,
        legacyWorktreesRoot: config.worktreesRoot,
        trustedWorktreesRoots: [config.worktreesRoot],
        extraInstructions: "",
      };
}

export function validateConfig(config: OutpostConfig, outpostHome: string) {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    for (const value of [config.outpostHome, config.reposRoot, config.worktreesRoot]) {
      if (!path.isAbsolute(value) || value.includes("\0"))
        return yield* Effect.fail(
          new ConfigError({
            message: "Config paths must be absolute paths without NUL characters.",
          })
        );
    }
    if (
      (yield* getCanonicalPortablePathKey(config.outpostHome)) !==
      (yield* getCanonicalPortablePathKey(outpostHome))
    )
      return yield* Effect.fail(
        new ConfigError({ message: "Config outpostHome does not match the selected Outpost home." })
      );
    if (
      config.version === 1 &&
      (config.legacyWorktreesRoot !== undefined ||
        config.trustedWorktreesRoots !== undefined ||
        config.extraInstructions !== undefined)
    )
      return yield* Effect.fail(
        new ConfigError({ message: "Extended configuration requires version 2." })
      );
    if (config.version >= 2) {
      const roots = config.trustedWorktreesRoots;
      if (
        !config.legacyWorktreesRoot ||
        !roots?.length ||
        config.extraInstructions === undefined ||
        !roots.includes(config.legacyWorktreesRoot) ||
        !roots.includes(config.worktreesRoot) ||
        new Set(roots).size !== roots.length ||
        roots.some((root) => !path.isAbsolute(root) || root.includes("\0"))
      )
        return yield* Effect.fail(
          new ConfigError({
            message: "Invalid trusted workspace roots in version 2 configuration.",
          })
        );
      yield* validateExtraInstructions(config.extraInstructions);
    }
  });
}

export function validateTag(tag: string): Effect.Effect<void, ConfigError> {
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(tag)
    ? Effect.void
    : Effect.fail(
        new ConfigError({
          message:
            "Tags must be 1-64 lowercase letters, numbers, dots, underscores or hyphens, starting with a letter or number.",
        })
      );
}

export function validateExtraInstructions(value: string): Effect.Effect<void, ConfigError> {
  return Buffer.byteLength(value, "utf8") <= 65536 && !value.includes("\0")
    ? Effect.void
    : Effect.fail(
        new ConfigError({
          message:
            "Extra instructions must be UTF-8 text without NUL characters, at most 65536 bytes.",
        })
      );
}

export function writeConfig(outpostHome: string, config: OutpostConfig) {
  return Effect.gen(function* () {
    yield* validateConfig(config, outpostHome);
    const filePath = yield* getConfigFilePath(outpostHome);
    yield* writeJsonFileAtomic(filePath, config);
  });
}

export function matchesTags(repo: { tags?: readonly string[] }, tags: readonly string[]) {
  return tags.every((tag) => repo.tags?.includes(tag));
}

export function knownWorktreesRoots(config: OutpostConfig): readonly string[] {
  return [
    ...new Set([
      config.worktreesRoot,
      config.legacyWorktreesRoot ?? config.worktreesRoot,
      ...(config.trustedWorktreesRoots ?? []),
    ]),
  ];
}

/** Caller holds the home lock and journals intent. Interrupted upgrades repair forward. */
export function prepareExtendedState(outpostHome: string, config: OutpostConfig) {
  return Effect.gen(function* () {
    // Validate all existing records before changing either file.
    const registry = yield* loadRepoRegistry(outpostHome);
    const upgraded = upgradeConfig(config);
    // First block newly started old processes, retaining all original defaults.
    if (config.version === 1) yield* writeConfig(outpostHome, upgraded);
    // Then block an old process that cached v1 config before taking the lock.
    if (registry.version === undefined)
      yield* writeRepoRegistry(outpostHome, { version: 2, repos: registry.repos });
    return upgraded;
  });
}
