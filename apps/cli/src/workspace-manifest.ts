import { hostname } from "node:os";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { ProvenanceFields } from "./base-selection.js";
import { commandExitCode, readOnlyGitCommand as gitCommand } from "./child-process.js";
import type { OutpostConfig } from "./config.js";
import { knownWorktreesRoots, loadConfig } from "./config.js";
import { domainDetails, ErrorDetailFields, reasonDetails } from "./error-details.js";
import {
  getCanonicalPortablePathKey,
  getPortablePathKey,
  resolvePathWithinRoot,
  semanticIdentifierSchema,
  validatePathSegment,
  validateSemanticIdentifier,
  validateWorktreeGuidancePath,
} from "./path-safety.js";
import { writeJsonFileAtomic } from "./store.js";

export class ManifestError extends Schema.TaggedError<ManifestError>()("ManifestError", {
  ...ErrorDetailFields,
  message: Schema.String,
}) {}

export class ManifestNotFoundError extends Schema.TaggedError<ManifestNotFoundError>()(
  "ManifestNotFoundError",
  {
    ...ErrorDetailFields,
    message: Schema.String,
  }
) {}

export class LockError extends Schema.TaggedError<LockError>()("LockError", {
  ...ErrorDetailFields,
  message: Schema.String,
}) {}

export const RepositoryEntrySchema = Schema.Struct({
  id: semanticIdentifierSchema("repository id"),
  name: semanticIdentifierSchema("repository name"),
  base: semanticIdentifierSchema("base branch"),
  ...ProvenanceFields,
  managedPath: Schema.String,
  worktreePath: Schema.String,
});

export type RepositoryEntry = Schema.Schema.Type<typeof RepositoryEntrySchema>;

export const ManifestSchema = Schema.Struct({
  version: Schema.optional(Schema.Literals([2, 3])),
  worktreesRoot: Schema.optional(Schema.String),
  ticket: semanticIdentifierSchema("ticket"),
  type: semanticIdentifierSchema("branch type"),
  branch: semanticIdentifierSchema("branch"),
  createdAt: Schema.String,
  workspacePath: Schema.String,
  repositories: Schema.Array(RepositoryEntrySchema),
}).check(
  Schema.makeFilter((manifest) => {
    for (const repo of manifest.repositories) {
      const hasAny =
        repo.baseSource !== undefined ||
        repo.requestedBase !== undefined ||
        repo.baseRef !== undefined ||
        repo.baseCommit !== undefined;
      if (manifest.version === 3) {
        if (
          !repo.baseSource ||
          repo.requestedBase === undefined ||
          !repo.baseRef ||
          !repo.baseCommit ||
          (repo.requestedBase !== null && !repo.requestedBase.trim())
        )
          return "Version 3 manifests require complete immutable base provenance for every repository.";
      } else if (hasAny) return "Base provenance requires manifest version 3.";
    }
    return true;
  })
);

export type Manifest = Schema.Schema.Type<typeof ManifestSchema>;

export type WorkspaceStatus = "ready" | "missing" | "invalid" | "unmanaged";

function validateTicketIdentifier(ticket: string) {
  return Effect.gen(function* () {
    yield* validateSemanticIdentifier("ticket", ticket);
    yield* validatePathSegment("ticket", ticket);
  });
}

function validateManifestTicket(ticket: string) {
  return validateTicketIdentifier(ticket).pipe(
    Effect.mapError(
      (error) => new ManifestError({ message: error.message, ...domainDetails(error) })
    )
  );
}

function validateLockTicket(ticket: string) {
  return validateTicketIdentifier(ticket).pipe(
    Effect.mapError((error) => new LockError({ message: error.message, ...domainDetails(error) }))
  );
}

export function getWorkspaceStateRoot(
  outpostHome: string
): Effect.Effect<string, never, Path.Path> {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    return path.join(outpostHome, "workspaces");
  });
}

