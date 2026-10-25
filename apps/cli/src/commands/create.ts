import { rmdir } from "node:fs/promises";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { type PlatformError, systemError } from "effect/PlatformError";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import { commandExitCode, commandString, gitCommand } from "../child-process.js";
import { parseCommandInput, requireCommand } from "../command-spec.js";
import type { RepoRecord } from "../config.js";
import {
  loadConfig,
  loadRepoRegistry,
  matchesTags,
  resolveOutpostHome,
  validateTag,
} from "../config.js";
import { domainDetails, ErrorDetailFields, reasonDetails } from "../error-details.js";
import { verifyManagedRepository } from "../managed-repo.js";
import { acquireHomeMutationLock } from "../mutation-lock.js";
import {
  getCanonicalPortablePathKey,
  resolvePathWithinRoot,
  validatePathSegment,
  validatePortableFilename,
  validateSemanticIdentifier,
  validateWorktreeGuidancePath,
} from "../path-safety.js";
import type { CommandOutput } from "../types.js";
import type { GeneratedAgentsFile } from "../workspace-agents.js";
import { deleteAgentsIfSnapshotMatches, generateAgentsMarkdown } from "../workspace-agents.js";
import type { Manifest, RepositoryEntry } from "../workspace-manifest.js";
import {
  acquireTicketLock,
  getWorkspaceStateRoot,
  manifestExists,
  releaseTicketLock,
  verifyWorktreeOwnership,
  writeManifest,
} from "../workspace-manifest.js";
import * as CreatePrompt from "./create-prompt.js";

export class CreateError extends Schema.TaggedError<CreateError>()("CreateError", {
  ...ErrorDetailFields,
  message: Schema.String,
}) {}

const createUsage =
  "Usage: outpost create --ticket <id> --type <branch-type> [--repo <id> ...] [--tag <tag> ...] [--base <branch>] [--dry-run]";

type CreateArgs = {
  ticket: string;
  type: string;
  repoIds: ReadonlyArray<string>;
  tags?: ReadonlyArray<string>;
  base?: string;
  dryRun: boolean;
};

type CreateArgsInput = {
  ticket?: string;
  type?: string;
  repoIds: ReadonlyArray<string>;
  tags?: ReadonlyArray<string>;
  base?: string;
  dryRun: boolean;
};

type CreatePlan = {
  repoId: string;
  repoName: string;
  managedRepoPath: string;
  remoteName: string;
  worktreePath: string;
  branch: string;
  base: string;
  startPoint: string;
};

type CreatedArtifacts = {
  branches: Array<CreatePlan>;
  worktrees: Array<CreatePlan>;
  ticketDirectory: boolean;
  committed: boolean;
  agents?: GeneratedAgentsFile;
};

function ensureUniqueWorktreePaths(
  plans: ReadonlyArray<CreatePlan>
): Effect.Effect<void, CreateError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const pathsByPortableKey = new Map<string, { worktreePath: string; repoIds: Array<string> }>();

    for (const plan of plans) {
      const portableKey = yield* getCanonicalPortablePathKey(plan.worktreePath);
      yield* validateWorktreeGuidancePath(path.dirname(plan.worktreePath), plan.worktreePath).pipe(
        Effect.mapError(
          (error) => new CreateError({ message: error.message, ...domainDetails(error) })
        )
      );
      const existing = pathsByPortableKey.get(portableKey);

      if (existing) {
        existing.repoIds.push(plan.repoId);
        continue;
      }

      pathsByPortableKey.set(portableKey, {
        worktreePath: plan.worktreePath,
        repoIds: [plan.repoId],
      });
    }

    for (const { worktreePath, repoIds } of pathsByPortableKey.values()) {
      if (repoIds.length > 1) {
        return yield* Effect.fail(
          new CreateError({
            message: `Selected repos would create the same portable worktree path: ${worktreePath} (repo ids: ${repoIds.join(", ")}).`,
          })
        );
      }
    }
  });
}

function usageError(details?: string): CreateError {
  return new CreateError({
    ...reasonDetails("invalid-arguments"),
    message: details ? `${createUsage}\n${details}` : createUsage,
  });
}

