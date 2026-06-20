import { rmdir } from "node:fs/promises";

import * as Command from "@effect/platform/Command";
import type * as CommandExecutor from "@effect/platform/CommandExecutor";
import * as FileSystem from "@effect/platform/FileSystem";
import type { PlatformError } from "@effect/platform/Error";
import * as Path from "@effect/platform/Path";
import { Effect, Schema } from "effect";

import * as CreatePrompt from "./create-prompt.js";
import { loadConfig, loadRepoRegistry, resolveOutpostHome } from "../config.js";
import type { RepoRecord } from "../config.js";
import {
  getCanonicalPortablePathKey,
  resolvePathWithinRoot,
  validatePathSegment,
} from "../path-safety.js";
import type { CommandOutput } from "../types.js";
import {
  acquireTicketLock,
  getWorkspaceStateRoot,
  manifestExists,
  releaseTicketLock,
  writeManifest,
} from "../workspace-manifest.js";
import type { Manifest, RepositoryEntry } from "../workspace-manifest.js";
import {
  deleteAgentsIfExists,
  generateAgentsMarkdown,
} from "../workspace-agents.js";

export class CreateError extends Schema.TaggedError<CreateError>()(
  "CreateError",
  {
    message: Schema.String,
  },
) {}

const createUsage =
  "Usage: outpost create --ticket <id> --type <branch-type> --repo <id> [--repo <id> ...] [--base <branch>] [--dry-run]";

type CreateArgs = {
  ticket: string;
  type: string;
  repoIds: ReadonlyArray<string>;
  base?: string;
  dryRun: boolean;
};

type CreateArgsInput = {
  ticket?: string;
  type?: string;
  repoIds: ReadonlyArray<string>;
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
  agentsGenerated: boolean;
};

function ensureUniqueWorktreePaths(
  plans: ReadonlyArray<CreatePlan>,
): Effect.Effect<void, CreateError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const pathsByPortableKey = new Map<
      string,
      { worktreePath: string; repoIds: Array<string> }
    >();

    for (const plan of plans) {
      const portableKey = yield* getCanonicalPortablePathKey(plan.worktreePath);
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
          }),
        );
      }
    }
  });
}

function gitCommand(...args: ReadonlyArray<string>) {
  return Command.make("git", ...args).pipe(
    Command.env({
      GCM_INTERACTIVE: "never",
      GIT_TERMINAL_PROMPT: "0",
    }),
  );
}

function usageError(details?: string): CreateError {
  return new CreateError({
    message: details ? `${createUsage}\n${details}` : createUsage,
  });
}

function parseCreateArgsInput(
  args: ReadonlyArray<string>,
): Effect.Effect<CreateArgsInput, CreateError> {
  let ticket: string | undefined;
  let type: string | undefined;
  let base: string | undefined;
  let dryRun = false;
  const repoIds: Array<string> = [];

  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    const value = args[index + 1];

    if (arg === "--ticket") {
      if (ticket) {
        return Effect.fail(usageError("--ticket may only be provided once."));
      }

      if (!value || value.startsWith("--")) {
        return Effect.fail(usageError("--ticket requires a value."));
      }

      ticket = value;
      index += 2;
      continue;
    }

    if (arg === "--type") {
      if (type) {
        return Effect.fail(usageError("--type may only be provided once."));
      }

      if (!value || value.startsWith("--")) {
        return Effect.fail(usageError("--type requires a value."));
      }

      type = value;
      index += 2;
      continue;
    }

    if (arg === "--repo") {
      if (!value || value.startsWith("--")) {
        return Effect.fail(usageError("--repo requires a value."));
      }

      if (repoIds.includes(value)) {
        return Effect.fail(
          usageError(`--repo may not be repeated with the same id: ${value}.`),
        );
      }

      repoIds.push(value);
      index += 2;
      continue;
    }

    if (arg === "--base") {
      if (base) {
        return Effect.fail(usageError("--base may only be provided once."));
      }

      if (!value || value.startsWith("--")) {
        return Effect.fail(usageError("--base requires a value."));
      }

      base = value;
      index += 2;
      continue;
    }

    if (arg === "--dry-run") {
      if (dryRun) {
        return Effect.fail(usageError("--dry-run may only be provided once."));
      }

      dryRun = true;
      index += 1;
      continue;
    }

    return Effect.fail(usageError(`Unknown option: ${arg}`));
  }

  return Effect.succeed({
    ticket,
    type,
    repoIds,
    base,
    dryRun,
  } satisfies CreateArgsInput);
}