export function getManifestFilePath(
  outpostHome: string,
  ticket: string
): Effect.Effect<string, never, Path.Path> {
  return Effect.gen(function* () {
    const stateRoot = yield* getWorkspaceStateRoot(outpostHome);
    const path = yield* Path.Path;
    return path.join(stateRoot, `${ticket}.json`);
  });
}

export function ensureWorkspaceStateRoot(
  outpostHome: string
): Effect.Effect<void, PlatformError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const stateRoot = yield* getWorkspaceStateRoot(outpostHome);
    yield* fs.makeDirectory(stateRoot, { recursive: true });
  });
}

function resolveCanonicalPath(
  value: string
): Effect.Effect<string, ManifestError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const suffix: Array<string> = [];
    let existingAncestor = path.resolve(value);

    while (true) {
      const exists = yield* fs
        .exists(existingAncestor)
        .pipe(
          Effect.mapError(
            (error) => new ManifestError({ message: error.message, ...domainDetails(error) })
          )
        );

      if (exists) {
        break;
      }

      const parent = path.dirname(existingAncestor);
      if (parent === existingAncestor) {
        break;
      }

      suffix.unshift(path.basename(existingAncestor));
      existingAncestor = parent;
    }

    const canonicalAncestor = yield* fs.realPath(existingAncestor).pipe(
      Effect.mapError(
        (error) =>
          new ManifestError({
            message: `Failed to resolve path ${existingAncestor}: ${error.message}`,
          })
      )
    );

    return path.resolve(canonicalAncestor, ...suffix);
  });
}

function ensureCanonicalPathWithinRoot(
  root: string,
  resolvedPath: string
): Effect.Effect<string, ManifestError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const canonicalRoot = yield* resolveCanonicalPath(root);
    const canonicalPath = yield* resolveCanonicalPath(resolvedPath);
    const relativePath = path.relative(canonicalRoot, canonicalPath);
    const isOutsideRoot =
      path.isAbsolute(relativePath) ||
      relativePath === ".." ||
      relativePath.startsWith(`..${path.sep}`);

    if (isOutsideRoot) {
      return yield* Effect.fail(
        new ManifestError({
          message: `Path must remain within ${canonicalRoot}: ${canonicalPath}`,
        })
      );
    }

    return resolvedPath;
  });
}

function ensureWorkspaceMatchesTicket(
  worktreesRoot: string,
  ticket: string,
  workspacePath: string,
  workspaceDir: string
): Effect.Effect<void, ManifestError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const canonicalRoot = yield* resolveCanonicalPath(worktreesRoot);
    const canonicalWorkspaceDir = yield* resolveCanonicalPath(workspaceDir);
    const expectedWorkspaceDir = path.resolve(canonicalRoot, ticket);
    const actualKey = yield* getPortablePathKey(canonicalWorkspaceDir);
    const expectedKey = yield* getPortablePathKey(expectedWorkspaceDir);

    if (actualKey !== expectedKey) {
      return yield* Effect.fail(
        new ManifestError({
          message: `Manifest workspacePath ${workspacePath} does not resolve to the expected ticket directory ${path.resolve(worktreesRoot, ticket)}`,
        })
      );
    }
  });
}

export function resolveWorkspacePath(
  worktreesRoot: string,
  workspacePath: string
): Effect.Effect<string, ManifestError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const resolvedPath = yield* resolvePathWithinRoot(worktreesRoot, workspacePath).pipe(
      Effect.mapError(
        (error) => new ManifestError({ message: error.message, ...domainDetails(error) })
      )
    );

    return yield* ensureCanonicalPathWithinRoot(worktreesRoot, resolvedPath);
  });
}

export function resolveManagedPath(
  reposRoot: string,
  managedPath: string
): Effect.Effect<string, ManifestError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const resolvedPath = yield* resolvePathWithinRoot(reposRoot, managedPath).pipe(
      Effect.mapError(
        (error) => new ManifestError({ message: error.message, ...domainDetails(error) })
      )
    );

    return yield* ensureCanonicalPathWithinRoot(reposRoot, resolvedPath);
  });
}

