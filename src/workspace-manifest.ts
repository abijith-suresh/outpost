import * as FileSystem from "@effect/platform/FileSystem";
import type { PlatformError } from "@effect/platform/Error";
import * as Path from "@effect/platform/Path";
import { Effect, Either, Schema } from "effect";

import { loadConfig } from "./config.js";
import type { OutpostConfig } from "./config.js";
import {
  getCanonicalPortablePathKey,
  resolvePathWithinRoot,
  validatePathSegment,
} from "./path-safety.js";
import { writeJsonFileAtomic } from "./store.js";

export class ManifestError extends Schema.TaggedError<ManifestError>()(
  "ManifestError",
  {
    message: Schema.String,
  },
) {}

export class ManifestNotFoundError extends Schema.TaggedError<ManifestNotFoundError>()(
  "ManifestNotFoundError",
  {
    message: Schema.String,
  },
) {}

export class LockError extends Schema.TaggedError<LockError>()("LockError", {
  message: Schema.String,
}) {}

export const RepositoryEntrySchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  base: Schema.String,
  managedPath: Schema.String,
  worktreePath: Schema.String,
});

export type RepositoryEntry = Schema.Schema.Type<typeof RepositoryEntrySchema>;

export const ManifestSchema = Schema.Struct({
  ticket: Schema.String,
  type: Schema.String,
  branch: Schema.String,
  createdAt: Schema.String,
  workspacePath: Schema.String,
  repositories: Schema.Array(RepositoryEntrySchema),
});

export type Manifest = Schema.Schema.Type<typeof ManifestSchema>;

export type WorkspaceStatus = "ready" | "missing" | "invalid" | "unmanaged";

export function getWorkspaceStateRoot(
  outpostHome: string,
): Effect.Effect<string, never, Path.Path> {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    return path.join(outpostHome, "workspaces");
  });
}

export function getManifestFilePath(
  outpostHome: string,
  ticket: string,
): Effect.Effect<string, never, Path.Path> {
  return Effect.gen(function* () {
    const stateRoot = yield* getWorkspaceStateRoot(outpostHome);
    const path = yield* Path.Path;
    return path.join(stateRoot, `${ticket}.json`);
  });
}

export function ensureWorkspaceStateRoot(
  outpostHome: string,
): Effect.Effect<void, PlatformError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const stateRoot = yield* getWorkspaceStateRoot(outpostHome);
    yield* fs.makeDirectory(stateRoot, { recursive: true });
  });
}

export function resolveWorkspacePath(
  worktreesRoot: string,
  workspacePath: string,
): Effect.Effect<string, ManifestError, Path.Path> {
  return resolvePathWithinRoot(worktreesRoot, workspacePath).pipe(
    Effect.mapError((error) => new ManifestError({ message: error.message })),
  );
}

export function resolveManagedPath(
  reposRoot: string,
  managedPath: string,
): Effect.Effect<string, ManifestError, Path.Path> {
  return resolvePathWithinRoot(reposRoot, managedPath).pipe(
    Effect.mapError((error) => new ManifestError({ message: error.message })),
  );
}

export function resolveWorktreePath(
  workspaceDir: string,
  worktreePath: string,
): Effect.Effect<string, ManifestError, Path.Path> {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const resolved = yield* resolvePathWithinRoot(
      workspaceDir,
      worktreePath,
    ).pipe(
      Effect.mapError((error) => new ManifestError({ message: error.message })),
    );
    const relativePath = path.relative(workspaceDir, resolved);

    if (relativePath === "" || relativePath.includes(path.sep)) {
      return yield* Effect.fail(
        new ManifestError({
          message: `Worktree path must be a direct child of the workspace directory: ${worktreePath}`,
        }),
      );
    }

    return resolved;
  });
}