function requireCreateArgs(
  parsedArgs: CreateArgsInput,
): Effect.Effect<CreateArgs, CreateError> {
  const missing: Array<string> = [];

  if (!parsedArgs.ticket) {
    missing.push("--ticket is required.");
  }

  if (!parsedArgs.type) {
    missing.push("--type is required.");
  }

  if (parsedArgs.repoIds.length === 0) {
    missing.push("At least one --repo is required.");
  }

  if (missing.length > 0) {
    return Effect.fail(usageError(missing.join("\n")));
  }

  return Effect.succeed({
    ticket: parsedArgs.ticket as string,
    type: parsedArgs.type as string,
    repoIds: parsedArgs.repoIds,
    base: parsedArgs.base,
    dryRun: parsedArgs.dryRun,
  });
}

function validateBranchName(
  branchName: string,
): Effect.Effect<void, CreateError, CommandExecutor.CommandExecutor> {
  return Command.exitCode(
    gitCommand("check-ref-format", "--branch", branchName),
  ).pipe(
    Effect.mapError((error) => new CreateError({ message: error.message })),
    Effect.flatMap((exitCode) =>
      exitCode === 0
        ? Effect.void
        : Effect.fail(
            new CreateError({
              message: `Invalid create branch name: ${branchName}`,
            }),
          ),
    ),
  );
}

function validateCreatePathArgs(
  parsedArgs: CreateArgs,
): Effect.Effect<void, CreateError> {
  return Effect.gen(function* () {
    yield* validatePathSegment("--ticket", parsedArgs.ticket, {
      allowTraversalSegments: true,
    }).pipe(
      Effect.mapError((error) => new CreateError({ message: error.message })),
    );
    yield* validatePathSegment("--type", parsedArgs.type, {
      allowTraversalSegments: true,
    }).pipe(
      Effect.mapError((error) => new CreateError({ message: error.message })),
    );
  });
}

function hasMissingCreateArgs(parsedArgs: CreateArgsInput): boolean {
  return (
    !parsedArgs.ticket || !parsedArgs.type || parsedArgs.repoIds.length === 0
  );
}