export function resolveWorktreePath(
  workspaceDir: string,
  worktreePath: string
): Effect.Effect<string, ManifestError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const resolved = yield* resolvePathWithinRoot(workspaceDir, worktreePath).pipe(
      Effect.mapError(
        (error) => new ManifestError({ message: error.message, ...domainDetails(error) })
      )
    );
    const relativePath = path.relative(workspaceDir, resolved);

    if (relativePath === "" || relativePath.includes(path.sep)) {
      return yield* Effect.fail(
        new ManifestError({
          message: `Worktree path must be a direct child of the workspace directory: ${worktreePath}`,
        })
      );
    }

    return yield* ensureCanonicalPathWithinRoot(workspaceDir, resolved);
  });
}

/** One inspection's identity index. Never persist it or pass it to a mutation. */
export type ManifestReadSnapshot = {
  outpostHome: string;
  config: OutpostConfig;
  tickets: readonly string[];
  keysByFile: ReadonlyMap<string, string>;
  filesByKey: ReadonlyMap<string, readonly string[]>;
};

export function buildManifestReadSnapshot(outpostHome: string, config: OutpostConfig) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const stateRoot = yield* getWorkspaceStateRoot(outpostHome);
    const entries = (yield* fs.exists(stateRoot)) ? yield* fs.readDirectory(stateRoot) : [];
    const files = entries.filter((entry) => entry.endsWith(".json"));
    const keysByFile = new Map<string, string>();
    const filesByKey = new Map<string, string[]>();
    for (const file of files) {
      const key = yield* getCanonicalPortablePathKey(path.join(stateRoot, file));
      keysByFile.set(file, key);
      const collisions = filesByKey.get(key) ?? [];
      collisions.push(file);
      filesByKey.set(key, collisions);
    }
    return {
      outpostHome,
      config,
      keysByFile,
      filesByKey,
      tickets: files
        .map((file) => file.slice(0, -".json".length))
        .sort((a, b) => a.localeCompare(b)),
    } satisfies ManifestReadSnapshot;
  });
}

