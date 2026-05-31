import * as Command from "@effect/platform/Command";
import type * as CommandExecutor from "@effect/platform/CommandExecutor";
import * as FileSystem from "@effect/platform/FileSystem";
import type { PlatformError } from "@effect/platform/Error";
import * as Path from "@effect/platform/Path";
import { Effect, Schema } from "effect";

import { loadConfig, resolveOutpostHome } from "../config.js";
import type { CommandOutput } from "../types.js";

export class RepoAddError extends Schema.TaggedError<RepoAddError>()(
  "RepoAddError",
  {
    message: Schema.String,
  },
) {}

type RepoImportResult = {
  action: "cloned" | "fetched";
  remoteName: string;
  remoteUrl: string;
  sourceRepoPath: string;
  repoName: string;
  repoPath: string;
  outpostHome: string;
  reposRoot: string;
  worktreesRoot: string;
  ready: boolean;
  blockers: ReadonlyArray<string>;
};

function gitCommand(...args: ReadonlyArray<string>) {
  return Command.make("git", ...args).pipe(
    Command.env({
      GCM_INTERACTIVE: "never",
      GIT_TERMINAL_PROMPT: "0",
    }),
  );
}

function getRepoName(
  repoPath: string,
): Effect.Effect<string, never, Path.Path> {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    return path.basename(repoPath);
  });
}

function sanitizeRemoteUrl(remoteUrl: string): string {
  return remoteUrl
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function checkGitRepository(
  repoPath: string,
): Effect.Effect<boolean, PlatformError, CommandExecutor.CommandExecutor> {
  return Command.exitCode(
    gitCommand("rev-parse", "--is-inside-work-tree").pipe(
      Command.workingDirectory(repoPath),
    ),
  ).pipe(Effect.map((exitCode) => exitCode === 0));
}

function getRemoteNames(
  repoPath: string,
): Effect.Effect<
  ReadonlyArray<string>,
  PlatformError,
  CommandExecutor.CommandExecutor
> {
  return Command.string(
    gitCommand("remote").pipe(Command.workingDirectory(repoPath)),
  ).pipe(
    Effect.map((output) =>
      output
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    ),
  );
}

function getRemoteUrl(
  repoPath: string,
  remoteName: string,
): Effect.Effect<string, PlatformError, CommandExecutor.CommandExecutor> {
  return Command.string(
    gitCommand("remote", "get-url", remoteName).pipe(
      Command.workingDirectory(repoPath),
    ),
  ).pipe(Effect.map((output) => output.trim()));
}

function getManagedRepoPath(
  reposRoot: string,
  remoteUrl: string,
): Effect.Effect<string, never, Path.Path> {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    return path.join(reposRoot, `${sanitizeRemoteUrl(remoteUrl)}.git`);
  });
}

function cloneBareRepository(
  remoteUrl: string,
  managedRepoPath: string,
): Effect.Effect<void, PlatformError, CommandExecutor.CommandExecutor> {
  return Command.exitCode(
    gitCommand("clone", "--bare", remoteUrl, managedRepoPath),
  ).pipe(
    Effect.flatMap((exitCode) =>
      exitCode === 0
        ? Effect.void
        : Effect.fail({
            _tag: "SystemError",
            reason: "Unknown",
            module: "Command",
            method: "clone",
            message: `git clone --bare failed for ${remoteUrl}`,
          } as PlatformError),
    ),
  );
}

function fetchBareRepository(
  managedRepoPath: string,
): Effect.Effect<void, PlatformError, CommandExecutor.CommandExecutor> {
  return Command.exitCode(
    gitCommand("fetch", "--prune", "--tags", "origin").pipe(
      Command.workingDirectory(managedRepoPath),
    ),
  ).pipe(
    Effect.flatMap((exitCode) =>
      exitCode === 0
        ? Effect.void
        : Effect.fail({
            _tag: "SystemError",
            reason: "Unknown",
            module: "Command",
            method: "fetch",
            message: `git fetch failed for ${managedRepoPath}`,
          } as PlatformError),
    ),
  );
}

export function runRepoAdd(
  inputPath: string | undefined,
): Effect.Effect<
  CommandOutput,
  RepoAddError,
  FileSystem.FileSystem | Path.Path | CommandExecutor.CommandExecutor
> {
  return Effect.gen(function* () {
    if (!inputPath) {
      return yield* Effect.fail(
        new RepoAddError({ message: "Usage: outpost repo add <path>" }),
      );
    }

    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const outpostHome = yield* resolveOutpostHome();
    const config = yield* loadConfig(outpostHome).pipe(
      Effect.mapError((error) => new RepoAddError({ message: error.message })),
    );
    const sourceRepoPath = path.resolve(inputPath);
    const repoName = yield* getRepoName(sourceRepoPath);
    const exists = yield* fs
      .exists(sourceRepoPath)
      .pipe(
        Effect.mapError(
          (error) => new RepoAddError({ message: error.message }),
        ),
      );

    if (!exists) {
      return yield* Effect.fail(
        new RepoAddError({
          message: `Repository path does not exist: ${sourceRepoPath}`,
        }),
      );
    }

    const isGitRepository = yield* checkGitRepository(sourceRepoPath).pipe(
      Effect.mapError((error) => new RepoAddError({ message: error.message })),
    );

    if (!isGitRepository) {
      return yield* Effect.fail(
        new RepoAddError({ message: "Path is not a Git working tree." }),
      );
    }

    const remoteNames = yield* getRemoteNames(sourceRepoPath).pipe(
      Effect.mapError((error) => new RepoAddError({ message: error.message })),
    );

    if (remoteNames.length === 0) {
      return yield* Effect.fail(
        new RepoAddError({
          message: "Repository has no remotes to import from.",
        }),
      );
    }

    if (remoteNames.length > 1) {
      return yield* Effect.fail(
        new RepoAddError({
          message: `Repository has multiple remotes (${remoteNames.join(", ")}). Remote selection is not implemented yet.`,
        }),
      );
    }

    const remoteName = remoteNames[0] as string;
    const remoteUrl = yield* getRemoteUrl(sourceRepoPath, remoteName).pipe(
      Effect.mapError((error) => new RepoAddError({ message: error.message })),
    );
    const managedRepoPath = yield* getManagedRepoPath(
      config.reposRoot,
      remoteUrl,
    );
    const managedRepoExists = yield* fs
      .exists(managedRepoPath)
      .pipe(
        Effect.mapError(
          (error) => new RepoAddError({ message: error.message }),
        ),
      );

    if (managedRepoExists) {
      yield* fetchBareRepository(managedRepoPath).pipe(
        Effect.mapError(
          (error) => new RepoAddError({ message: error.message }),
        ),
      );
    } else {
      yield* cloneBareRepository(remoteUrl, managedRepoPath).pipe(
        Effect.mapError(
          (error) => new RepoAddError({ message: error.message }),
        ),
      );
    }

    const data: RepoImportResult = {
      action: managedRepoExists ? "fetched" : "cloned",
      remoteName,
      remoteUrl,
      sourceRepoPath,
      repoName,
      repoPath: managedRepoPath,
      outpostHome: config.outpostHome,
      reposRoot: config.reposRoot,
      worktreesRoot: config.worktreesRoot,
      ready: true,
      blockers: [],
    };

    return {
      command: "repo add",
      data,
    } satisfies CommandOutput;
  });
}
