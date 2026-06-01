import * as Command from "@effect/platform/Command";
import type * as CommandExecutor from "@effect/platform/CommandExecutor";
import * as FileSystem from "@effect/platform/FileSystem";
import type { PlatformError } from "@effect/platform/Error";
import * as Path from "@effect/platform/Path";
import { Effect, Schema } from "effect";

import * as CreatePrompt from "./create-prompt.js";
import { loadConfig, loadRepoRegistry, resolveOutpostHome } from "../config.js";
import type { RepoRecord } from "../config.js";
import type { CommandOutput } from "../types.js";

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

function ensureUniqueWorktreePaths(
  plans: ReadonlyArray<CreatePlan>,
): Effect.Effect<void, CreateError> {
  const repoIdsByPath = new Map<string, Array<string>>();

  for (const plan of plans) {
    const repoIds = repoIdsByPath.get(plan.worktreePath);

    if (repoIds) {
      repoIds.push(plan.repoId);
      continue;
    }

    repoIdsByPath.set(plan.worktreePath, [plan.repoId]);
  }

  for (const [worktreePath, repoIds] of repoIdsByPath.entries()) {
    if (repoIds.length > 1) {
      return Effect.fail(
        new CreateError({
          message: `Selected repos would create the same worktree path: ${worktreePath} (repo ids: ${repoIds.join(", ")}).`,
        }),
      );
    }
  }

  return Effect.void;
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

function validatePathSegment(
  label: "--ticket" | "--type",
  value: string,
): Effect.Effect<void, CreateError> {
  if (value.includes("/") || value.includes("\\")) {
    return Effect.fail(
      new CreateError({
        message: `${label} may not contain path separators.`,
      }),
    );
  }

  return Effect.void;
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

function validateCreateArgs(
  parsedArgs: CreateArgs,
): Effect.Effect<void, CreateError, CommandExecutor.CommandExecutor> {
  return Effect.gen(function* () {
    yield* validatePathSegment("--ticket", parsedArgs.ticket);
    yield* validatePathSegment("--type", parsedArgs.type);
    yield* validateBranchName(`${parsedArgs.type}/${parsedArgs.ticket}`);
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
  worktreesRoot: string,
  ticket: string,
  branchName: string,
  base: string | undefined,
): Effect.Effect<
  CreatePlan,
  CreateError,
  Path.Path | CommandExecutor.CommandExecutor
> {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
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

    return {
      repoId: repo.id,
      repoName: repo.name,
      managedRepoPath: repo.managedRepoPath,
      remoteName: repo.remoteName,
      worktreePath: path.join(worktreesRoot, ticket, repo.name),
      branch: branchName,
      base: baseBranch,
      startPoint: baseBranch,
    } satisfies CreatePlan;
  });
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
      "-b",
      plan.branch,
      plan.worktreePath,
      plan.startPoint,
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
    const path = yield* Path.Path;
    const parsedArgsInput = yield* parseCreateArgsInput(args);

    let parsedArgs: CreateArgs;

    if (!hasMissingCreateArgs(parsedArgsInput)) {
      parsedArgs = yield* requireCreateArgs(parsedArgsInput);
      yield* validateCreateArgs(parsedArgs);
    } else {
      if (!options.interactive) {
        yield* requireCreateArgs(parsedArgsInput);
      }

      const outpostHome = yield* resolveOutpostHome();
      yield* loadConfig(outpostHome).pipe(
        Effect.mapError((error) => new CreateError({ message: error.message })),
      );
      const registry = yield* loadRepoRegistry(outpostHome).pipe(
        Effect.mapError((error) => new CreateError({ message: error.message })),
      );
      parsedArgs = yield* resolveCreateArgs(parsedArgsInput, {
        interactive: options.interactive,
        availableRepos: registry.repos.map((repo) => ({
          id: repo.id,
          name: repo.name,
        })),
      });
      yield* validateCreateArgs(parsedArgs);
    }

    const outpostHome = yield* resolveOutpostHome();
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
    const ticketDirectory = path.join(config.worktreesRoot, parsedArgs.ticket);
    const ticketDirectoryExists = yield* fs
      .exists(ticketDirectory)
      .pipe(
        Effect.mapError((error) => new CreateError({ message: error.message })),
      );

    if (ticketDirectoryExists) {
      return yield* Effect.fail(
        new CreateError({
          message: `A workspace already exists for ticket ${parsedArgs.ticket}: ${ticketDirectory}\nRemove that workspace directory or choose a different ticket.`,
        }),
      );
    }

    const branchName = `${parsedArgs.type}/${parsedArgs.ticket}`;
    const plans = yield* Effect.forEach(selectedRepos, (repo) =>
      buildCreatePlan(
        repo,
        config.worktreesRoot,
        parsedArgs.ticket,
        branchName,
        parsedArgs.base,
      ),
    );

    yield* ensureUniqueWorktreePaths(plans);

    if (!parsedArgs.dryRun) {
      yield* fs
        .makeDirectory(ticketDirectory, { recursive: true })
        .pipe(
          Effect.mapError(
            (error) => new CreateError({ message: error.message }),
          ),
        );

      yield* Effect.forEach(plans, createWorktree, { concurrency: 1 });
    }

    return {
      command: "create",
      data: {
        ticket: parsedArgs.ticket,
        ticketDirectory,
        type: parsedArgs.type,
        branch: branchName,
        dryRun: parsedArgs.dryRun,
        worktrees: plans.map((plan) => ({
          repoId: plan.repoId,
          repoName: plan.repoName,
          path: plan.worktreePath,
          branch: plan.branch,
          base: plan.base,
        })),
      },
    } satisfies CommandOutput;
  });
}