export function readManifest(
  outpostHome: string,
  ticket: string,
  inspection?: ManifestReadSnapshot,
  options: { memberPaths?: "canonical" | "lexical"; contents?: string; config?: OutpostConfig } = {}
): Effect.Effect<
  Manifest,
  ManifestError | ManifestNotFoundError | PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    yield* validateManifestTicket(ticket);

    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const manifestFilePath = yield* getManifestFilePath(outpostHome, ticket);
    const exists = yield* fs.exists(manifestFilePath);

    if (!exists) {
      return yield* Effect.fail(
        new ManifestNotFoundError({
          message: `No manifest found for ticket ${ticket}`,
        })
      );
    }

    const contents =
      options.contents ??
      (yield* fs.readFileString(manifestFilePath).pipe(
        Effect.mapError(
          (error) =>
            new ManifestError({
              message: `Failed to read manifest ${manifestFilePath}: ${error.message}`,
            })
        )
      ));

    const parsedJson = yield* Effect.try({
      try: () => JSON.parse(contents) as unknown,
      catch: (error) =>
        new ManifestError({
          message: `Invalid JSON in manifest ${manifestFilePath}: ${String(error)}`,
        }),
    });

    const manifest = yield* Schema.decodeUnknownEffect(ManifestSchema)(parsedJson, {
      onExcessProperty: "error",
    }).pipe(
      Effect.mapError(
        (error) =>
          new ManifestError({
            message: `Invalid manifest ${manifestFilePath}: ${error.message}`,
          })
      )
    );

    if (manifest.ticket !== ticket) {
      return yield* Effect.fail(
        new ManifestError({
          message: `Manifest ticket ${manifest.ticket} does not match filename ticket ${ticket}`,
        })
      );
    }

    const config =
      options.config ??
      (inspection?.outpostHome === outpostHome
        ? inspection.config
        : yield* loadConfig(outpostHome).pipe(
            Effect.mapError(
              (error) => new ManifestError({ message: error.message, ...domainDetails(error) })
            )
          ));
    // Default reads (including all mutation preflights) always build a fresh identity index.
    const snapshot =
      inspection?.outpostHome === outpostHome
        ? inspection
        : yield* buildManifestReadSnapshot(outpostHome, config);
    const targetFileName = path.basename(manifestFilePath);
    const targetKey = snapshot.keysByFile.get(targetFileName);
    if (targetKey === undefined)
      return yield* Effect.fail(
        new ManifestError({ message: `Manifest changed during inspection: ${manifestFilePath}` })
      );
    const collision = snapshot.filesByKey.get(targetKey)?.find((file) => file !== targetFileName);
    if (collision)
      return yield* Effect.fail(
        new ManifestError({
          message: `Ticket identity collision detected for ${ticket}: manifest ${collision} has the same canonical path identity`,
        })
      );

    if (path.isAbsolute(manifest.workspacePath)) {
      return yield* Effect.fail(
        new ManifestError({
          message: "workspacePath must not be an absolute path",
        })
      );
    }

    const workspaceDir = yield* resolveManifestWorkspacePath(config, manifest);
    yield* ensureWorkspaceMatchesTicket(
      yield* getManifestWorktreesRoot(config, manifest),
      ticket,
      manifest.workspacePath,
      workspaceDir
    );

    const repoIds = new Set<string>();
    const managedPathKeys = new Set<string>();
    const worktreePathKeys = new Set<string>();
    const resolvedRepos: Array<{
      originalIndex: number;
      managedPath: string;
      worktreePath: string;
    }> = [];

    for (let i = 0; i < manifest.repositories.length; i++) {
      const repo = manifest.repositories[i];

      if (repoIds.has(repo.id)) {
        return yield* Effect.fail(
          new ManifestError({
            message: `Duplicate repository id in manifest: ${repo.id}`,
          })
        );
      }
      repoIds.add(repo.id);

      yield* validatePathSegment("worktreePath", repo.worktreePath).pipe(
        Effect.mapError(
          (error) => new ManifestError({ message: error.message, ...domainDetails(error) })
        )
      );

      if (path.isAbsolute(repo.managedPath)) {
        return yield* Effect.fail(
          new ManifestError({
            message: `managedPath must not be an absolute path: ${repo.managedPath}`,
          })
        );
      }

      if (path.isAbsolute(repo.worktreePath)) {
        return yield* Effect.fail(
          new ManifestError({
            message: `worktreePath must not be an absolute path: ${repo.worktreePath}`,
          })
        );
      }

      // Named resume defers existing member filesystem inspection so one foreign
      // member can be diagnosed without hiding the other frozen members. Every
      // mutating/default reader retains the exhaustive canonical checks.
      const lexicalOnly = options.memberPaths === "lexical";
      if (lexicalOnly && repo.worktreePath.length === 0)
        return yield* Effect.fail(new ManifestError({ message: "worktreePath may not be empty." }));
      const lexicalPath = (root: string, relative: string) =>
        resolvePathWithinRoot(root, relative).pipe(
          Effect.mapError(
            (error) => new ManifestError({ message: error.message, ...domainDetails(error) })
          )
        );
      const resolvedManagedPath = yield* lexicalOnly
        ? lexicalPath(config.reposRoot, repo.managedPath)
        : resolveManagedPath(config.reposRoot, repo.managedPath);
      const resolvedWorktreePath = yield* lexicalOnly
        ? lexicalPath(workspaceDir, repo.worktreePath)
        : resolveWorktreePath(workspaceDir, repo.worktreePath);

      if (lexicalOnly) {
        if (
          (yield* getPortablePathKey(resolvedWorktreePath)) ===
          (yield* getPortablePathKey(path.join(workspaceDir, "AGENTS.md")))
        )
          return yield* Effect.fail(
            new ManifestError({ message: "Worktree collides with reserved guidance AGENTS.md." })
          );
      } else
        yield* validateWorktreeGuidancePath(workspaceDir, resolvedWorktreePath).pipe(
          Effect.mapError(
            (error) => new ManifestError({ message: error.message, ...domainDetails(error) })
          )
        );

      resolvedRepos.push({
        originalIndex: i,
        managedPath: resolvedManagedPath,
        worktreePath: resolvedWorktreePath,
      });
    }

    for (const resolved of resolvedRepos) {
      const managedKey = yield* options.memberPaths === "lexical"
        ? getPortablePathKey(resolved.managedPath)
        : getCanonicalPortablePathKey(resolved.managedPath);

      if (managedPathKeys.has(managedKey)) {
        const repo = manifest.repositories[resolved.originalIndex];
        return yield* Effect.fail(
          new ManifestError({
            message: `Duplicate managed path in manifest: ${repo.managedPath}`,
          })
        );
      }
      managedPathKeys.add(managedKey);

      const worktreeKey = yield* options.memberPaths === "lexical"
        ? getPortablePathKey(resolved.worktreePath)
        : getCanonicalPortablePathKey(resolved.worktreePath);

      if (worktreePathKeys.has(worktreeKey)) {
        const repo = manifest.repositories[resolved.originalIndex];
        return yield* Effect.fail(
          new ManifestError({
            message: `Duplicate worktree path in manifest: ${repo.worktreePath}`,
          })
        );
      }
      worktreePathKeys.add(worktreeKey);
    }

    return manifest;
  });
}

