import { rmdir } from "node:fs/promises";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import { withAttributeIndex } from "../attribute-inspection.js";
import {
  type BaseSelection,
  type BaseSource,
  baseOutput,
  refreshBase,
  releaseBaseReceipt,
  requireOwnedReuseStorage,
  resolveBase,
  resolveExistingBranch,
} from "../base-selection.js";
import { verifyBorrowed } from "../borrowed-repo.js";
import type { BorrowedRecord, WorkspaceStorage } from "../borrowed-schema.js";
import {
  captureWorkspaceStorage,
  checkedHooks,
  emptyHooks,
  safeBorrowedGit,
  verifyDirectory,
  verifyMutationParents,
  verifyWorkspaceStorage,
} from "../borrowed-workspace.js";
import { cachedError, inspectCachedRemote, resolveBorrowedCache } from "../cached-base.js";
import {
  acquireBranchCreation,
  acquireBranchVerification,
  commandExitCode,
  commandResult,
  commandString,
  noLazyFetchGitCommand as gitCommand,
  readOnlyGitCommand,
} from "../child-process.js";
import { parseCommandInput, requireCommand } from "../command-spec.js";
import type { RepoRecord } from "../config.js";
import {
  loadConfig,
  loadRepoRegistry,
  matchesTags,
  prepareExtendedState,
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
import { requireOwnedReuseObjects } from "../reuse-object-storage.js";
import type { CommandOutput } from "../types.js";
import {
  validateWindowsInvocationCwd,
  validateWindowsLocalTransport,
  validateWindowsWorktreePlan,
} from "../windows-git-path.js";
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
import { preflightReusedTree, verifyNewWorktreeClean } from "./workspace-resume.js";

export class CreateError extends Schema.TaggedError<CreateError>()("CreateError", {
  ...ErrorDetailFields,
  message: Schema.String,
}) {}

const createUsage =
  "Usage: outpost create --ticket <id> --type <branch-type> [--repo <id> ...] [--tag <tag> ...] [--base-source <source>] [--base <ref>] [--reuse-branch <name>] [--dry-run]";

type CreateArgs = {
  ticket: string;
  type: string;
  repoIds: ReadonlyArray<string>;
  tags?: ReadonlyArray<string>;
  base?: string;
  remote?: string;
  reuseBranch?: string;
  baseSource: BaseSource;
  dryRun: boolean;
};

type CreateArgsInput = {
  ticket?: string;
  type?: string;
  repoIds: ReadonlyArray<string>;
  tags?: ReadonlyArray<string>;
  base?: string;
  remote?: string;
  reuseBranch?: string;
  baseSource: BaseSource;
  dryRun: boolean;
};

type CreationRepo =
  | RepoRecord
  | (BorrowedRecord & {
      managedRepoPath: string;
      borrowed: BorrowedRecord;
      tags?: readonly string[];
      remoteName?: undefined;
      remoteUrl?: undefined;
      sourceRepoPath?: undefined;
    });

type CreatePlan = BaseSelection & {
  borrowed?: BorrowedRecord;
  storage?: WorkspaceStorage;
  hooks?: string;
  filterOverrides?: readonly string[];
  repoId: string;
  repoName: string;
  managedRepoPath: string;
  remoteName?: string;
  worktreePath: string;
  branch: string;
  verifyBranchLock?: Effect.Effect<void, CreateError>;
  releaseBranchLock?: Effect.Effect<void, CreateError>;
};

type CreatedArtifacts = {
  retainedAdmission?: {
    plans: readonly CreatePlan[];
    record: (
      step: Record<string, unknown>
    ) => Effect.Effect<void, CreateError, FileSystem.FileSystem | Path.Path>;
  };
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
        remote: value("--remote"),
        reuseBranch: value("--reuse-branch"),
        baseSource: (() => {
          const source = value("--base-source") ?? "cached-remote";
          if (!["local", "cached-remote", "fresh-remote"].includes(source))
            throw new Error("--base-source must be local, cached-remote or fresh-remote.");
          return source as BaseSource;
        })(),
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
    remote: parsedArgs.remote,
    reuseBranch: parsedArgs.reuseBranch,
    baseSource: parsedArgs.baseSource,
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
    if (parsedArgs.reuseBranch !== undefined) {
      yield* validateSemanticIdentifier("--reuse-branch", parsedArgs.reuseBranch).pipe(
        Effect.mapError((error) => usageError(error.message))
      );
      if (parsedArgs.reuseBranch.startsWith("refs/"))
        return yield* Effect.fail(
          usageError("--reuse-branch accepts a local branch name without refs/heads/ prefix.")
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
      reuseBranch: parsedArgs.reuseBranch,
      remote: parsedArgs.remote,
      baseSource: parsedArgs.baseSource,
      dryRun: parsedArgs.dryRun,
    });
  });
}