function resolveCreateArgs(
  parsedArgs: CreateArgsInput,
  options: {
    interactive: boolean;
    availableRepos: ReadonlyArray<CreatePrompt.CreatePromptRepoOption>;
  },
): Effect.Effect<CreateArgs, CreateError> {
  return Effect.gen(function* () {
    if (!hasMissingCreateArgs(parsedArgs) || !options.interactive) {
      return yield* requireCreateArgs(parsedArgs);
    }

    if (
      parsedArgs.repoIds.length === 0 &&
      options.availableRepos.length === 0
    ) {
      return yield* Effect.fail(
        new CreateError({
          message:
            "No repos are available. Run `outpost repo add <path>` first.",
        }),
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
  repoIds: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<RepoRecord>, CreateError> {
  const unknownRepoIds = repoIds.filter(
    (repoId) => !registryRepos.some((repo) => repo.id === repoId),
  );

  if (unknownRepoIds.length > 0) {
    return Effect.fail(
      new CreateError({
        message:
          unknownRepoIds.length === 1
            ? `Unknown repo id: ${unknownRepoIds[0]}`
            : `Unknown repo ids: ${unknownRepoIds.join(", ")}`,
      }),
    );
  }

  const duplicateRepoIds = repoIds.filter(
    (repoId) => registryRepos.filter((repo) => repo.id === repoId).length > 1,
  );

  if (duplicateRepoIds.length > 0) {
    return Effect.fail(
      new CreateError({
        message: `Duplicate repo id in registry: ${duplicateRepoIds[0]}`,
      }),
    );
  }

  return Effect.succeed(
    repoIds.map(
      (repoId) =>
        registryRepos.find((repo) => repo.id === repoId) as RepoRecord,
    ),
  ).pipe(
    Effect.flatMap((selectedRepos) => {
      const repoIdsByName = new Map<string, Array<string>>();

      for (const repo of selectedRepos) {
        const ids = repoIdsByName.get(repo.name) ?? [];
        ids.push(repo.id);
        repoIdsByName.set(repo.name, ids);
      }

      const duplicateName = [...repoIdsByName.entries()].find(
        ([, ids]) => ids.length > 1,
      );

      return duplicateName
        ? Effect.fail(
            new CreateError({
              message: `Selected repos share the same name ${duplicateName[0]}: ${duplicateName[1].join(", ")}.`,
            }),
          )
        : Effect.succeed(selectedRepos);
    }),
  );
}

function resolveRemoteHeadBaseBranch(
  repo: RepoRecord,
): Effect.Effect<string, PlatformError, CommandExecutor.CommandExecutor> {
  return Command.string(
    gitCommand(
      "--git-dir",
      repo.managedRepoPath,
      "symbolic-ref",
      "--short",
      "HEAD",
    ),
  ).pipe(
    Effect.map((output) => output.trim()),
    Effect.flatMap((headRef) => {
      return headRef.length > 0
        ? Effect.succeed(headRef)
        : Effect.fail({
            _tag: "SystemError",
            reason: "Unknown",
            module: "Command",
            method: "symbolic-ref",
            message: `Unexpected mirror HEAD ref ${headRef} for ${repo.id}`,
          } as PlatformError);
    }),
  );
}

function remoteBranchExists(
  repo: RepoRecord,
  baseBranch: string,
): Effect.Effect<boolean, PlatformError, CommandExecutor.CommandExecutor> {
  return Command.exitCode(
    gitCommand(
      "--git-dir",
      repo.managedRepoPath,
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${baseBranch}`,
    ),
  ).pipe(Effect.map((exitCode) => exitCode === 0));
}

function localBranchExists(
  repo: RepoRecord,
  branchName: string,
): Effect.Effect<boolean, PlatformError, CommandExecutor.CommandExecutor> {
  return Command.exitCode(
    gitCommand(
      "--git-dir",
      repo.managedRepoPath,
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${branchName}`,
    ),
  ).pipe(Effect.map((exitCode) => exitCode === 0));
}

function buildCreatePlan(
  repo: RepoRecord,
  ticketDirectory: string,
  branchName: string,
  base: string | undefined,
): Effect.Effect<
  CreatePlan,
  CreateError,
  Path.Path | CommandExecutor.CommandExecutor
> {
  return Effect.gen(function* () {
    const baseBranch = yield* base
      ? Effect.succeed(base)
      : resolveRemoteHeadBaseBranch(repo).pipe(
          Effect.mapError(
            (error) =>
              new CreateError({
                message: `Failed to resolve default base branch for repo ${repo.id}: ${error.message}`,
              }),
          ),
        );
    const baseExists = yield* remoteBranchExists(repo, baseBranch).pipe(
      Effect.mapError((error) => new CreateError({ message: error.message })),
    );

    if (!baseExists) {
      return yield* Effect.fail(
        new CreateError({
          message: `Base branch ${baseBranch} not found for repo ${repo.id}.`,
        }),
      );
    }

    const branchExists = yield* localBranchExists(repo, branchName).pipe(
      Effect.mapError((error) => new CreateError({ message: error.message })),
    );

    if (branchExists) {
      return yield* Effect.fail(
        new CreateError({
          message: `Branch ${branchName} already exists for repo ${repo.id}.`,
        }),
      );
    }

    const worktreePath = yield* resolvePathWithinRoot(
      ticketDirectory,
      repo.name,
    ).pipe(
      Effect.mapError((error) => new CreateError({ message: error.message })),
    );

    return {
      repoId: repo.id,
      repoName: repo.name,
      managedRepoPath: repo.managedRepoPath,
      remoteName: repo.remoteName,
      worktreePath,
      branch: branchName,
      base: baseBranch,
      startPoint: baseBranch,
    } satisfies CreatePlan;
  });
}

function createBranch(
  plan: CreatePlan,
): Effect.Effect<void, CreateError, CommandExecutor.CommandExecutor> {
  return Command.exitCode(
    gitCommand(
      "--git-dir",
      plan.managedRepoPath,
      "branch",
      plan.branch,
      plan.startPoint,
    ),
  ).pipe(
    Effect.mapError((error) => new CreateError({ message: error.message })),
    Effect.flatMap((exitCode) =>
      exitCode === 0
        ? Effect.void
        : Effect.fail(
            new CreateError({
              message: `Failed to create branch ${plan.branch} for repo ${plan.repoId}.`,
            }),
          ),
    ),
  );
}

function createWorktree(
  plan: CreatePlan,
): Effect.Effect<void, CreateError, CommandExecutor.CommandExecutor> {
  return Command.exitCode(
    gitCommand(
      "--git-dir",
      plan.managedRepoPath,
      "worktree",
      "add",
      plan.worktreePath,
      plan.branch,
    ),
  ).pipe(
    Effect.mapError((error) => new CreateError({ message: error.message })),
    Effect.flatMap((exitCode) =>
      exitCode === 0
        ? Effect.void
        : Effect.fail(
            new CreateError({
              message: `Failed to create worktree for repo ${plan.repoId}.`,
            }),
          ),
    ),
  );
}

function checkPortableTicketCollision(
  outpostHome: string,
  ticket: string,
): Effect.Effect<void, CreateError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const stateRoot = yield* getWorkspaceStateRoot(outpostHome);
    const stateRootExists = yield* fs
      .exists(stateRoot)
      .pipe(
        Effect.mapError((error) => new CreateError({ message: error.message })),
      );

    if (!stateRootExists) {
      return;
    }

    const entries = yield* fs
      .readDirectory(stateRoot)
      .pipe(
        Effect.mapError((error) => new CreateError({ message: error.message })),
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
          }),
        );
      }
    }
  });
}