export function writeManifest(
  outpostHome: string,
  manifest: Manifest
): Effect.Effect<void, ManifestError | PlatformError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const validatedManifest = yield* Schema.decodeUnknownEffect(ManifestSchema)(manifest, {
      onExcessProperty: "error",
    }).pipe(
      Effect.mapError(
        (error) =>
          new ManifestError({
            message: `Invalid manifest: ${error.message}`,
          })
      )
    );
    yield* validateManifestTicket(validatedManifest.ticket);
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const manifestFilePath = yield* getManifestFilePath(outpostHome, validatedManifest.ticket);

    yield* ensureWorkspaceStateRoot(outpostHome).pipe(
      Effect.mapError(
        (error) =>
          new ManifestError({
            message: `Failed to create workspace state root: ${error.message}`,
          })
      )
    );

    const stateRoot = yield* getWorkspaceStateRoot(outpostHome);
    const allEntries = yield* fs.readDirectory(stateRoot).pipe(
      Effect.mapError(
        (error) =>
          new ManifestError({
            message: `Failed to read workspace state directory ${stateRoot}: ${error.message}`,
          })
      )
    );

    const manifestFiles = allEntries.filter((entry) => entry.endsWith(".json"));
    const targetFileName = path.basename(manifestFilePath);
    const targetKey = yield* getCanonicalPortablePathKey(manifestFilePath);

    for (const file of manifestFiles) {
      if (file === targetFileName) continue;
      const candidatePath = path.join(stateRoot, file);
      const candidateKey = yield* getCanonicalPortablePathKey(candidatePath);

      if (candidateKey === targetKey) {
        return yield* Effect.fail(
          new ManifestError({
            message: `Ticket identity collision detected for ${validatedManifest.ticket}: manifest ${file} has the same canonical path identity`,
          })
        );
      }
    }

    if (path.isAbsolute(validatedManifest.workspacePath)) {
      return yield* Effect.fail(
        new ManifestError({
          message: "workspacePath must not be an absolute path",
        })
      );
    }

    const config = yield* loadConfig(outpostHome).pipe(
      Effect.mapError(
        (error) => new ManifestError({ message: error.message, ...domainDetails(error) })
      )
    );
    const workspaceDir = yield* resolveManifestWorkspacePath(config, validatedManifest);
    yield* ensureWorkspaceMatchesTicket(
      yield* getManifestWorktreesRoot(config, validatedManifest),
      validatedManifest.ticket,
      validatedManifest.workspacePath,
      workspaceDir
    );

    for (let i = 0; i < validatedManifest.repositories.length; i++) {
      const repo = validatedManifest.repositories[i];

      if (path.isAbsolute(repo.managedPath)) {
        return yield* Effect.fail(
          new ManifestError({
            message: `managedPath must not be an absolute path: ${repo.managedPath}`,
          })
        );
      }

      if (path.isAbsolute(repo.worktreePath)) {
        return yield* Effect.fail(
          new ManifestError({
            message: `worktreePath must not be an absolute path: ${repo.worktreePath}`,
          })
        );
      }

      yield* resolveManagedPath(config.reposRoot, repo.managedPath);
      yield* resolveWorktreePath(workspaceDir, repo.worktreePath);
    }

    yield* writeJsonFileAtomic(manifestFilePath, validatedManifest).pipe(
      Effect.mapError(
        (error) =>
          new ManifestError({
            message: `Failed to write manifest ${manifestFilePath}: ${error.message}`,
          })
      )
    );
  });
}