function parseCreateArgsInput(
  args: ReadonlyArray<string>
): Effect.Effect<CreateArgsInput, CreateError> {
  return Effect.try({
    try: () => {
      const parsed = parseCommandInput(requireCommand(["create"]), args, true);
      const value = (name: string): string | undefined => {
        const option = parsed.options[name];
        return Array.isArray(option) ? option[0] : undefined;
      };
      const repoOption = parsed.options["--repo"];
      const repoIds: readonly string[] = Array.isArray(repoOption) ? repoOption : [];
      if (new Set(repoIds).size !== repoIds.length)
        throw new Error(
          `--repo may not be repeated with the same id: ${repoIds.find((id, index) => repoIds.indexOf(id) !== index)}.`
        );
      return {
        ticket: value("--ticket"),
        type: value("--type"),
        base: value("--base"),
        repoIds,
        tags: Array.isArray(parsed.options["--tag"]) ? parsed.options["--tag"] : [],
        dryRun: parsed.options["--dry-run"] === true,
      };
    },
    catch: (error) => usageError(error instanceof Error ? error.message : String(error)),
  });
}

function requireCreateArgs(parsedArgs: CreateArgsInput): Effect.Effect<CreateArgs, CreateError> {
  const missing: Array<string> = [];

  if (!parsedArgs.ticket) {
    missing.push("--ticket is required.");
  }

  if (!parsedArgs.type) {
    missing.push("--type is required.");
  }

  if (parsedArgs.repoIds.length === 0) {
    missing.push("At least one --repo or --tag is required.");
  }

  if (missing.length > 0) {
    return Effect.fail(usageError(missing.join("\n")));
  }

  return Effect.succeed({
    ticket: parsedArgs.ticket as string,
    type: parsedArgs.type as string,
    repoIds: parsedArgs.repoIds,
    tags: parsedArgs.tags,
    base: parsedArgs.base,
    dryRun: parsedArgs.dryRun,
  });
}

function validateBranchName(
  branchName: string
): Effect.Effect<void, CreateError, ChildProcessSpawner.ChildProcessSpawner> {
  return commandExitCode(gitCommand("check-ref-format", "--branch", branchName)).pipe(
    Effect.mapError(
      (error) => new CreateError({ message: error.message, ...domainDetails(error) })
    ),
    Effect.flatMap((exitCode) =>
      exitCode === 0
        ? Effect.void
        : Effect.fail(
            new CreateError({
              ...reasonDetails("invalid-arguments"),
              message: `Invalid create branch name: ${branchName}`,
            })
          )
    )
  );
}

function validateCreateArgs(parsedArgs: CreateArgsInput): Effect.Effect<void, CreateError> {
  return Effect.gen(function* () {
    if (parsedArgs.ticket !== undefined) {
      yield* validateSemanticIdentifier("--ticket", parsedArgs.ticket).pipe(
        Effect.mapError(
          (error) => new CreateError({ message: error.message, ...domainDetails(error) })
        )
      );
      yield* validatePathSegment("--ticket", parsedArgs.ticket, {
        allowTraversalSegments: true,
      }).pipe(
        Effect.mapError(
          (error) => new CreateError({ message: error.message, ...domainDetails(error) })
        )
      );
    }

    if (parsedArgs.type !== undefined) {
      yield* validateSemanticIdentifier("--type", parsedArgs.type).pipe(
        Effect.mapError(
          (error) => new CreateError({ message: error.message, ...domainDetails(error) })
        )
      );
      yield* validatePathSegment("--type", parsedArgs.type, {
        allowTraversalSegments: true,
      }).pipe(
        Effect.mapError(
          (error) => new CreateError({ message: error.message, ...domainDetails(error) })
        )
      );
    }

    for (const repoId of parsedArgs.repoIds) {
      yield* validateSemanticIdentifier("--repo", repoId).pipe(
        Effect.mapError(
          (error) => new CreateError({ message: error.message, ...domainDetails(error) })
        )
      );
    }

    if (parsedArgs.base !== undefined) {
      yield* validateSemanticIdentifier("--base", parsedArgs.base).pipe(
        Effect.mapError(
          (error) => new CreateError({ message: error.message, ...domainDetails(error) })
        )
      );
    }
  });
}

function hasMissingCreateArgs(parsedArgs: CreateArgsInput): boolean {
  return !parsedArgs.ticket || !parsedArgs.type || parsedArgs.repoIds.length === 0;
}