function getSelectedRepos(
  registryRepos: ReadonlyArray<CreationRepo>,
  repoIds: ReadonlyArray<string>
): Effect.Effect<ReadonlyArray<CreationRepo>, CreateError> {
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
    repoIds.map((repoId) => registryRepos.find((repo) => repo.id === repoId) as CreationRepo)
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

function localBranchExists(
  repo: CreationRepo,
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
  repo: CreationRepo,
  ticketDirectory: string,
  branchName: string,
  base: string | undefined,
  source: BaseSource,
  reuse = false,
  remote?: string
): Effect.Effect<
  CreatePlan,
  CreateError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  return Effect.gen(function* () {
    const borrowed = "borrowed" in repo ? repo.borrowed : undefined;
    if (remote !== undefined && (source !== "cached-remote" || reuse))
      return yield* cachedError(
        "--remote is only supported for cached-remote NEW selection, not local, fresh or reuse."
      );
    if (!borrowed && remote !== undefined) {
      if (remote !== "origin")
        return yield* cachedError(
          "Managed mirrors support explicit actual origin only; no configuration is remapped."
        );
      const actual = yield* commandExitCode(
        gitCommand("--git-dir", repo.managedRepoPath, "config", "--get", "remote.origin.url")
      );
      if (actual !== 0)
        return yield* cachedError("The managed mirror has no actual origin remote.");
    }
    if (borrowed) {
      if (
        reuse ||
        (source !== "local" && source !== "cached-remote") ||
        !base ||
        (source === "local" &&
          !/^(?:refs\/(?:heads|tags)\/.+|[0-9a-f]{40}|[0-9a-f]{64})$/.test(base))
      )
        return yield* usageError(
          "Borrowed NEW workspaces require local full heads/tags/SHA or named cached-remote selection. Borrowed fresh/reuse is unsupported."
        );
      yield* source === "cached-remote"
        ? verifyBorrowed(borrowed).pipe(
            Effect.mapError(() =>
              cachedError("Saved borrowed anchor identity/configuration is unavailable.")
            )
          )
        : verifyBorrowed(borrowed);
      yield* verifyMutationParents(borrowed, branchName);
      yield* requireOwnedReuseStorage(repo, branchName);
      const symbolicTarget = yield* commandExitCode(
        gitCommand(
          "--git-dir",
          repo.managedRepoPath,
          "symbolic-ref",
          "--quiet",
          `refs/heads/${branchName}`
        )
      );
      if (symbolicTarget !== 1)
        return yield* usageError(
          "New borrowed ticket branch is symbolic or unavailable. Existing refs are preserved."
        );
      yield* requireOwnedReuseStorage(
        repo,
        branchName,
        source === "cached-remote"
          ? `refs/remotes/${remote}/${base.replace(/^refs\/heads\//, "")}`
          : base.startsWith("refs/")
            ? base
            : undefined
      );
      if (source === "local") {
        const raw = (yield* commandString(
          gitCommand(
            "--git-dir",
            repo.managedRepoPath,
            "rev-parse",
            "--verify",
            "--end-of-options",
            base
          )
        )).trim();
        yield* requireOwnedReuseObjects(repo.managedRepoPath, raw, repo.id);
      }
    }
    if (reuse && "borrowed" in repo)
      return yield* usageError("Borrowed existing branch reuse is unsupported.");
    const selectionEffect: Effect.Effect<
      BaseSelection,
      { message: string },
      FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
    > =
      borrowed && source === "cached-remote"
        ? resolveBorrowedCache(borrowed, remote, base)
        : reuse && !("borrowed" in repo)
          ? resolveExistingBranch(repo, branchName)
          : resolveBase(repo, source, base);
    const selection = yield* selectionEffect.pipe(
      Effect.mapError(
        (error) => new CreateError({ message: error.message, ...domainDetails(error) })
      )
    );
    if (borrowed)
      yield* requireOwnedReuseObjects(repo.managedRepoPath, selection.startPoint ?? "", repo.id);
    const filterOverrides = borrowed
      ? yield* withAttributeIndex(borrowed, (inspection) =>
          preflightReusedTree(
            repo.managedRepoPath,
            selection.startPoint ?? "",
            repo.id,
            true,
            inspection,
            true
          )
        ).pipe(
          Effect.mapError(
            (error) => new CreateError({ message: error.message, ...domainDetails(error) })
          )
        )
      : reuse
        ? yield* preflightReusedTree(
            repo.managedRepoPath,
            selection.startPoint ?? "",
            repo.id
          ).pipe(
            Effect.mapError(
              (error) => new CreateError({ message: error.message, ...domainDetails(error) })
            )
          )
        : [];
    const branchExists = yield* localBranchExists(repo, branchName).pipe(
      Effect.mapError(
        (error) => new CreateError({ message: error.message, ...domainDetails(error) })
      )
    );

    if (!reuse && branchExists) {
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
      ...(borrowed ? { borrowed, filterOverrides } : {}),
      repoId: repo.id,
      repoName: repo.name,
      managedRepoPath: repo.managedRepoPath,
      remoteName: repo.remoteName,
      worktreePath,
      branch: branchName,
      ...selection,
    } satisfies CreatePlan;
  }).pipe(
    Effect.mapError((error) => new CreateError({ message: error.message, ...domainDetails(error) }))
  );
}