export function deleteManifest(
  outpostHome: string,
  ticket: string
): Effect.Effect<void, ManifestError | PlatformError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    yield* validateManifestTicket(ticket);
    const fs = yield* FileSystem.FileSystem;
    const manifestFilePath = yield* getManifestFilePath(outpostHome, ticket);
    yield* fs.remove(manifestFilePath, { force: true });
  });
}

export function manifestExists(
  outpostHome: string,
  ticket: string
): Effect.Effect<boolean, ManifestError | PlatformError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    yield* validateManifestTicket(ticket);
    const fs = yield* FileSystem.FileSystem;
    const manifestFilePath = yield* getManifestFilePath(outpostHome, ticket);
    return yield* fs.exists(manifestFilePath);
  });
}

export function listManifestTickets(
  outpostHome: string
): Effect.Effect<ReadonlyArray<string>, PlatformError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const stateRoot = yield* getWorkspaceStateRoot(outpostHome);
    const stateRootExists = yield* fs.exists(stateRoot);

    if (!stateRootExists) {
      return [];
    }

    const entries = yield* fs.readDirectory(stateRoot);
    const tickets = entries
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => entry.slice(0, -".json".length))
      .sort((left, right) => left.localeCompare(right));

    return tickets;
  });
}

export function verifyWorktreeOwnership(
  worktreePath: string,
  managedRepoPath: string
): Effect.Effect<boolean, ManifestError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const gitFilePath = path.join(worktreePath, ".git");
    const gitFileExists = yield* fs
      .exists(gitFilePath)
      .pipe(
        Effect.mapError(
          (error) => new ManifestError({ message: error.message, ...domainDetails(error) })
        )
      );

    if (!gitFileExists) {
      return false;
    }

    const gitFile = yield* fs.readFileString(gitFilePath).pipe(
      Effect.mapError(
        (error) =>
          new ManifestError({
            message: `Failed to read worktree metadata ${gitFilePath}: ${error.message}`,
          })
      )
    );
    const match = /^gitdir:\s*(.+)\s*$/m.exec(gitFile);

    if (!match?.[1]) {
      return false;
    }

    const gitDirectory = path.resolve(worktreePath, match[1]);
    const worktreesDir = path.dirname(gitDirectory);

    if (path.basename(worktreesDir) !== "worktrees") {
      return false;
    }

    const resolvedManagedDir = path.dirname(worktreesDir);
    const expectedKey = yield* getCanonicalPortablePathKey(managedRepoPath);
    const actualKey = yield* getCanonicalPortablePathKey(resolvedManagedDir);

    return expectedKey === actualKey;
  });
}

