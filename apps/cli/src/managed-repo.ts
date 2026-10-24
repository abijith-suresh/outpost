import { Effect, Schema } from "effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { commandExitCode, commandString, gitCommand } from "./child-process.js";
import type { RepoRecord } from "./config.js";
import { domainDetails, ErrorDetailFields, reasonDetails } from "./error-details.js";
import { getCanonicalPortablePathKey } from "./path-safety.js";
import { getFileManagedPathSegments, getManagedRepoPath } from "./remote-identity.js";
import { resolveManagedPath } from "./workspace-manifest.js";

export class ManagedRepoError extends Schema.TaggedError<ManagedRepoError>()("ManagedRepoError", {
  ...ErrorDetailFields,
  message: Schema.String,
}) {}

/** Registry paths are untrusted. Validate both lexical and canonical containment. */
export function validateManagedRepoPath(reposRoot: string, repo: RepoRecord) {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const relative = path.relative(reposRoot, repo.managedRepoPath);
    if (!path.isAbsolute(repo.managedRepoPath) || relative === "") {
      return yield* Effect.fail(
        new ManagedRepoError({
          message: `Invalid managed repository path: ${repo.managedRepoPath}`,
        })
      );
    }
    const resolved = yield* resolveManagedPath(reposRoot, relative);
    return resolved;
  }).pipe(
    Effect.mapError(
      (error) => new ManagedRepoError({ message: error.message, ...reasonDetails("invalid-state") })
    )
  );
}

/** A marker or a verifiable legacy mirror layout proves ownership, never a name alone. */
export function verifyManagedRepository(
  reposRoot: string,
  repo: RepoRecord
): Effect.Effect<
  string,
  ManagedRepoError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  return Effect.gen(function* () {
    const managedPath = yield* validateManagedRepoPath(reposRoot, repo);
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(managedPath)))
      return yield* Effect.fail(
        new ManagedRepoError({
          ...reasonDetails("repo-missing"),
          message: `Managed repository is missing at ${managedPath}`,
        })
      );
    const git = (...args: string[]) => gitCommand("--git-dir", managedPath, ...args);
    const bare = yield* commandString(git("rev-parse", "--is-bare-repository"));
    if (bare.trim() !== "true") {
      return yield* Effect.fail(
        new ManagedRepoError({
          message: `Refusing foreign directory at ${managedPath}: expected a managed bare repository.`,
        })
      );
    }
    const origin = yield* commandString(git("config", "--local", "--get", "remote.origin.url"));
    if (origin.trim() !== repo.remoteUrl) {
      return yield* Effect.fail(
        new ManagedRepoError({
          message: `Repository remote does not match registry ownership at ${managedPath}.`,
        })
      );
    }
    const marker = yield* commandString(
      git("config", "--local", "--get", "outpost.repository-id")
    ).pipe(Effect.result);
    if (marker._tag === "Success") {
      if (marker.success.trim() !== repo.id) {
        return yield* Effect.fail(
          new ManagedRepoError({
            message: `Repository ownership marker mismatch at ${managedPath}.`,
          })
        );
      }
    } else {
      const pathSegments = repo.id.startsWith("file://")
        ? yield* Effect.try({
            try: () => getFileManagedPathSegments(repo.id),
            catch: () =>
              new ManagedRepoError({ message: `Invalid repository identity: ${repo.id}` }),
          })
        : repo.id.split("/");
      const expected = yield* getManagedRepoPath(reposRoot, {
        kind: repo.id.startsWith("file://") ? "file" : "network",
        id: repo.id,
        name: repo.name,
        pathSegments,
        transportUrl: repo.remoteUrl,
      });
      if (
        (yield* getCanonicalPortablePathKey(managedPath)) !==
        (yield* getCanonicalPortablePathKey(expected))
      ) {
        return yield* Effect.fail(
          new ManagedRepoError({
            message: `Managed repository path does not match identity ${repo.id}: ${managedPath}`,
          })
        );
      }
      const refspec = yield* commandString(
        git("config", "--local", "--get-all", "remote.origin.fetch")
      );
      if (!["+refs/*:refs/*", "+refs/heads/*:refs/remotes/origin/*"].includes(refspec.trim())) {
        return yield* Effect.fail(
          new ManagedRepoError({
            message: `Cannot prove legacy mirror ownership at ${managedPath}.`,
          })
        );
      }
    }
    return managedPath;
  }).pipe(
    Effect.mapError(
      (error) =>
        new ManagedRepoError({
          message: `Cannot establish managed repository ownership: ${error.message}`,
          ...domainDetails(error),
        })
    )
  );
}

export function markManagedRepository(managedRepoPath: string, id: string) {
  return commandExitCode(
    gitCommand("--git-dir", managedRepoPath, "config", "--local", "outpost.repository-id", id)
  ).pipe(
    Effect.flatMap((status) =>
      status === 0
        ? Effect.void
        : Effect.fail(
            new ManagedRepoError({
              message: `Failed to mark repository ownership at ${managedRepoPath}.`,
            })
          )
    )
  );
}