function rollbackCreatedArtifacts(
  created: CreatedArtifacts,
  ticketDirectory: string,
  originalError: CreateError,
): Effect.Effect<
  never,
  CreateError,
  FileSystem.FileSystem | Path.Path | CommandExecutor.CommandExecutor
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const cleanupErrors: Array<string> = [];

    for (const plan of [...created.worktrees].reverse()) {
      yield* Command.exitCode(
        gitCommand(
          "--git-dir",
          plan.managedRepoPath,
          "worktree",
          "remove",
          "--force",
          plan.worktreePath,
        ),
      ).pipe(
        Effect.flatMap((exitCode) =>
          exitCode === 0
            ? Effect.void
            : Effect.fail(`git worktree remove exited with status ${exitCode}`),
        ),
        Effect.mapError((error) =>
          typeof error === "string" ? error : error.message,
        ),
        Effect.catchAll((message) => {
          cleanupErrors.push(
            `Failed to remove worktree ${plan.worktreePath}: ${message}`,
          );
          return Effect.void;
        }),
      );
    }

    for (const plan of [...created.branches].reverse()) {
      yield* Command.exitCode(
        gitCommand(
          "--git-dir",
          plan.managedRepoPath,
          "branch",
          "-D",
          plan.branch,
        ),
      ).pipe(
        Effect.flatMap((exitCode) =>
          exitCode === 0
            ? Effect.void
            : Effect.fail(`git branch -D exited with status ${exitCode}`),
        ),
        Effect.mapError((error) =>
          typeof error === "string" ? error : error.message,
        ),
        Effect.catchAll((message) => {
          cleanupErrors.push(
            `Failed to delete branch ${plan.branch} for ${plan.repoId}: ${message}`,
          );
          return Effect.void;
        }),
      );
    }

    if (created.ticketDirectory) {
      const entries = yield* fs.readDirectory(ticketDirectory).pipe(
        Effect.mapError((error) => error.message),
        Effect.catchAll((message) => {
          cleanupErrors.push(
            `Failed to inspect ticket directory ${ticketDirectory}: ${message}`,
          );
          return Effect.succeed(undefined);
        }),
      );

      if (entries?.length === 0) {
        yield* Effect.tryPromise({
          try: () => rmdir(ticketDirectory),
          catch: (error) =>
            error instanceof Error ? error.message : String(error),
        }).pipe(
          Effect.catchAll((message) => {
            cleanupErrors.push(
              `Failed to remove ticket directory ${ticketDirectory}: ${message}`,
            );
            return Effect.void;
          }),
        );
      }
    }

    if (created.agentsGenerated) {
      yield* deleteAgentsIfExists(ticketDirectory).pipe(
        Effect.mapError((error) => error.message),
        Effect.catchAll((message) => {
          cleanupErrors.push(`Failed to delete AGENTS.md: ${message}`);
          return Effect.void;
        }),
      );
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
  base: string | undefined,
): Effect.Effect<
  ReadonlyArray<CreatePlan>,
  CreateError,
  FileSystem.FileSystem | Path.Path | CommandExecutor.CommandExecutor
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const hasManifest = yield* manifestExists(outpostHome, ticket).pipe(
      Effect.mapError((error) => new CreateError({ message: error.message })),
    );

    if (hasManifest) {
      return yield* Effect.fail(
        new CreateError({
          message: `A workspace manifest already exists for ticket ${ticket}`,
        }),
      );
    }

    yield* checkPortableTicketCollision(outpostHome, ticket);

    const ticketDirectoryExists = yield* fs
      .exists(ticketDirectory)
      .pipe(
        Effect.mapError((error) => new CreateError({ message: error.message })),
      );

    if (ticketDirectoryExists) {
      return yield* Effect.fail(
        new CreateError({
          message: `A workspace already exists for ticket ${ticket}: ${ticketDirectory}\nRemove that workspace directory or choose a different ticket.`,
        }),
      );
    }

    const plans = yield* Effect.forEach(selectedRepos, (repo) =>
      buildCreatePlan(repo, ticketDirectory, branchName, base),
    );

    yield* ensureUniqueWorktreePaths(plans);
    return plans;
  });
}