export function deriveWorkspaceStatus(
  outpostHome: string,
  config: OutpostConfig,
  ticket: string
): Effect.Effect<
  WorkspaceStatus,
  PlatformError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const manifestFilePath = yield* getManifestFilePath(outpostHome, ticket);
    const manifestFileExists = yield* fs.exists(manifestFilePath);

    if (!manifestFileExists) {
      for (const root of knownWorktreesRoots(config)) {
        const workspaceDirResult = yield* Effect.result(resolvePathWithinRoot(root, ticket));
        if (Result.isFailure(workspaceDirResult)) continue;
        const workspaceDir = workspaceDirResult.success;
        if ((yield* fs.exists(workspaceDir)) && (yield* fs.stat(workspaceDir)).type === "Directory")
          return "unmanaged";
      }
      return "missing";
    }

    const manifestResult = yield* readManifest(outpostHome, ticket).pipe(
      Effect.map((manifest) => ({ _tag: "ok" as const, manifest })),
      Effect.catch(() => Effect.succeed({ _tag: "invalid" as const }))
    );

    if (manifestResult._tag === "invalid") {
      return "invalid";
    }

    return yield* deriveManifestStatus(config, manifestResult.manifest);
  });
}

/** Health checks for a manifest already validated during this inspection. */
export function deriveManifestStatus(
  config: OutpostConfig,
  manifest: Manifest
): Effect.Effect<
  WorkspaceStatus,
  PlatformError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const workspaceDirResult = yield* Effect.result(resolveManifestWorkspacePath(config, manifest));

    if (Result.isFailure(workspaceDirResult)) {
      return "invalid";
    }

    const workspaceDir = workspaceDirResult.success;
    let hasMissingPath = !(yield* fs.exists(workspaceDir));

    for (const repo of manifest.repositories) {
      const resolvedManagedPathResult = yield* Effect.result(
        resolveManagedPath(config.reposRoot, repo.managedPath)
      );

      if (Result.isFailure(resolvedManagedPathResult)) {
        return "invalid";
      }

      const resolvedManagedPath = resolvedManagedPathResult.success;
      const managedExists = yield* fs.exists(resolvedManagedPath);

      const resolvedWorktreePathResult = yield* Effect.result(
        resolveWorktreePath(workspaceDir, repo.worktreePath)
      );

      if (Result.isFailure(resolvedWorktreePathResult)) {
        return "invalid";
      }

      const resolvedWorktree = resolvedWorktreePathResult.success;
      const worktreeExists = yield* fs.exists(resolvedWorktree);

      if (!managedExists || !worktreeExists) {
        hasMissingPath = true;
        continue;
      }

      const ownershipValid = yield* verifyWorktreeOwnership(
        resolvedWorktree,
        resolvedManagedPath
      ).pipe(Effect.catch(() => Effect.succeed(false)));

      if (!ownershipValid) {
        return "invalid";
      }
      const headValid = yield* commandExitCode(
        gitCommand("-C", resolvedWorktree, "rev-parse", "--verify", "HEAD^{commit}")
      ).pipe(
        Effect.map((status) => status === 0),
        Effect.orElseSucceed(() => false)
      );
      if (!headValid) return "invalid";
    }

    return hasMissingPath ? "missing" : "ready";
  });
}

export function scanWorktreesRoot(
  worktreesRoot: string,
  outpostHome: string,
  options: { includeRegisteredDirectories?: boolean } = {}
): Effect.Effect<ReadonlyArray<string>, PlatformError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const exists = yield* fs.exists(worktreesRoot);

    if (!exists) {
      return [];
    }

    const entries = yield* fs.readDirectory(worktreesRoot);
    const unmanagedTickets: Array<string> = [];

    for (const entry of entries) {
      const entryPath = path.join(worktreesRoot, entry);
      const stat = yield* fs.stat(entryPath).pipe(Effect.catch(() => Effect.succeed(undefined)));

      if (!stat || stat.type !== "Directory") {
        continue;
      }

      // A manifest identifies one path, not every same-named directory across
      // historical roots. Listing excludes its validated paths after this scan.
      if (options.includeRegisteredDirectories) {
        unmanagedTickets.push(entry);
        continue;
      }
      const manifestFilePath = path.join(outpostHome, "workspaces", `${entry}.json`);
      const manifestExists = yield* fs
        .exists(manifestFilePath)
        .pipe(Effect.catch(() => Effect.succeed(false)));

      if (!manifestExists) {
        unmanagedTickets.push(entry);
      }
    }

    return unmanagedTickets.sort((left, right) => left.localeCompare(right));
  });
}