export function readManifest(
  outpostHome: string,
  ticket: string,
): Effect.Effect<
  Manifest,
  ManifestError | ManifestNotFoundError | PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const manifestFilePath = yield* getManifestFilePath(outpostHome, ticket);
    const exists = yield* fs.exists(manifestFilePath);

    if (!exists) {
      return yield* Effect.fail(
        new ManifestNotFoundError({
          message: `No manifest found for ticket ${ticket}`,
        }),
      );
    }

    const contents = yield* fs.readFileString(manifestFilePath).pipe(
      Effect.mapError(
        (error) =>
          new ManifestError({
            message: `Failed to read manifest ${manifestFilePath}: ${error.message}`,
          }),
      ),
    );

    const parsedJson = yield* Effect.try({
      try: () => JSON.parse(contents) as unknown,
      catch: (error) =>
        new ManifestError({
          message: `Invalid JSON in manifest ${manifestFilePath}: ${String(error)}`,
        }),
    });

    const manifest = yield* Schema.decodeUnknown(ManifestSchema)(
      parsedJson,
    ).pipe(
      Effect.mapError(
        (error) =>
          new ManifestError({
            message: `Invalid manifest ${manifestFilePath}: ${error.message}`,
          }),
      ),
    );

    if (manifest.ticket !== ticket) {
      return yield* Effect.fail(
        new ManifestError({
          message: `Manifest ticket ${manifest.ticket} does not match filename ticket ${ticket}`,
        }),
      );
    }

    yield* validatePathSegment("ticket", ticket).pipe(
      Effect.mapError((error) => new ManifestError({ message: error.message })),
    );

    const stateRoot = yield* getWorkspaceStateRoot(outpostHome);
    const allEntries = yield* fs.readDirectory(stateRoot).pipe(
      Effect.mapError(
        (error) =>
          new ManifestError({
            message: `Failed to read workspace state directory ${stateRoot}: ${error.message}`,
          }),
      ),
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
            message: `Ticket identity collision detected for ${ticket}: manifest ${file} has the same canonical path identity`,
          }),
        );
      }
    }

    const config = yield* loadConfig(outpostHome).pipe(
      Effect.mapError((error) => new ManifestError({ message: error.message })),
    );

    if (path.isAbsolute(manifest.workspacePath)) {
      return yield* Effect.fail(
        new ManifestError({
          message: "workspacePath must not be an absolute path",
        }),
      );
    }

    const workspaceDir = yield* resolveWorkspacePath(
      config.worktreesRoot,
      manifest.workspacePath,
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
          }),
        );
      }
      repoIds.add(repo.id);

      yield* validatePathSegment("worktreePath", repo.worktreePath).pipe(
        Effect.mapError(
          (error) => new ManifestError({ message: error.message }),
        ),
      );

      if (path.isAbsolute(repo.managedPath)) {
        return yield* Effect.fail(
          new ManifestError({
            message: `managedPath must not be an absolute path: ${repo.managedPath}`,
          }),
        );
      }

      if (path.isAbsolute(repo.worktreePath)) {
        return yield* Effect.fail(
          new ManifestError({
            message: `worktreePath must not be an absolute path: ${repo.worktreePath}`,
          }),
        );
      }

      const resolvedManagedPath = yield* resolveManagedPath(
        config.reposRoot,
        repo.managedPath,
      );

      const resolvedWorktreePath = yield* resolveWorktreePath(
        workspaceDir,
        repo.worktreePath,
      );

      resolvedRepos.push({
        originalIndex: i,
        managedPath: resolvedManagedPath,
        worktreePath: resolvedWorktreePath,
      });
    }

    for (const resolved of resolvedRepos) {
      const managedKey = yield* getCanonicalPortablePathKey(
        resolved.managedPath,
      );

      if (managedPathKeys.has(managedKey)) {
        const repo = manifest.repositories[resolved.originalIndex];
        return yield* Effect.fail(
          new ManifestError({
            message: `Duplicate managed path in manifest: ${repo.managedPath}`,
          }),
        );
      }
      managedPathKeys.add(managedKey);

      const worktreeKey = yield* getCanonicalPortablePathKey(
        resolved.worktreePath,
      );

      if (worktreePathKeys.has(worktreeKey)) {
        const repo = manifest.repositories[resolved.originalIndex];
        return yield* Effect.fail(
          new ManifestError({
            message: `Duplicate worktree path in manifest: ${repo.worktreePath}`,
          }),
        );
      }
      worktreePathKeys.add(worktreeKey);
    }

    return manifest;
  });
}