export function runCreate(
  args: ReadonlyArray<string>,
  options: { interactive: boolean },
): Effect.Effect<
  CommandOutput,
  CreateError,
  FileSystem.FileSystem | Path.Path | CommandExecutor.CommandExecutor
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const parsedArgsInput = yield* parseCreateArgsInput(args);

    const outpostHome = yield* resolveOutpostHome();

    let parsedArgs: CreateArgs;

    if (!hasMissingCreateArgs(parsedArgsInput)) {
      parsedArgs = yield* requireCreateArgs(parsedArgsInput);
      yield* validateCreatePathArgs(parsedArgs);
    } else {
      if (!options.interactive) {
        yield* requireCreateArgs(parsedArgsInput);
      }

      const earlyRegistry = yield* loadRepoRegistry(outpostHome).pipe(
        Effect.mapError((error) => new CreateError({ message: error.message })),
      );
      parsedArgs = yield* resolveCreateArgs(parsedArgsInput, {
        interactive: options.interactive,
        availableRepos: earlyRegistry.repos.map((repo) => ({
          id: repo.id,
          name: repo.name,
        })),
      });
      yield* validateCreatePathArgs(parsedArgs);
    }

    const branchName = `${parsedArgs.type}/${parsedArgs.ticket}`;
    yield* validateBranchName(branchName);

    const config = yield* loadConfig(outpostHome).pipe(
      Effect.mapError((error) => new CreateError({ message: error.message })),
    );
    const registry = yield* loadRepoRegistry(outpostHome).pipe(
      Effect.mapError((error) => new CreateError({ message: error.message })),
    );
    const selectedRepos = yield* getSelectedRepos(
      registry.repos,
      parsedArgs.repoIds,
    );

    const workspacePath = parsedArgs.ticket;
    const ticketDirectory = yield* resolvePathWithinRoot(
      config.worktreesRoot,
      workspacePath,
    ).pipe(
      Effect.mapError((error) => new CreateError({ message: error.message })),
    );

    if (parsedArgs.dryRun) {
      const plans = yield* prepareCreate(
        outpostHome,
        parsedArgs.ticket,
        ticketDirectory,
        selectedRepos,
        branchName,
        parsedArgs.base,
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
      } satisfies CommandOutput;
    }

    yield* acquireTicketLock(outpostHome, parsedArgs.ticket).pipe(
      Effect.mapError((error) => {
        if (
          error.message.includes("EEXIST") ||
          error.message.includes("already exists")
        ) {
          return new CreateError({
            message: `Ticket ${parsedArgs.ticket} is locked by another operation. Wait for it to complete or remove the lock manually.`,
          });
        }
        return new CreateError({ message: error.message });
      }),
    );

    const result = yield* Effect.gen(function* () {
      const plans = yield* prepareCreate(
        outpostHome,
        parsedArgs.ticket,
        ticketDirectory,
        selectedRepos,
        branchName,
        parsedArgs.base,
      );
      const created: CreatedArtifacts = {
        branches: [],
        worktrees: [],
        ticketDirectory: false,
        agentsGenerated: false,
      };

      return yield* Effect.gen(function* () {
        yield* fs
          .makeDirectory(ticketDirectory)
          .pipe(
            Effect.mapError(
              (error) => new CreateError({ message: error.message }),
            ),
          );
        created.ticketDirectory = true;

        for (const plan of plans) {
          yield* createBranch(plan);
          created.branches.push(plan);
          yield* createWorktree(plan);
          created.worktrees.push(plan);
        }

        const pathModule = yield* Path.Path;
        const repositoryEntries: ReadonlyArray<RepositoryEntry> =
          yield* Effect.forEach(
            selectedRepos,
            (repo, index) => {
              const plan = plans[index];
              return Effect.succeed({
                id: repo.id,
                name: repo.name,
                base: plan.base,
                managedPath: pathModule.relative(
                  config.reposRoot,
                  repo.managedRepoPath,
                ),
                worktreePath: pathModule.relative(
                  ticketDirectory,
                  plan.worktreePath,
                ),
              } satisfies RepositoryEntry);
            },
            { concurrency: 1 },
          );

        const manifest: Manifest = {
          ticket: parsedArgs.ticket,
          type: parsedArgs.type,
          branch: branchName,
          createdAt: new Date().toISOString(),
          workspacePath,
          repositories: [...repositoryEntries],
        };

        yield* generateAgentsMarkdown(outpostHome, manifest).pipe(
          Effect.mapError(
            (error) => new CreateError({ message: error.message }),
          ),
        );
        created.agentsGenerated = true;

        yield* writeManifest(outpostHome, manifest).pipe(
          Effect.mapError(
            (error) => new CreateError({ message: error.message }),
          ),
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
        } satisfies CommandOutput;
      }).pipe(
        Effect.catchAll((error) =>
          rollbackCreatedArtifacts(created, ticketDirectory, error),
        ),
      );
    }).pipe(
      Effect.ensuring(
        releaseTicketLock(outpostHome, parsedArgs.ticket).pipe(
          Effect.catchAll(() => Effect.void),
        ),
      ),
    );

    return result;
  });
}