export function getLockFilePath(
  outpostHome: string,
  ticket: string
): Effect.Effect<string, never, Path.Path> {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const stateRoot = yield* getWorkspaceStateRoot(outpostHome);
    const portableTicket = ticket.replace(/[ .]+$/g, "").toLowerCase();
    return path.join(stateRoot, `.${portableTicket}.lock`);
  });
}

export function acquireTicketLock(
  outpostHome: string,
  ticket: string
): Effect.Effect<void, LockError | PlatformError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    yield* validateLockTicket(ticket);
    const fs = yield* FileSystem.FileSystem;
    const lockFilePath = yield* getLockFilePath(outpostHome, ticket);

    yield* ensureWorkspaceStateRoot(outpostHome).pipe(
      Effect.mapError(
        (error) =>
          new LockError({
            message: `Failed to create workspace state root for lock: ${error.message}`,
          })
      )
    );

    yield* fs
      .writeFileString(
        lockFilePath,
        `${JSON.stringify({ ticket, pid: process.pid, hostname: hostname(), startedAt: new Date().toISOString() })}\n`,
        { flag: "wx" }
      )
      .pipe(
        Effect.mapError((error) => {
          // effect v4 normalizes EEXIST to the `AlreadyExists` system error tag;
          // detect the held-lock case on the reason, not the message text.
          if (error._tag === "PlatformError" && error.reason._tag === "AlreadyExists") {
            return new LockError({
              ...reasonDetails("lock-held"),
              message: `Ticket ${ticket} is locked by another operation. Wait for it to complete. After a crash, run outpost doctor and inspect the recorded owner and artifacts before manually removing the lock.`,
            });
          }
          return new LockError({
            message: `Failed to acquire lock for ticket ${ticket}: ${error.message}`,
          });
        })
      );
  });
}

export function releaseTicketLock(
  outpostHome: string,
  ticket: string
): Effect.Effect<void, LockError | PlatformError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    yield* validateLockTicket(ticket);
    const fs = yield* FileSystem.FileSystem;
    const lockFilePath = yield* getLockFilePath(outpostHome, ticket);
    yield* fs.remove(lockFilePath, { force: true });
  });
}

export function ticketIsLocked(
  outpostHome: string,
  ticket: string
): Effect.Effect<boolean, LockError | PlatformError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    yield* validateLockTicket(ticket);
    const fs = yield* FileSystem.FileSystem;
    const lockFilePath = yield* getLockFilePath(outpostHome, ticket);
    return yield* fs.exists(lockFilePath);
  });
}

/** Roots come from trusted configuration; an arbitrary manifest cannot grant deletion authority. */
export function getManifestWorktreesRoot(
  config: OutpostConfig,
  manifest: Manifest
): Effect.Effect<string, ManifestError> {
  if (manifest.version === undefined && manifest.worktreesRoot === undefined)
    return Effect.succeed(config.legacyWorktreesRoot ?? config.worktreesRoot);
  if (
    (manifest.version !== 2 && manifest.version !== 3) ||
    !manifest.worktreesRoot ||
    config.version !== 2 ||
    !config.trustedWorktreesRoots?.includes(manifest.worktreesRoot)
  )
    return Effect.fail(
      new ManifestError({
        message: "Manifest workspace root is not registered in version 2 configuration.",
      })
    );
  return Effect.succeed(manifest.worktreesRoot);
}

export function resolveManifestWorkspacePath(config: OutpostConfig, manifest: Manifest) {
  return getManifestWorktreesRoot(config, manifest).pipe(
    Effect.flatMap((root) => resolveWorkspacePath(root, manifest.workspacePath))
  );
}