export function writeManifest(
  outpostHome: string,
  manifest: Manifest,
): Effect.Effect<
  void,
  ManifestError | PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const manifestFilePath = yield* getManifestFilePath(
      outpostHome,
      manifest.ticket,
    );

    yield* ensureWorkspaceStateRoot(outpostHome).pipe(
      Effect.mapError(
        (error) =>
          new ManifestError({
            message: `Failed to create workspace state root: ${error.message}`,
          }),
      ),
    );

    const stateRoot = yield* getWorkspaceStateRoot(outpostHome);
    const allEntries = yield* fs.readDirectory(stateRoot).pipe(
      Effect.mapError(
        (error) =>
          new ManifestError({
            message: `Failed to read workspace state directory ${stateRoot}: ${error.message}`,
          }),
      ),
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
            message: `Ticket identity collision detected for ${manifest.ticket}: manifest ${file} has the same canonical path identity`,
          }),
        );
      }
    }

    if (path.isAbsolute(manifest.workspacePath)) {
      return yield* Effect.fail(
        new ManifestError({
          message: "workspacePath must not be an absolute path",
        }),
      );
    }

    for (let i = 0; i < manifest.repositories.length; i++) {
      const repo = manifest.repositories[i];

      if (path.isAbsolute(repo.managedPath)) {
        return yield* Effect.fail(
          new ManifestError({
            message: `managedPath must not be an absolute path: ${repo.managedPath}`,
          }),
        );
      }

      if (path.isAbsolute(repo.worktreePath)) {
        return yield* Effect.fail(
          new ManifestError({
            message: `worktreePath must not be an absolute path: ${repo.worktreePath}`,
          }),
        );
      }
    }

    yield* writeJsonFileAtomic(manifestFilePath, manifest).pipe(
      Effect.mapError(
        (error) =>
          new ManifestError({
            message: `Failed to write manifest ${manifestFilePath}: ${error.message}`,
          }),
      ),
    );
  });
}

export function deleteManifest(
  outpostHome: string,
  ticket: string,
): Effect.Effect<void, PlatformError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const manifestFilePath = yield* getManifestFilePath(outpostHome, ticket);
    yield* fs.remove(manifestFilePath, { force: true });
  });
}

export function manifestExists(
  outpostHome: string,
  ticket: string,
): Effect.Effect<boolean, PlatformError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const manifestFilePath = yield* getManifestFilePath(outpostHome, ticket);
    return yield* fs.exists(manifestFilePath);
  });
}

export function listManifestTickets(
  outpostHome: string,
): Effect.Effect<
  ReadonlyArray<string>,
  PlatformError,
  FileSystem.FileSystem | Path.Path
