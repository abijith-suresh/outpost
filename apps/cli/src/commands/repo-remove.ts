import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { commandString, gitCommand } from "../child-process.js";
import {
  knownWorktreesRoots,
  loadConfig,
  loadRepoRegistry,
  resolveOutpostHome,
  writeRepoRegistry,
} from "../config.js";
import { domainDetails, ErrorDetailFields, reasonDetails } from "../error-details.js";
import { validateManagedRepoPath, verifyManagedRepository } from "../managed-repo.js";
import { acquireHomeMutationLock } from "../mutation-lock.js";
import { getCanonicalPortablePathKey, validateSemanticIdentifier } from "../path-safety.js";
import type { CommandOutput } from "../types.js";
import {
  listManifestTickets,
  readManifest,
  resolveManagedPath,
  scanWorktreesRoot,
} from "../workspace-manifest.js";

export class RepoRemoveError extends Schema.TaggedError<RepoRemoveError>()("RepoRemoveError", {
  ...ErrorDetailFields,
  message: Schema.String,
}) {}

export function runRepoRemove(
  repoId: string | undefined,
  extraArgs: ReadonlyArray<string>
): Effect.Effect<
  CommandOutput<"repo remove">,
  RepoRemoveError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  return Effect.gen(function* () {
    const dryRun = extraArgs.length === 1 && extraArgs[0] === "--dry-run";
    if (!repoId || (extraArgs.length > 0 && !dryRun)) {
      return yield* Effect.fail(
        new RepoRemoveError({
          ...reasonDetails("invalid-arguments"),
          message: "Usage: outpost repo remove <id> [--json]",
        })
      );
    }

    yield* validateSemanticIdentifier("repo id", repoId).pipe(
      Effect.mapError(
        (error) => new RepoRemoveError({ message: error.message, ...domainDetails(error) })
      )
    );

    const fs = yield* FileSystem.FileSystem;
    const outpostHome = yield* resolveOutpostHome();

    const config = yield* loadConfig(outpostHome).pipe(
      Effect.mapError(
        (error) => new RepoRemoveError({ message: error.message, ...domainDetails(error) })
      )
    );

    const mutation = dryRun
      ? undefined
      : yield* acquireHomeMutationLock(outpostHome, "repo remove").pipe(
          Effect.mapError(
            (error) => new RepoRemoveError({ message: error.message, ...domainDetails(error) })
          )
        );
    const registry = yield* loadRepoRegistry(outpostHome).pipe(
      Effect.mapError(
        (error) => new RepoRemoveError({ message: error.message, ...domainDetails(error) })
      )
    );

    const existingRepo = registry.repos.find((repo) => repo.id === repoId);

    if (!existingRepo) {
      return yield* Effect.fail(
        new RepoRemoveError({
          ...reasonDetails("repo-missing"),
          message: `Unknown repo id: ${repoId}`,
        })
      );
    }

    const tickets = yield* listManifestTickets(outpostHome).pipe(
      Effect.mapError(
        (error) => new RepoRemoveError({ message: error.message, ...domainDetails(error) })
      )
    );

    const referencingWorkspaces: Array<string> = [];
    const uninspectableManifests: Array<string> = [];

    for (const ticket of tickets) {
      const manifestResult = yield* readManifest(outpostHome, ticket).pipe(Effect.result);

      if (Result.isFailure(manifestResult)) {
        uninspectableManifests.push(ticket);
        continue;
      }

      const manifest = manifestResult.success;
      let isReferencing = false;

      for (const repo of manifest.repositories) {
        if (repo.id === existingRepo.id) {
          isReferencing = true;
          break;
        }

        const resolvedManagedPathResult = yield* Effect.result(
          resolveManagedPath(config.reposRoot, repo.managedPath)
        );

        if (Result.isSuccess(resolvedManagedPathResult)) {
          const manifestPathKey = yield* getCanonicalPortablePathKey(
            resolvedManagedPathResult.success
          );
          const repoPathKey = yield* getCanonicalPortablePathKey(existingRepo.managedRepoPath);

          if (manifestPathKey === repoPathKey) {
            isReferencing = true;
            break;
          }
        }
      }

      if (isReferencing) {
        referencingWorkspaces.push(ticket);
      }
    }

    if (uninspectableManifests.length > 0) {
      const manifestList = uninspectableManifests.map((t) => `"${t}"`).join(", ");
      return yield* Effect.fail(
        new RepoRemoveError({
          message: `Cannot remove repo ${existingRepo.id}: workspace manifest(s) for ${manifestList} could not be inspected and may still reference this repository`,
        })
      );
    }

    if (referencingWorkspaces.length > 0) {
      const wsList = referencingWorkspaces.map((t) => `"${t}"`).join(", ");
      return yield* Effect.fail(
        new RepoRemoveError({
          ...reasonDetails("repo-in-use"),
          message: `Cannot remove repo ${existingRepo.id}: referenced by workspace(s): ${wsList}`,
        })
      );
    }

    const unmanagedTickets = (yield* Effect.forEach(knownWorktreesRoots(config), (root) =>
      scanWorktreesRoot(root, outpostHome)
    ).pipe(
      Effect.mapError(
        (error) => new RepoRemoveError({ message: error.message, ...domainDetails(error) })
      )
    )).flat();

    const warnings =
      unmanagedTickets.length > 0
        ? [
            `${unmanagedTickets.length} unmanaged workspace(s) found under known workspace roots. Inspect them before cleanup; Git-linked worktrees still block repository removal.`,
          ]
        : [];
    const managedPath = yield* validateManagedRepoPath(config.reposRoot, existingRepo).pipe(
      Effect.mapError(
        (error) => new RepoRemoveError({ message: error.message, ...domainDetails(error) })
      )
    );
    const exists = yield* fs
      .exists(managedPath)
      .pipe(
        Effect.mapError(
          (error) => new RepoRemoveError({ message: error.message, ...domainDetails(error) })
        )
      );
    if (exists) {
      warnings.push(
        "Removing this managed repository deletes its local branches and any commits stored only here. Save needed branches and commits outside this mirror before repository cleanup."
      );
      yield* verifyManagedRepository(config.reposRoot, existingRepo).pipe(
        Effect.mapError(
          (error) => new RepoRemoveError({ message: error.message, ...domainDetails(error) })
        )
      );
      const worktrees = yield* commandString(
        gitCommand("--git-dir", managedPath, "worktree", "list", "--porcelain", "-z")
      ).pipe(
        Effect.mapError(
          (error) =>
            new RepoRemoveError({ message: `Cannot inspect Git worktrees: ${error.message}` })
        )
      );
      // The first record describes the bare repository itself. Any subsequent
      // record protects an actual link, even if its path or manifest is missing.
      if (worktrees.split("\0").filter((field) => field.startsWith("worktree ")).length > 1) {
        return yield* Effect.fail(
          new RepoRemoveError({
            ...reasonDetails("repo-in-use"),
            message: `Cannot remove repo ${existingRepo.id}: linked Git worktrees still exist. Inspect them with git worktree list before retrying.`,
          })
        );
      }
    }
    const data = {
      id: existingRepo.id,
      name: existingRepo.name,
      managedRepoPath: existingRepo.managedRepoPath,
      remoteUrl: existingRepo.remoteUrl,
      sourceRepoPath: existingRepo.sourceRepoPath,
      warnings,
    };
    if (dryRun)
      return {
        command: "repo remove",
        data: { ...data, dryRun: true },
      } satisfies CommandOutput<"repo remove">;
    if (!mutation)
      return yield* Effect.fail(new RepoRemoveError({ message: "Missing mutation lock" }));
    if (exists) {
      yield* mutation
        .record({
          action: "remove-repository",
          repoId: existingRepo.id,
          managedRepoPath: managedPath,
        })
        .pipe(
          Effect.mapError(
            (error) => new RepoRemoveError({ message: error.message, ...domainDetails(error) })
          )
        );
      yield* fs.remove(managedPath, { recursive: true }).pipe(
        Effect.mapError(
          (error) =>
            new RepoRemoveError({
              message: `Failed to remove repo directory: ${error.message}`,
            })
        )
      );
    }

    const nextRegistry = {
      ...registry,
      repos: registry.repos.filter((repo) => repo.id !== repoId),
    };

    yield* mutation
      .record({
        action: "unregister-repository",
        repoId: existingRepo.id,
        managedRepoPath: managedPath,
      })
      .pipe(
        Effect.mapError(
          (error) => new RepoRemoveError({ message: error.message, ...domainDetails(error) })
        )
      );
    yield* writeRepoRegistry(outpostHome, nextRegistry).pipe(
      Effect.mapError(
        (error) => new RepoRemoveError({ message: error.message, ...domainDetails(error) })
      )
    );

    return {
      command: "repo remove",
      data,
    } satisfies CommandOutput<"repo remove">;
  }).pipe(Effect.scoped);
}