function planGit(plan: CreatePlan, ...args: string[]) {
  return plan.borrowed
    ? safeBorrowedGit(plan.hooks ?? "", ...(plan.filterOverrides ?? []), ...args)
    : gitCommand(...args);
}

function createBranch(
  plan: CreatePlan
): Effect.Effect<
  void,
  CreateError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  if (!plan.startPoint)
    return Effect.fail(new CreateError({ message: "Cannot create an unresolved base plan." }));
  if (plan.borrowed)
    return Effect.gen(function* () {
      yield* verifyDirectory(plan.borrowed!.common);
      yield* verifyMutationParents(plan.borrowed!, plan.branch);
      yield* checkedHooks(plan.hooks ?? "");
      yield* requireOwnedReuseStorage(
        { id: plan.repoId, managedRepoPath: plan.managedRepoPath },
        plan.branch
      );
      const ref = `refs/heads/${plan.branch}`;
      const lock = yield* acquireBranchCreation(
        plan.managedRepoPath,
        ref,
        plan.startPoint!,
        (...args) => planGit(plan, ...args)
      );
      const symbolic = yield* commandExitCode(
        planGit(plan, "--git-dir", plan.managedRepoPath, "symbolic-ref", "--quiet", ref)
      );
      const exists = yield* commandExitCode(
        planGit(plan, "--git-dir", plan.managedRepoPath, "show-ref", "--verify", "--quiet", ref)
      );
      if (symbolic !== 1 || exists !== 1)
        return yield* new CreateError({
          message: "New branch became present/symbolic while locked; preserving existing refs.",
        });
      yield* verifyDirectory(plan.borrowed!.common);
      yield* lock.verify;
      yield* lock.commit;
    }).pipe(
      Effect.scoped,
      Effect.mapError(
        (error) => new CreateError({ message: error.message, ...domainDetails(error) })
      )
    );
  return commandExitCode(
    planGit(plan, "--git-dir", plan.managedRepoPath, "branch", plan.branch, plan.startPoint ?? "")
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
): Effect.Effect<
  void,
  CreateError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  return (
    plan.borrowed
      ? verifyMutationParents(plan.borrowed, plan.branch, true).pipe(
          Effect.andThen(checkedHooks(plan.hooks ?? ""))
        )
      : Effect.void
  ).pipe(
    Effect.andThen(
      commandResult(
        planGit(
          plan,
          "--git-dir",
          plan.managedRepoPath,
          "worktree",
          "add",
          ...(plan.branchDisposition === "existing" || plan.borrowed
            ? ["--no-checkout", "--no-guess-remote"]
            : []),
          plan.worktreePath,
          plan.branch
        )
      )
    ),
    Effect.mapError(
      (error) =>
        new CreateError({
          message: `Failed to create worktree for repo ${plan.repoId}: ${error.message}`,
          ...domainDetails(error),
        })
    ),
    Effect.flatMap((result) =>
      result.exitCode === 0
        ? Effect.void
        : Effect.fail(
            new CreateError({
              message: `Failed to create worktree for repo ${plan.repoId} (exit status ${result.exitCode}): ${result.stderr.text}${result.stderr.truncated ? " [stderr truncated]" : ""}`,
            })
          )
    )
  );
}

