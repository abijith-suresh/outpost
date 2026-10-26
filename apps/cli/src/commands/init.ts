import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Schema from "effect/Schema";
import {
  buildInitialConfig,
  emptyRepoRegistry,
  getConfigFilePath,
  getRepoRegistryFilePath,
  loadRepoRegistry,
  resolveOutpostHome,
} from "../config.js";
import { domainDetails, ErrorDetailFields } from "../error-details.js";
import { acquireHomeMutationLock } from "../mutation-lock.js";
import { writeJsonFileAtomic } from "../store.js";
import type { CommandOutput } from "../types.js";
import { ensureWorkspaceStateRoot } from "../workspace-manifest.js";

export class InitError extends Schema.TaggedError<InitError>()("InitError", {
  ...ErrorDetailFields,
  message: Schema.String,
}) {}

export function runInit(): Effect.Effect<
  CommandOutput<"init">,
  InitError | PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const outpostHome = yield* resolveOutpostHome();
    yield* fs.makeDirectory(outpostHome, { recursive: true });
    const mutation = yield* acquireHomeMutationLock(outpostHome, "init").pipe(
      Effect.mapError((error) => new InitError({ message: error.message, ...domainDetails(error) }))
    );
    const configFilePath = yield* getConfigFilePath(outpostHome);
    const repoRegistryFilePath = yield* getRepoRegistryFilePath(outpostHome);
    const configExists = yield* fs.exists(configFilePath);

    if (configExists) {
      const registryExists = yield* fs.exists(repoRegistryFilePath);
      return yield* new InitError({
        message: registryExists
          ? `Outpost is already initialized at ${outpostHome}`
          : `Initialization is incomplete at ${outpostHome}: config exists but the repository registry is missing. Run outpost doctor and inspect existing repositories before restoring the registry. Init will not replace lost state.`,
      });
    }

    const registryExists = yield* fs.exists(repoRegistryFilePath);
    if (registryExists) {
      const retainedRegistry = yield* loadRepoRegistry(outpostHome).pipe(
        Effect.mapError(
          (error) =>
            new InitError({
              message: `Cannot resume initialization: ${error.message}. Existing registry preserved.`,
            })
        )
      );
      if (retainedRegistry.version !== undefined)
        return yield* Effect.fail(
          new InitError({
            message: `Cannot initialize ${outpostHome}: a version ${retainedRegistry.version} registry remains without its configuration. Run outpost doctor and restore the original config after inspecting existing workspace roots and guidance. Init will not reset migrated state.`,
          })
        );
    }

    const config = yield* buildInitialConfig(outpostHome);

    yield* mutation
      .record({
        action: "initialize-home",
        configFilePath,
        repoRegistryFilePath,
        reposRoot: config.reposRoot,
        worktreesRoot: config.worktreesRoot,
      })
      .pipe(
        Effect.mapError(
          (error) => new InitError({ message: error.message, ...domainDetails(error) })
        )
      );

    yield* fs.makeDirectory(outpostHome, { recursive: true }).pipe(
      Effect.mapError(
        (error) =>
          new InitError({
            message: `Failed to create Outpost home ${outpostHome}: ${error.message}`,
          })
      )
    );

    yield* fs.makeDirectory(config.worktreesRoot, { recursive: true }).pipe(
      Effect.mapError(
        (error) =>
          new InitError({
            message: `Failed to create worktrees root ${config.worktreesRoot}: ${error.message}`,
          })
      )
    );

    yield* fs.makeDirectory(config.reposRoot, { recursive: true }).pipe(
      Effect.mapError(
        (error) =>
          new InitError({
            message: `Failed to create repos root ${config.reposRoot}: ${error.message}`,
          })
      )
    );

    yield* ensureWorkspaceStateRoot(outpostHome).pipe(
      Effect.mapError(
        (error) =>
          new InitError({
            message: `Failed to create workspace state root: ${error.message}`,
          })
      )
    );

    // Config is the initialization marker. Install it only after the registry
    // is written, and never overwrite a registry retained from a failed init.
    if (!registryExists) {
      yield* writeJsonFileAtomic(repoRegistryFilePath, emptyRepoRegistry).pipe(
        Effect.mapError(
          (error) =>
            new InitError({
              message: `Failed to write repo registry ${repoRegistryFilePath}: ${error.message}`,
            })
        )
      );
    }
    yield* mutation
      .record({ action: "write-initialization-marker", configFilePath })
      .pipe(
        Effect.mapError(
          (error) => new InitError({ message: error.message, ...domainDetails(error) })
        )
      );
    yield* writeJsonFileAtomic(configFilePath, config).pipe(
      Effect.mapError(
        (error) =>
          new InitError({
            message: `Failed to write config file ${configFilePath}: ${error.message}`,
          })
      )
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
    } satisfies CommandOutput<"init">;
  }).pipe(Effect.scoped);
}