> {
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
  managedRepoPath: string,
): Effect.Effect<boolean, ManifestError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const gitFilePath = path.join(worktreePath, ".git");
    const gitFileExists = yield* fs
      .exists(gitFilePath)
      .pipe(
        Effect.mapError(
          (error) => new ManifestError({ message: error.message }),
        ),
      );

    if (!gitFileExists) {
      return false;
    }

    const gitFile = yield* fs.readFileString(gitFilePath).pipe(
      Effect.mapError(
        (error) =>
          new ManifestError({
            message: `Failed to read worktree metadata ${gitFilePath}: ${error.message}`,
          }),
      ),
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
  ticket: string,
): Effect.Effect<
  WorkspaceStatus,
  PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const manifestFilePath = yield* getManifestFilePath(outpostHome, ticket);
    const manifestFileExists = yield* fs.exists(manifestFilePath);

    if (!manifestFileExists) {
      const workspaceDirResult = yield* Effect.either(
        resolvePathWithinRoot(config.worktreesRoot, ticket),
      );

      if (Either.isLeft(workspaceDirResult)) {
        return "missing";
      }

      const workspaceDir = workspaceDirResult.right;
      const workspaceDirExists = yield* fs.exists(workspaceDir);

      if (workspaceDirExists) {
        const stat = yield* fs.stat(workspaceDir);

        if (stat.type === "Directory") {
          return "unmanaged";
        }
      }

      return "missing";
    }

    const manifestResult = yield* readManifest(outpostHome, ticket).pipe(
      Effect.map((manifest) => ({ _tag: "ok" as const, manifest })),
      Effect.catchAll(() => Effect.succeed({ _tag: "invalid" as const })),
    );

    if (manifestResult._tag === "invalid") {
      return "invalid";
    }

    const manifest = manifestResult.manifest;

    const workspaceDirResult = yield* Effect.either(
      resolveWorkspacePath(config.worktreesRoot, manifest.workspacePath),
    );

    if (Either.isLeft(workspaceDirResult)) {
      return "invalid";
    }

    const workspaceDir = workspaceDirResult.right;
    const workspaceDirExists = yield* fs.exists(workspaceDir);

    if (!workspaceDirExists) {
      return "missing";
    }

    for (const repo of manifest.repositories) {
      const resolvedManagedPathResult = yield* Effect.either(
        resolveManagedPath(config.reposRoot, repo.managedPath),
      );

      if (Either.isLeft(resolvedManagedPathResult)) {
        return "invalid";
      }

      const resolvedManagedPath = resolvedManagedPathResult.right;
      const managedExists = yield* fs.exists(resolvedManagedPath);

      if (!managedExists) {
        return "missing";
      }

      const resolvedWorktreePathResult = yield* Effect.either(
        resolveWorktreePath(workspaceDir, repo.worktreePath),
      );

      if (Either.isLeft(resolvedWorktreePathResult)) {
        return "invalid";
      }

      const resolvedWorktree = resolvedWorktreePathResult.right;
      const worktreeExists = yield* fs.exists(resolvedWorktree);

      if (!worktreeExists) {
        return "missing";
      }

      const ownershipValid = yield* verifyWorktreeOwnership(
        resolvedWorktree,
        resolvedManagedPath,
      ).pipe(Effect.catchAll(() => Effect.succeed(false)));

      if (!ownershipValid) {
        return "invalid";
      }
    }

    return "ready";
  });
}

export function scanWorktreesRoot(
  worktreesRoot: string,
  outpostHome: string,
): Effect.Effect<
  ReadonlyArray<string>,
  PlatformError,
  FileSystem.FileSystem | Path.Path
> {
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
      const stat = yield* fs
        .stat(entryPath)
        .pipe(Effect.catchAll(() => Effect.succeed(undefined)));

      if (!stat || stat.type !== "Directory") {
        continue;
      }

      const manifestFilePath = path.join(
        outpostHome,
        "workspaces",
        `${entry}.json`,
      );
      const manifestExists = yield* fs
        .exists(manifestFilePath)
        .pipe(Effect.catchAll(() => Effect.succeed(false)));

      if (!manifestExists) {
        unmanagedTickets.push(entry);
      }
    }

    return unmanagedTickets.sort((left, right) => left.localeCompare(right));
  });
}

function getLockFilePath(
  outpostHome: string,
  ticket: string,
): Effect.Effect<string, never, Path.Path> {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const stateRoot = yield* getWorkspaceStateRoot(outpostHome);
    return path.join(stateRoot, `.${ticket}.lock`);
  });
}

export function acquireTicketLock(
  outpostHome: string,
  ticket: string,
): Effect.Effect<
  void,
  LockError | PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const lockFilePath = yield* getLockFilePath(outpostHome, ticket);

    yield* ensureWorkspaceStateRoot(outpostHome).pipe(
      Effect.mapError(
        (error) =>
          new LockError({
            message: `Failed to create workspace state root for lock: ${error.message}`,
          }),
      ),
    );

    yield* fs.writeFileString(lockFilePath, "", { flag: "wx" }).pipe(
      Effect.mapError(
        (error) =>
          new LockError({
            message: `Failed to acquire lock for ticket ${ticket}: ${error.message}`,
          }),
      ),
    );
  });
}

export function releaseTicketLock(
  outpostHome: string,
  ticket: string,
): Effect.Effect<void, PlatformError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const lockFilePath = yield* getLockFilePath(outpostHome, ticket);
    yield* fs.remove(lockFilePath, { force: true });
  });
}

export function ticketIsLocked(
  outpostHome: string,
  ticket: string,
): Effect.Effect<boolean, PlatformError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const lockFilePath = yield* getLockFilePath(outpostHome, ticket);
    return yield* fs.exists(lockFilePath);
  });
}