function verifyCreatedPlans(plans: ReadonlyArray<CreatePlan>) {
  return Effect.gen(function* () {
    for (const plan of plans) {
      if (plan.borrowed) {
        yield* verifyDirectory(plan.borrowed.common);
        yield* checkedHooks(plan.hooks ?? "");
        yield* requireOwnedReuseStorage(
          { id: plan.repoId, managedRepoPath: plan.managedRepoPath },
          plan.branch
        );
        yield* requireOwnedReuseObjects(plan.managedRepoPath, plan.startPoint ?? "", plan.repoId);
        if (plan.storage) yield* verifyWorkspaceStorage(plan.storage, plan.worktreePath);
      }
      if (plan.verifyBranchLock) yield* plan.verifyBranchLock;
      if (plan.branchDisposition === "existing") {
        yield* requireOwnedReuseObjects(plan.managedRepoPath, plan.startPoint ?? "", plan.repoId);
        yield* requireOwnedReuseStorage(
          { id: plan.repoId, managedRepoPath: plan.managedRepoPath },
          plan.branch
        );
        const symbolic = yield* commandExitCode(
          planGit(
            plan,
            "--git-dir",
            plan.managedRepoPath,
            "symbolic-ref",
            "--quiet",
            `refs/heads/${plan.branch}`
          )
        );
        if (symbolic !== 1)
          return yield* Effect.fail(
            new CreateError({
              message: `Existing branch became symbolic or unavailable for ${plan.repoId}; preserve residual work instead of claiming admission provenance.`,
            })
          );
      }
      const owned = yield* verifyWorktreeOwnership(plan.worktreePath, plan.managedRepoPath);
      if (!owned)
        return yield* Effect.fail(
          new CreateError({
            ...reasonDetails("invalid-state"),
            message: `Created worktree ownership changed for ${plan.repoId}; preserving residual work instead of committing provenance.`,
          })
        );
      const branch = (yield* commandString(
        planGit(plan, "-C", plan.worktreePath, "symbolic-ref", "--quiet", "HEAD")
      )).trim();
      const head = (yield* commandString(
        planGit(plan, "-C", plan.worktreePath, "rev-parse", "--verify", "HEAD^{commit}")
      )).trim();
      // Use the checkout gitfile so Git does not revalidate the longer linked
      // admin path as an explicit GIT_DIR when --work-tree is supplied.
      const status =
        plan.branchDisposition === "existing" || plan.borrowed
          ? yield* verifyNewWorktreeClean(
              plan.worktreePath,
              plan.repoId,
              plan.startPoint ?? "",
              undefined,
              Boolean(plan.borrowed)
            )
          : yield* commandString(
              planGit(
                plan,
                "-C",
                plan.worktreePath,
                "--git-dir",
                ".git",
                "--work-tree",
                plan.worktreePath,
                "-c",
                "core.bare=false",
                "status",
                "--porcelain",
                "--untracked-files=all"
              )
            );
      if (
        branch !== `refs/heads/${plan.branch}` ||
        head !== plan.startPoint ||
        status.trim() !== ""
      )
        return yield* Effect.fail(
          new CreateError({
            ...reasonDetails("invalid-state"),
            message: `Created branch/worktree changed for ${plan.repoId}; preserving changed work rather than committing false base provenance.`,
          })
        );
    }
  }).pipe(
    Effect.mapError((error) => new CreateError({ message: error.message, ...domainDetails(error) }))
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
    if (created.retainedAdmission) {
      const members = yield* Effect.forEach(created.retainedAdmission.plans, (plan) =>
        Effect.gen(function* () {
          return {
            repoId: plan.repoId,
            backend: plan.borrowed ? "borrowed" : "managed",
            branch: plan.branch,
            originalBaseCommit: plan.startPoint,
            repositoryPath: plan.managedRepoPath,
            checkoutPath: plan.worktreePath,
            administrationPath:
              plan.storage?.kind === "borrowed" ? plan.storage.administration.path : null,
            branchCreationConfirmed: created.branches.includes(plan),
            checkoutCreationConfirmed: created.worktrees.includes(plan),
            checkoutPresent: yield* fs
              .exists(plan.worktreePath)
              .pipe(Effect.orElseSucceed(() => true)),
            currentState: "unknown-preserved",
            action:
              "Inspect doctor and actual Git registrations/refs/reflogs manually. No artifact is adopted or deleted from this record.",
          };
        })
      );
      yield* created.retainedAdmission
        .record({ action: "preserved-failed-borrowed-admission", ticketDirectory, members })
        .pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              cleanupErrors.push(`Recovery journal update failed: ${error.message}`);
            })
          )
        );
      return yield* new CreateError({
        ...reasonDetails("invalid-state"),
        action:
          "Run outpost doctor --json and inspect the surviving branch, reflogs, checkout/admin and recorded original SHA. Do not reset, recreate or adopt residual ticket paths. Manual recovery is required.",
        message: `${originalError.message}\nBorrowed-containing admission was not rolled back: confirmed and possible branches, reflogs, checkouts/admin and guidance are preserved with unknown current state. A matching current SHA cannot prove untouched history. ${cleanupErrors.join("; ")}`,
      });
    }

    for (const plan of [...created.worktrees].reverse()) {
      if (plan.borrowed) {
        const valid = yield* verifyDirectory(plan.borrowed.common).pipe(Effect.result);
        if (valid._tag === "Failure") {
          cleanupErrors.push(`Preserved replaced storage for ${plan.repoId}`);
          continue;
        }
        if (plan.storage) {
          const owned = yield* verifyWorkspaceStorage(plan.storage, plan.worktreePath).pipe(
            Effect.result
          );
          if (owned._tag === "Failure") {
            cleanupErrors.push(`Preserved changed checkout identity for ${plan.repoId}`);
            continue;
          }
        }
      }
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
        planGit(plan, "-C", plan.worktreePath, "symbolic-ref", "--quiet", "HEAD")
      ).pipe(Effect.result);
      if (branch._tag === "Failure" || branch.success.trim() !== `refs/heads/${plan.branch}`) {
        cleanupErrors.push(
          `Preserved worktree ${plan.worktreePath}: branch changed or could not be inspected`
        );
        continue;
      }
      const head = yield* commandString(
        planGit(plan, "-C", plan.worktreePath, "rev-parse", "--verify", "HEAD^{commit}")
      ).pipe(Effect.result);
      if (head._tag === "Failure" || head.success.trim() !== plan.startPoint) {
        cleanupErrors.push(
          `Preserved worktree ${plan.worktreePath}: HEAD changed or could not be inspected`
        );
        continue;
      }
      if (plan.borrowed) {
        const status = yield* verifyNewWorktreeClean(
          plan.worktreePath,
          plan.repoId,
          plan.startPoint ?? "",
          (overrides) => {
            plan.filterOverrides = overrides;
          }
        ).pipe(Effect.result);
        if (status._tag === "Failure" || status.success.trim()) {
          cleanupErrors.push(
            `Preserved dirty/unknown borrowed checkout ${plan.worktreePath}; no Git cleanup or configured program was run.`
          );
          continue;
        }
      }
      // No force: new untracked files or agent edits must survive rollback.
      yield* commandExitCode(
        planGit(plan, "--git-dir", plan.managedRepoPath, "worktree", "remove", plan.worktreePath)
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
        if (plan.borrowed) {
          yield* verifyDirectory(plan.borrowed.common);
          yield* checkedHooks(plan.hooks ?? "");
        }
        const ref = `refs/heads/${plan.branch}`;
        const exists = yield* commandExitCode(
          planGit(plan, "--git-dir", plan.managedRepoPath, "show-ref", "--verify", "--quiet", ref)
        );
        if (exists === 1) return;
        if (exists !== 0) return yield* Effect.fail(`Cannot inspect branch ${plan.branch}`);
        const symbolic = yield* commandExitCode(
          planGit(plan, "--git-dir", plan.managedRepoPath, "symbolic-ref", "--quiet", ref)
        );
        if (symbolic !== 1)
          return yield* Effect.fail(
            `Preserved branch ${plan.branch}: it became symbolic or could not be inspected`
          );
        const worktrees = yield* commandString(
          planGit(plan, "--git-dir", plan.managedRepoPath, "worktree", "list", "--porcelain", "-z")
        );
        if (worktrees.split("\0").includes(`branch ${ref}`)) {
          return yield* Effect.fail(
            `Preserved branch ${plan.branch}: it is still linked to a worktree`
          );
        }
        // Compare-and-delete refuses a branch advanced after creation. The
        // immutable starting commit is recorded before the branch mutation.
        const status = yield* commandExitCode(
          planGit(
            plan,
            "--git-dir",
            plan.managedRepoPath,
            "update-ref",
            "--no-deref",
            "-d",
            ref,
            plan.startPoint ?? ""
          )
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
  selectedRepos: ReadonlyArray<CreationRepo>,
  branchName: string,
  base: string | undefined,
  source: BaseSource,
  reuse = false,
  remote?: string
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
          message: `A workspace manifest already exists for ticket ${ticket}. Use outpost workspace resume <ticket> --json to inspect the existing workspace; use outpost doctor --json for incomplete metadata. No base refresh was performed.`,
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
          message: `A workspace directory already exists for ticket ${ticket}: ${ticketDirectory}\nPreserve its contents and run outpost doctor --json to inspect incomplete or interrupted creation. A directory alone is never adopted or repaired.`,
        })
      );
    }

    const config = yield* loadConfig(outpostHome).pipe(
      Effect.mapError(
        (error) => new CreateError({ message: error.message, ...domainDetails(error) })
      )
    );
    if (selectedRepos.some((repo) => "borrowed" in repo) && (reuse || source === "fresh-remote"))
      return yield* cachedError(
        "Borrowed fresh transport and existing-branch reuse remain unsupported. No selected member was changed."
      );
    if (remote !== undefined && (reuse || source !== "cached-remote"))
      return yield* cachedError("--remote is only supported for cached-remote NEW selection.");
    yield* Effect.forEach(selectedRepos, (repo) =>
      Effect.gen(function* () {
        if ("borrowed" in repo)
          yield* source === "cached-remote"
            ? verifyBorrowed(repo.borrowed).pipe(
                Effect.mapError(() =>
                  cachedError("Saved borrowed anchor identity/configuration is unavailable.")
                )
              )
            : verifyBorrowed(repo.borrowed);
        else yield* verifyManagedRepository(config.reposRoot, repo, gitCommand);
      }).pipe(
        Effect.mapError(
          (error) => new CreateError({ message: error.message, ...domainDetails(error) })
        )
      )
    );
    const plans = yield* Effect.forEach(selectedRepos, (repo) =>
      buildCreatePlan(repo, ticketDirectory, branchName, base, source, reuse, remote)
    );

    yield* ensureUniqueWorktreePaths(plans);
    return plans;
  }).pipe(
    Effect.mapError((error) => new CreateError({ message: error.message, ...domainDetails(error) }))
  );
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
    // Existing membership is frozen: current tags, registrations and base refs
    // must not hide the explicit resume path or authorize a fresh fetch.
    if (parsedArgsInput.ticket) {
      // Invalid input follows the established validation below. Only a safe
      // ticket may be used for this earlier, read-only manifest lookup.
      const lookup = yield* validateSemanticIdentifier("--ticket", parsedArgsInput.ticket).pipe(
        Effect.andThen(validatePathSegment("--ticket", parsedArgsInput.ticket)),
        Effect.result
      );
      if (
        lookup._tag === "Success" &&
        (yield* manifestExists(outpostHome, parsedArgsInput.ticket).pipe(
          Effect.mapError(
            (error) => new CreateError({ ...domainDetails(error), message: error.message })
          )
        ))
      )
        return yield* Effect.fail(
          new CreateError({
            ...reasonDetails("invalid-state"),
            message: `A workspace manifest already exists for ticket ${parsedArgsInput.ticket}. Use outpost workspace resume <ticket> --json to inspect its frozen membership and current work. For invalid metadata, run outpost doctor --json. No base refresh was performed.`,
          })
        );
    }
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

    yield* validateWindowsInvocationCwd().pipe(
      Effect.mapError(
        (error) => new CreateError({ message: error.message, ...domainDetails(error) })
      )
    );
    const branchName = parsedArgs.reuseBranch ?? `${parsedArgs.type}/${parsedArgs.ticket}`;
    yield* validateBranchName(branchName);
    if (parsedArgs.reuseBranch !== undefined) {
      const redirects = [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_COMMON_DIR",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_NAMESPACE",
        "GIT_SHALLOW_FILE",
        "GIT_REPLACE_REF_BASE",
        "GIT_GRAFT_FILE",
        "GIT_ATTR_SOURCE",
      ].filter((name) => process.env[name] !== undefined);
      if (redirects.length)
        return yield* Effect.fail(
          new CreateError({
            ...reasonDetails("invalid-state"),
            message: `Existing branch reuse refuses inherited repository redirection (${redirects.join(", ")}). Use an ordinary Git environment and preserve existing work; no variable values are emitted.`,
          })
        );
    }

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
      [
        ...registry.repos,
        ...(registry.borrowedRepositories ?? []).map((record) => ({
          ...record,
          borrowed: record,
          managedRepoPath: record.common.path,
        })),
      ],
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

    for (const repo of selectedRepos)
      yield* validateWindowsWorktreePlan(
        repo.managedRepoPath,
        `${ticketDirectory}/${repo.name}`
      ).pipe(
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
        parsedArgs.base,
        parsedArgs.baseSource,
        parsedArgs.reuseBranch !== undefined,
        parsedArgs.remote
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
            ...(plan.borrowed
              ? { storageKind: "borrowed" as const, commonDirectory: plan.managedRepoPath }
              : {}),
            ...baseOutput(plan),
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

    let freshStarted = false;
    const result = yield* Effect.gen(function* () {
      let plans = yield* prepareCreate(
        outpostHome,
        parsedArgs.ticket,
        ticketDirectory,
        selectedRepos,
        branchName,
        parsedArgs.base,
        parsedArgs.baseSource,
        parsedArgs.reuseBranch !== undefined,
        parsedArgs.remote
      );
      if (parsedArgs.reuseBranch !== undefined) {
        yield* record({
          action: "verify-existing-branches",
          phase: "intent",
          branchDisposition: "existing",
          ticket: parsedArgs.ticket,
          plans,
        });
        const locked: CreatePlan[] = [];
        for (const plan of plans) {
          const branchLock = yield* acquireBranchVerification(
            plan.managedRepoPath,
            `refs/heads/${plan.branch}`,
            plan.startPoint ?? ""
          ).pipe(
            Effect.mapError(
              (error) => new CreateError({ ...domainDetails(error), message: error.message })
            )
          );
          // A live Effect is not journal data. Keep the scoped verifier off the
          // enumerable immutable plan persisted for manual recovery.
          Object.defineProperty(plan, "verifyBranchLock", {
            value: branchLock.verify.pipe(
              Effect.mapError(
                (error) => new CreateError({ ...domainDetails(error), message: error.message })
              )
            ),
          });
          Object.defineProperty(plan, "releaseBranchLock", {
            value: branchLock.release.pipe(
              Effect.mapError(
                (error) => new CreateError({ ...domainDetails(error), message: error.message })
              )
            ),
          });
          locked.push(plan);
          yield* record({
            action: "verify-existing-branch",
            phase: "prepared",
            repoId: plan.repoId,
            managedRepoPath: plan.managedRepoPath,
            branch: plan.branch,
            admissionCommit: plan.startPoint,
            branchDisposition: "existing",
          });
        }
        plans = locked;
        // Recheck symbolic attachment and checkout conflict under every prepared ref lock.
        for (let index = 0; index < plans.length; index++) {
          const target = selectedRepos[index];
          if ("borrowed" in target) return yield* usageError("Borrowed reuse is unsupported.");
          const selected = yield* resolveExistingBranch(target, plans[index].branch).pipe(
            Effect.mapError(
              (error) => new CreateError({ ...domainDetails(error), message: error.message })
            )
          );
          if (selected.startPoint !== plans[index].startPoint)
            return yield* Effect.fail(
              new CreateError({
                message: `Existing branch changed for ${plans[index].repoId}; no workspace was created.`,
              })
            );
          yield* plans[index].verifyBranchLock ??
            Effect.fail(new CreateError({ message: "Missing existing branch admission lock." }));
        }
      }
      if (parsedArgs.baseSource === "fresh-remote") {
        // Validate every transport before the first fetch; local/cached modes never touch it.
        for (const repo of selectedRepos)
          yield* validateWindowsLocalTransport(
            repo.remoteUrl ?? "",
            repo.sourceRepoPath ?? ""
          ).pipe(
            Effect.mapError(
              (error) => new CreateError({ message: error.message, ...domainDetails(error) })
            )
          );
        freshStarted = true;
        const refreshed: Array<CreatePlan> = [];
        for (let index = 0; index < plans.length; index++) {
          const target = selectedRepos[index];
          if ("borrowed" in target)
            return yield* usageError("Borrowed remote operations are unsupported.");
          const selected = yield* refreshBase(target, plans[index], record).pipe(
            Effect.mapError(
              (error) =>
                new CreateError({
                  message: `Fresh selection may have updated earlier tracking/receipt refs; inspect the operation journal. ${error.message}`,
                  ...domainDetails(error),
                })
            )
          );
          refreshed.push({ ...plans[index], ...selected });
        }
        plans = refreshed;
      }
      if (plans.some((plan) => plan.borrowed)) {
        const hooks = yield* emptyHooks(outpostHome);
        for (const plan of plans) if (plan.borrowed) plan.hooks = hooks;
      }
      yield* record({ action: "prepare-workspace-provenance-state", ticket: parsedArgs.ticket });
      const provenanceConfig = yield* prepareExtendedState(outpostHome, config).pipe(
        Effect.mapError(
          (error) => new CreateError({ message: error.message, ...domainDetails(error) })
        )
      );
      const created: CreatedArtifacts = {
        ...(plans.some((plan) => plan.borrowed) ? { retainedAdmission: { plans, record } } : {}),
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
          if (plan.borrowed) {
            yield* plan.baseRemote
              ? verifyBorrowed(plan.borrowed).pipe(
                  Effect.mapError(() =>
                    cachedError("Saved borrowed identity/configuration changed before mutation.")
                  )
                )
              : verifyBorrowed(plan.borrowed);
            if (plan.baseRemote) yield* inspectCachedRemote(plan.borrowed, plan.baseRemote);
            yield* checkedHooks(plan.hooks ?? "");
            yield* requireOwnedReuseObjects(
              plan.managedRepoPath,
              plan.startPoint ?? "",
              plan.repoId
            );
          }
          if (plan.branchDisposition !== "existing") {
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
          } else {
            yield* plan.verifyBranchLock ??
              Effect.fail(new CreateError({ message: "Missing existing branch admission lock." }));
            yield* record({
              action: "borrow-existing-branch",
              phase: "verified",
              repoId: plan.repoId,
              branch: plan.branch,
              admissionCommit: plan.startPoint,
              branchDisposition: "existing",
            });
          }
          yield* record({ action: "create-worktree", phase: "intent", ...plan });
          yield* Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              yield* restore(createWorktree(plan));
              created.worktrees.push(plan);
            })
          );
          yield* record({ action: "create-worktree", phase: "confirmed", ...plan });
          if (plan.borrowed)
            plan.storage = yield* captureWorkspaceStorage(plan.borrowed, plan.worktreePath);
          if (plan.branchDisposition === "existing" || plan.borrowed) {
            // Populate only this newly confirmed worktree. One-way merge refuses
            // raced untracked/modified files; --reset and checkout force are forbidden.
            yield* requireOwnedReuseObjects(
              plan.managedRepoPath,
              plan.startPoint ?? "",
              plan.repoId
            );
            if (!plan.borrowed)
              yield* plan.verifyBranchLock ??
                Effect.fail(
                  new CreateError({ message: "Missing existing branch admission lock." })
                );
            yield* commandString(
              planGit(
                plan,
                "-C",
                plan.worktreePath,
                "--git-dir",
                ".git",
                "--work-tree",
                plan.worktreePath,
                "-c",
                "core.bare=false",
                "read-tree",
                "-m",
                "-u",
                "--no-recurse-submodules",
                plan.startPoint ?? ""
              )
            );
          }
        }

        yield* verifyCreatedPlans(plans);
        const pathModule = yield* Path.Path;
        const repositoryEntries: ReadonlyArray<RepositoryEntry> = yield* Effect.forEach(
          selectedRepos,
          (repo, index) => {
            const plan = plans[index];
            return Effect.succeed({
              id: repo.id,
              name: repo.name,
              base: plan.base,
              baseSource: plan.baseSource,
              requestedBase: plan.requestedBase,
              baseRef: plan.baseRef,
              baseCommit: plan.startPoint ?? undefined,
              ...(plan.baseRemote
                ? { baseRemote: plan.baseRemote, remoteRef: plan.remoteRef }
                : {}),
              ...(plan.branchDisposition === "existing"
                ? { branchDisposition: "existing" as const }
                : {}),
              ...(plan.borrowed
                ? { storage: plan.storage, branchDisposition: "created" as const }
                : {
                    managedPath: pathModule.relative(config.reposRoot, repo.managedRepoPath),
                    ...(plans.some((entry) => entry.borrowed)
                      ? {
                          storage: { kind: "managed" as const },
                          branchDisposition: "created" as const,
                        }
                      : {}),
                  }),
              worktreePath: pathModule.relative(ticketDirectory, plan.worktreePath),
            } satisfies RepositoryEntry);
          },
          { concurrency: 1 }
        );

        const manifest: Manifest = {
          version: plans.some((plan) => plan.borrowed && plan.baseRemote)
            ? 6
            : plans.some((plan) => plan.borrowed)
              ? 5
              : parsedArgs.reuseBranch === undefined
                ? 3
                : 4,
          worktreesRoot: provenanceConfig.worktreesRoot,
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

        yield* verifyCreatedPlans(plans);
        for (const plan of plans) {
          if (plan.receiptRef) {
            yield* record({ action: "release-base-receipt", phase: "intent", ...plan });
            yield* releaseBaseReceipt(plan.managedRepoPath, plan).pipe(
              Effect.mapError(
                (error) => new CreateError({ message: error.message, ...domainDetails(error) })
              )
            );
            yield* record({ action: "release-base-receipt", phase: "confirmed", ...plan });
          }
        }
        yield* record({ action: "write-workspace-manifest", ticket: parsedArgs.ticket, manifest });
        yield* verifyCreatedPlans(plans);
        for (const plan of plans) {
          if (plan.releaseBranchLock) {
            yield* record({
              action: "release-existing-branch-lock",
              phase: "intent",
              repoId: plan.repoId,
              branch: plan.branch,
            });
            yield* plan.releaseBranchLock;
            yield* record({
              action: "release-existing-branch-lock",
              phase: "confirmed",
              repoId: plan.repoId,
              branch: plan.branch,
            });
          }
        }
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
              ...(plan.borrowed
                ? { storageKind: "borrowed" as const, commonDirectory: plan.managedRepoPath }
                : {}),
              ...baseOutput(plan),
            })),
          },
        } satisfies CommandOutput<"create">;
      }).pipe(
        Effect.mapError(
          (error) => new CreateError({ ...domainDetails(error), message: error.message })
        ),
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
    }).pipe(
      Effect.mapError((error) =>
        freshStarted
          ? new CreateError({
              message: `Fresh-base tracking/receipt updates are not rolled back; inspect the operation journal before retrying. ${error.message}`,
              ...domainDetails(error),
            })
          : error
      )
    );

    return result;
  }).pipe(
    Effect.scoped,
    Effect.mapError(
      (error) =>
        new CreateError({
          ...domainDetails(error),
          message:
            args.some((arg) => arg === "--remote" || arg.startsWith("--remote=")) &&
            !error.message.startsWith("Cached base: ")
              ? "Cached base: creation could not complete safely. Preserve all state and run outpost doctor --json; inspect the saved clone configuration outside Outpost. Raw Git diagnostics are withheld. Existing tickets require explicit workspace resume."
              : error.message,
        })
    )
  );
}