function resolveCreateArgs(
  parsedArgs: CreateArgsInput,
  options: {
    interactive: boolean;
    availableRepos: ReadonlyArray<CreatePrompt.CreatePromptRepoOption>;
  }
): Effect.Effect<CreateArgs, CreateError> {
  return Effect.gen(function* () {
    if (!hasMissingCreateArgs(parsedArgs) || !options.interactive) {
      return yield* requireCreateArgs(parsedArgs);
    }

    if (parsedArgs.repoIds.length === 0 && options.availableRepos.length === 0) {
      return yield* Effect.fail(
        new CreateError({
          message: "No repos are available. Run `outpost repo add <path>` first.",
        })
      );
    }

    const promptedArgs = yield* Effect.tryPromise({
      try: () =>
        CreatePrompt.promptForMissingCreateArgs({
          ticket: parsedArgs.ticket,
          type: parsedArgs.type,
          repoIds: parsedArgs.repoIds,
          base: parsedArgs.base,
          availableRepos: options.availableRepos,
        }),
      catch: (error) =>
        new CreateError({
          message: error instanceof Error ? error.message : String(error),
        }),
    });

    return yield* requireCreateArgs({
      ...promptedArgs,
      dryRun: parsedArgs.dryRun,
    });
  });
}

function getSelectedRepos(
  registryRepos: ReadonlyArray<RepoRecord>,
  repoIds: ReadonlyArray<string>
): Effect.Effect<ReadonlyArray<RepoRecord>, CreateError> {
  const unknownRepoIds = repoIds.filter(
    (repoId) => !registryRepos.some((repo) => repo.id === repoId)
  );

  if (unknownRepoIds.length > 0) {
    return Effect.fail(
      new CreateError({
        ...reasonDetails("repo-missing"),
        message:
          unknownRepoIds.length === 1
            ? `Unknown repo id: ${unknownRepoIds[0]}`
            : `Unknown repo ids: ${unknownRepoIds.join(", ")}`,
      })
    );
  }

  const duplicateRepoIds = repoIds.filter(
    (repoId) => registryRepos.filter((repo) => repo.id === repoId).length > 1
  );

  if (duplicateRepoIds.length > 0) {
    return Effect.fail(
      new CreateError({
        message: `Duplicate repo id in registry: ${duplicateRepoIds[0]}`,
      })
    );
  }

  return Effect.succeed(
    repoIds.map((repoId) => registryRepos.find((repo) => repo.id === repoId) as RepoRecord)
  ).pipe(
    Effect.flatMap((selectedRepos) => {
      const repoIdsByName = new Map<string, Array<string>>();

      for (const repo of selectedRepos) {
        const ids = repoIdsByName.get(repo.name) ?? [];
        ids.push(repo.id);
        repoIdsByName.set(repo.name, ids);
      }

      const duplicateName = [...repoIdsByName.entries()].find(([, ids]) => ids.length > 1);

      return duplicateName
        ? Effect.fail(
            new CreateError({
              message: `Selected repos share the same name ${duplicateName[0]}: ${duplicateName[1].join(", ")}.`,
            })
          )
        : Effect.succeed(selectedRepos);
    })
  );
}

function resolveRemoteHeadBaseBranch(
  repo: RepoRecord
): Effect.Effect<string, PlatformError, ChildProcessSpawner.ChildProcessSpawner> {
  return commandString(
    gitCommand("--git-dir", repo.managedRepoPath, "symbolic-ref", "--short", "HEAD")
  ).pipe(
    Effect.map((output) => output.trim()),
    Effect.flatMap((headRef) => {
      return headRef.length > 0
        ? Effect.succeed(headRef)
        : Effect.fail(
            systemError({
              _tag: "Unknown",
              module: "ChildProcess",
              method: "symbolic-ref",
              description: `Unexpected mirror HEAD ref ${headRef} for ${repo.id}`,
            })
          );
    })
  );
}

function localBranchExists(
  repo: RepoRecord,
  branchName: string
): Effect.Effect<boolean, PlatformError, ChildProcessSpawner.ChildProcessSpawner> {
  return commandExitCode(
    gitCommand(
      "--git-dir",
      repo.managedRepoPath,
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${branchName}`
    )
  ).pipe(Effect.map((exitCode) => exitCode === 0));
}

function buildCreatePlan(
  repo: RepoRecord,
  ticketDirectory: string,
  branchName: string,
  base: string | undefined
): Effect.Effect<CreatePlan, CreateError, Path.Path | ChildProcessSpawner.ChildProcessSpawner> {
  return Effect.gen(function* () {
    const baseBranch = yield* base
      ? Effect.succeed(base)
      : resolveRemoteHeadBaseBranch(repo).pipe(
          Effect.mapError(
            (error) =>
              new CreateError({
                message: `Failed to resolve default base branch for repo ${repo.id}: ${error.message}`,
              })
          )
        );
    const remoteRef = `refs/remotes/origin/${baseBranch}`;
    const remoteExists = yield* commandExitCode(
      gitCommand("--git-dir", repo.managedRepoPath, "show-ref", "--verify", "--quiet", remoteRef)
    ).pipe(
      Effect.mapError(
        (error) => new CreateError({ message: error.message, ...domainDetails(error) })
      )
    );
    const localExists = yield* localBranchExists(repo, baseBranch).pipe(
      Effect.mapError(
        (error) => new CreateError({ message: error.message, ...domainDetails(error) })
      )
    );

    if (remoteExists !== 0 && !localExists) {
      return yield* Effect.fail(
        new CreateError({
          message: `Base branch ${baseBranch} not found for repo ${repo.id}.`,
        })
      );
    }

    const branchExists = yield* localBranchExists(repo, branchName).pipe(
      Effect.mapError(
        (error) => new CreateError({ message: error.message, ...domainDetails(error) })
      )
    );

    if (branchExists) {
      return yield* Effect.fail(
        new CreateError({
          message: `Branch ${branchName} already exists for repo ${repo.id}.`,
        })
      );
    }

    const worktreePath = yield* resolvePathWithinRoot(ticketDirectory, repo.name).pipe(
      Effect.mapError(
        (error) => new CreateError({ message: error.message, ...domainDetails(error) })
      )
    );

    return {
      repoId: repo.id,
      repoName: repo.name,
      managedRepoPath: repo.managedRepoPath,
      remoteName: repo.remoteName,
      worktreePath,
      branch: branchName,
      base: baseBranch,
      startPoint: (yield* commandString(
        gitCommand(
          "--git-dir",
          repo.managedRepoPath,
          "rev-parse",
          "--verify",
          `${remoteExists === 0 ? remoteRef : `refs/heads/${baseBranch}`}^{commit}`
        )
      ).pipe(
        Effect.mapError(
          (error) => new CreateError({ message: error.message, ...domainDetails(error) })
        )
      )).trim(),
    } satisfies CreatePlan;
  });
}

function createBranch(
  plan: CreatePlan
): Effect.Effect<void, CreateError, ChildProcessSpawner.ChildProcessSpawner> {
  return commandExitCode(
    gitCommand("--git-dir", plan.managedRepoPath, "branch", plan.branch, plan.startPoint)
  ).pipe(
    Effect.mapError(
      (error) => new CreateError({ message: error.message, ...domainDetails(error) })
    ),
    Effect.flatMap((exitCode) =>
      exitCode === 0
        ? Effect.void
        : Effect.fail(
            new CreateError({
              message: `Failed to create branch ${plan.branch} for repo ${plan.repoId}.`,
            })
          )
    )
  );
}

function createWorktree(
  plan: CreatePlan
): Effect.Effect<void, CreateError, ChildProcessSpawner.ChildProcessSpawner> {
  return commandExitCode(
    gitCommand("--git-dir", plan.managedRepoPath, "worktree", "add", plan.worktreePath, plan.branch)
  ).pipe(
    Effect.mapError(
      (error) => new CreateError({ message: error.message, ...domainDetails(error) })
    ),
    Effect.flatMap((exitCode) =>
      exitCode === 0
        ? Effect.void
        : Effect.fail(
            new CreateError({
              message: `Failed to create worktree for repo ${plan.repoId}.`,
            })
          )
    )
  );
}

function checkPortableTicketCollision(
  outpostHome: string,
  ticket: string
): Effect.Effect<void, CreateError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const stateRoot = yield* getWorkspaceStateRoot(outpostHome);
    const stateRootExists = yield* fs
      .exists(stateRoot)
      .pipe(
        Effect.mapError(
          (error) => new CreateError({ message: error.message, ...domainDetails(error) })
        )
      );

    if (!stateRootExists) {
      return;
    }

    const entries = yield* fs
      .readDirectory(stateRoot)
      .pipe(
        Effect.mapError(
          (error) => new CreateError({ message: error.message, ...domainDetails(error) })
        )
      );
    const manifestFiles = entries.filter((entry) => entry.endsWith(".json"));
    const targetFilePath = path.join(stateRoot, `${ticket}.json`);
    const targetKey = yield* getCanonicalPortablePathKey(targetFilePath);

    for (const file of manifestFiles) {
      const candidatePath = path.join(stateRoot, file);
      const candidateKey = yield* getCanonicalPortablePathKey(candidatePath);

      if (candidateKey === targetKey) {
        return yield* Effect.fail(
          new CreateError({
            message: `Ticket identity collision detected for ${ticket}: manifest ${file} has the same canonical path identity`,
          })
        );
      }
    }
  });
}

function rollbackCreatedArtifacts(
  created: CreatedArtifacts,
  ticketDirectory: string,
  originalError: CreateError
): Effect.Effect<
  never,
  CreateError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const cleanupErrors: Array<string> = [];

    for (const plan of [...created.worktrees].reverse()) {
      const exists = yield* fs.exists(plan.worktreePath).pipe(Effect.orElseSucceed(() => true));
      if (!exists) continue;
      const owned = yield* verifyWorktreeOwnership(plan.worktreePath, plan.managedRepoPath).pipe(
        Effect.orElseSucceed(() => false)
      );
      if (!owned) {
        cleanupErrors.push(`Preserved unowned residual path ${plan.worktreePath}`);
        continue;
      }
      const branch = yield* commandString(
        gitCommand("-C", plan.worktreePath, "symbolic-ref", "--quiet", "HEAD")
      ).pipe(Effect.result);
      if (branch._tag === "Failure" || branch.success.trim() !== `refs/heads/${plan.branch}`) {
        cleanupErrors.push(
          `Preserved worktree ${plan.worktreePath}: branch changed or could not be inspected`
        );
        continue;
      }
      const head = yield* commandString(
        gitCommand("-C", plan.worktreePath, "rev-parse", "--verify", "HEAD^{commit}")
      ).pipe(Effect.result);
      if (head._tag === "Failure" || head.success.trim() !== plan.startPoint) {
        cleanupErrors.push(
          `Preserved worktree ${plan.worktreePath}: HEAD changed or could not be inspected`
        );
        continue;
      }
      // No force: new untracked files or agent edits must survive rollback.
      yield* commandExitCode(
        gitCommand("--git-dir", plan.managedRepoPath, "worktree", "remove", plan.worktreePath)
      ).pipe(
        Effect.flatMap((exitCode) =>
          exitCode === 0
            ? Effect.void
            : Effect.fail(
                `git worktree remove exited with status ${exitCode}; residual worktree preserved`
              )
        ),
        Effect.mapError((error) => (typeof error === "string" ? error : error.message)),
        Effect.catch((message) =>
          Effect.sync(() => {
            cleanupErrors.push(`Failed to remove worktree ${plan.worktreePath}: ${message}`);
          })
        )
      );
    }

    for (const plan of [...created.branches].reverse()) {
      yield* Effect.gen(function* () {
        const ref = `refs/heads/${plan.branch}`;
        const exists = yield* commandExitCode(
          gitCommand("--git-dir", plan.managedRepoPath, "show-ref", "--verify", "--quiet", ref)
        );
        if (exists === 1) return;
        if (exists !== 0) return yield* Effect.fail(`Cannot inspect branch ${plan.branch}`);
        const worktrees = yield* commandString(
          gitCommand("--git-dir", plan.managedRepoPath, "worktree", "list", "--porcelain", "-z")
        );
        if (worktrees.split("\0").includes(`branch ${ref}`)) {
          return yield* Effect.fail(
            `Preserved branch ${plan.branch}: it is still linked to a worktree`
          );
        }
        // Compare-and-delete refuses a branch advanced after creation. The
        // immutable starting commit is recorded before the branch mutation.
        const status = yield* commandExitCode(
          gitCommand("--git-dir", plan.managedRepoPath, "update-ref", "-d", ref, plan.startPoint)
        );
        if (status !== 0)
          return yield* Effect.fail(
            `Preserved branch ${plan.branch}: its commit changed or deletion failed`
          );
      }).pipe(
        Effect.mapError((error) => (typeof error === "string" ? error : error.message)),
        Effect.catch((message) =>
          Effect.sync(() => {
            cleanupErrors.push(message);
          })
        )
      );
    }

    if (created.agents) {
      const agents = created.agents;
      yield* deleteAgentsIfSnapshotMatches(agents.filePath, agents.snapshot).pipe(
        Effect.mapError((error) => error.message),
        Effect.flatMap((result) => {
          if (result === "mismatch") {
            cleanupErrors.push(
              `Preserved AGENTS.md at ${agents.filePath} because it changed during rollback`
            );
          }
          return Effect.void;
        }),
        Effect.catch((message) => {
          cleanupErrors.push(`Failed to delete AGENTS.md: ${message}`);
          return Effect.void;
        })
      );
    }

    if (created.ticketDirectory) {
      const entries = yield* fs.readDirectory(ticketDirectory).pipe(
        Effect.mapError((error) => error.message),
        Effect.catch((message) => {
          cleanupErrors.push(`Failed to inspect ticket directory ${ticketDirectory}: ${message}`);
          return Effect.succeed(undefined);
        })
      );

      if (entries?.length === 0) {
        yield* Effect.tryPromise({
          try: () => rmdir(ticketDirectory),
          catch: (error) => (error instanceof Error ? error.message : String(error)),
        }).pipe(
          Effect.catch((message) => {
            cleanupErrors.push(`Failed to remove ticket directory ${ticketDirectory}: ${message}`);
            return Effect.void;
          })
        );
      }
    }

    const message =
      cleanupErrors.length > 0
        ? `${originalError.message}\nRollback errors: ${cleanupErrors.join("; ")}`
        : originalError.message;

    return yield* Effect.fail(new CreateError({ message }));
  });
}

function prepareCreate(
  outpostHome: string,
  ticket: string,
  ticketDirectory: string,
  selectedRepos: ReadonlyArray<RepoRecord>,
  branchName: string,
  base: string | undefined
): Effect.Effect<
  ReadonlyArray<CreatePlan>,
  CreateError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const hasManifest = yield* manifestExists(outpostHome, ticket).pipe(
      Effect.mapError(
        (error) => new CreateError({ message: error.message, ...domainDetails(error) })
      )
    );

    if (hasManifest) {
      return yield* Effect.fail(
        new CreateError({
          message: `A workspace manifest already exists for ticket ${ticket}`,
        })
      );
    }

    yield* checkPortableTicketCollision(outpostHome, ticket);

    const ticketDirectoryExists = yield* fs
      .exists(ticketDirectory)
      .pipe(
        Effect.mapError(
          (error) => new CreateError({ message: error.message, ...domainDetails(error) })
        )
      );

    if (ticketDirectoryExists) {
      return yield* Effect.fail(
        new CreateError({
          message: `A workspace already exists for ticket ${ticket}: ${ticketDirectory}\nRemove that workspace directory or choose a different ticket.`,
        })
      );
    }

    const config = yield* loadConfig(outpostHome).pipe(
      Effect.mapError(
        (error) => new CreateError({ message: error.message, ...domainDetails(error) })
      )
    );
    yield* Effect.forEach(selectedRepos, (repo) =>
      verifyManagedRepository(config.reposRoot, repo).pipe(
        Effect.mapError(
          (error) => new CreateError({ message: error.message, ...domainDetails(error) })
        )
      )
    );
    const plans = yield* Effect.forEach(selectedRepos, (repo) =>
      buildCreatePlan(repo, ticketDirectory, branchName, base)
    );

    yield* ensureUniqueWorktreePaths(plans);
    return plans;
  });
}

export function runCreate(
  args: ReadonlyArray<string>,
  options: { interactive: boolean }
): Effect.Effect<
  CommandOutput<"create">,
  CreateError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    let parsedArgsInput = yield* parseCreateArgsInput(args);

    const outpostHome = yield* resolveOutpostHome();
    const tagOnly = !!parsedArgsInput.tags?.length && !parsedArgsInput.repoIds.length;
    // Resolve tag-only input for prompt handling; selection is repeated under the mutation lock.
    if (parsedArgsInput.tags?.length && !parsedArgsInput.repoIds.length) {
      for (const tag of parsedArgsInput.tags)
        yield* validateTag(tag).pipe(Effect.mapError((error) => usageError(error.message)));
      const registry = yield* loadRepoRegistry(outpostHome).pipe(
        Effect.mapError((error) => usageError(error.message))
      );
      const repoIds = registry.repos
        .filter((repo) => matchesTags(repo, parsedArgsInput.tags ?? []))
        .map((repo) => repo.id);
      if (!repoIds.length)
        return yield* Effect.fail(usageError("No repositories match all selected tags."));
      parsedArgsInput = { ...parsedArgsInput, repoIds };
    }

    let parsedArgs: CreateArgs;

    if (!hasMissingCreateArgs(parsedArgsInput)) {
      yield* validateCreateArgs(parsedArgsInput);
      parsedArgs = yield* requireCreateArgs(parsedArgsInput);
    } else {
      if (!options.interactive) {
        yield* requireCreateArgs(parsedArgsInput);
      }

      yield* validateCreateArgs(parsedArgsInput);
      const earlyRegistry = yield* loadRepoRegistry(outpostHome).pipe(
        Effect.mapError(
          (error) => new CreateError({ message: error.message, ...domainDetails(error) })
        )
      );
      parsedArgs = yield* resolveCreateArgs(parsedArgsInput, {
        interactive: options.interactive,
        availableRepos: earlyRegistry.repos.map((repo) => ({
          id: repo.id,
          name: repo.name,
        })),
      });
      yield* validateCreateArgs(parsedArgs);
    }

    const branchName = `${parsedArgs.type}/${parsedArgs.ticket}`;
    yield* validateBranchName(branchName);

    const mutation = parsedArgs.dryRun
      ? undefined
      : yield* acquireHomeMutationLock(outpostHome, "create").pipe(
          Effect.mapError(
            (error) => new CreateError({ message: error.message, ...domainDetails(error) })
          )
        );
    const config = yield* loadConfig(outpostHome).pipe(
      Effect.mapError(
        (error) => new CreateError({ message: error.message, ...domainDetails(error) })
      )
    );
    const record = (step: Record<string, unknown>) =>
      (mutation?.record(step) ?? Effect.void).pipe(
        Effect.mapError(
          (error) => new CreateError({ message: error.message, ...domainDetails(error) })
        )
      );
    const registry = yield* loadRepoRegistry(outpostHome).pipe(
      Effect.mapError(
        (error) => new CreateError({ message: error.message, ...domainDetails(error) })
      )
    );
    for (const tag of parsedArgs.tags ?? [])
      yield* validateTag(tag).pipe(Effect.mapError((error) => usageError(error.message)));
    const selectedRepos = (yield* getSelectedRepos(
      registry.repos,
      tagOnly
        ? registry.repos
            .filter((repo) => matchesTags(repo, parsedArgs.tags ?? []))
            .map((repo) => repo.id)
        : parsedArgs.repoIds
    )).filter((repo) => matchesTags(repo, parsedArgs.tags ?? []));
    if (!selectedRepos.length)
      return yield* Effect.fail(usageError("No repositories match all selected tags."));
    yield* validatePortableFilename("--ticket", parsedArgs.ticket).pipe(
      Effect.mapError((error) => usageError(error.message))
    );

    const workspacePath = parsedArgs.ticket;
    const ticketDirectory = yield* resolvePathWithinRoot(config.worktreesRoot, workspacePath).pipe(
      Effect.mapError(
        (error) => new CreateError({ message: error.message, ...domainDetails(error) })
      )
    );

    for (const repo of selectedRepos) {
      yield* validateWorktreeGuidancePath(ticketDirectory, `${ticketDirectory}/${repo.name}`).pipe(
        Effect.mapError((error) => usageError(error.message))
      );
      yield* validatePortableFilename("repository folder", repo.name).pipe(
        Effect.mapError((error) => usageError(error.message))
      );
    }

    if (parsedArgs.dryRun) {
      const plans = yield* prepareCreate(
        outpostHome,
        parsedArgs.ticket,
        ticketDirectory,
        selectedRepos,
        branchName,
        parsedArgs.base
      );

      return {
        command: "create",
        data: {
          ticket: parsedArgs.ticket,
          ticketDirectory,
          type: parsedArgs.type,
          branch: branchName,
          dryRun: true,
          worktrees: plans.map((plan) => ({
            repoId: plan.repoId,
            repoName: plan.repoName,
            path: plan.worktreePath,
            branch: plan.branch,
            base: plan.base,
          })),
        },
      } satisfies CommandOutput<"create">;
    }

    yield* Effect.acquireRelease(
      acquireTicketLock(outpostHome, parsedArgs.ticket).pipe(
        Effect.mapError(
          (error) => new CreateError({ message: error.message, ...domainDetails(error) })
        )
      ),
      () => releaseTicketLock(outpostHome, parsedArgs.ticket).pipe(Effect.ignore)
    );

    const result = yield* Effect.gen(function* () {
      const plans = yield* prepareCreate(
        outpostHome,
        parsedArgs.ticket,
        ticketDirectory,
        selectedRepos,
        branchName,
        parsedArgs.base
      );
      const created: CreatedArtifacts = {
        branches: [],
        worktrees: [],
        ticketDirectory: false,
        committed: false,
      };

      yield* record({
        action: "create-workspace",
        ticket: parsedArgs.ticket,
        ticketDirectory,
        plans,
      });
      return yield* Effect.gen(function* () {
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            yield* fs
              .makeDirectory(config.worktreesRoot, { recursive: true })
              .pipe(
                Effect.mapError(
                  (error) => new CreateError({ message: error.message, ...domainDetails(error) })
                )
              );
            yield* fs
              .makeDirectory(ticketDirectory)
              .pipe(
                Effect.mapError(
                  (error) => new CreateError({ message: error.message, ...domainDetails(error) })
                )
              );
            created.ticketDirectory = true;
          })
        );

        for (const plan of plans) {
          yield* record({ action: "create-branch", phase: "intent", ...plan });
          yield* Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              // Git remains interruptible. Only a successful result confirms
              // that this operation created the artifact; intent is not proof.
              yield* restore(createBranch(plan));
              created.branches.push(plan);
            })
          );
          yield* record({ action: "create-branch", phase: "confirmed", ...plan });
          yield* record({ action: "create-worktree", phase: "intent", ...plan });
          yield* Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              yield* restore(createWorktree(plan));
              created.worktrees.push(plan);
            })
          );
          yield* record({ action: "create-worktree", phase: "confirmed", ...plan });
        }

        const pathModule = yield* Path.Path;
        const repositoryEntries: ReadonlyArray<RepositoryEntry> = yield* Effect.forEach(
          selectedRepos,
          (repo, index) => {
            const plan = plans[index];
            return Effect.succeed({
              id: repo.id,
              name: repo.name,
              base: plan.base,
              managedPath: pathModule.relative(config.reposRoot, repo.managedRepoPath),
              worktreePath: pathModule.relative(ticketDirectory, plan.worktreePath),
            } satisfies RepositoryEntry);
          },
          { concurrency: 1 }
        );

        const manifest: Manifest = {
          ...(config.version === 2
            ? { version: 2 as const, worktreesRoot: config.worktreesRoot }
            : {}),
          ticket: parsedArgs.ticket,
          type: parsedArgs.type,
          branch: branchName,
          createdAt: new Date().toISOString(),
          workspacePath,
          repositories: [...repositoryEntries],
        };

        yield* record({
          action: "generate-guidance",
          filePath: pathModule.join(ticketDirectory, "AGENTS.md"),
        });
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            created.agents = yield* generateAgentsMarkdown(outpostHome, manifest).pipe(
              Effect.mapError(
                (error) => new CreateError({ message: error.message, ...domainDetails(error) })
              )
            );
          })
        );

        yield* record({ action: "write-workspace-manifest", ticket: parsedArgs.ticket, manifest });
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            yield* writeManifest(outpostHome, manifest).pipe(
              Effect.mapError(
                (error) => new CreateError({ message: error.message, ...domainDetails(error) })
              )
            );
            created.committed = true;
          })
        );

        return {
          command: "create",
          data: {
            ticket: parsedArgs.ticket,
            ticketDirectory,
            type: parsedArgs.type,
            branch: branchName,
            dryRun: false,
            workspacePath,
            worktrees: plans.map((plan) => ({
              repoId: plan.repoId,
              repoName: plan.repoName,
              path: plan.worktreePath,
              branch: plan.branch,
              base: plan.base,
            })),
          },
        } satisfies CommandOutput<"create">;
      }).pipe(
        Effect.onInterrupt(() =>
          created.committed
            ? Effect.void
            : rollbackCreatedArtifacts(
                created,
                ticketDirectory,
                new CreateError({ message: "Workspace creation interrupted" })
              ).pipe(Effect.ignore)
        ),
        Effect.catch((error) =>
          Effect.uninterruptible(rollbackCreatedArtifacts(created, ticketDirectory, error))
        )
      );
    });

    return result;
  }).pipe(Effect.scoped);
}
