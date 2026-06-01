import * as Command from "@effect/platform/Command";
import type * as CommandExecutor from "@effect/platform/CommandExecutor";
import * as FileSystem from "@effect/platform/FileSystem";
import type { PlatformError } from "@effect/platform/Error";
import * as Path from "@effect/platform/Path";
import { Effect, Schema } from "effect";

import {
  loadConfig,
  loadRepoRegistry,
  resolveOutpostHome,
  writeRepoRegistry,
} from "../config.js";
import { cloneBareRepository, fetchBareRepository } from "./repo-mirror.js";
import type { CommandOutput } from "../types.js";

export class RepoAddError extends Schema.TaggedError<RepoAddError>()(
  "RepoAddError",
  {
    message: Schema.String,
  },
) {}

type RepoImportResult = {
  action: "cloned" | "fetched";
  registryAction: "created" | "updated";
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

type RepoAddOptions = {
  remoteName?: string;
};

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
    Command.make("git", "rev-parse", "--is-inside-work-tree").pipe(
      Command.env({
        GCM_INTERACTIVE: "never",
        GIT_TERMINAL_PROMPT: "0",
      }),
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
    Command.make("git", "remote").pipe(
      Command.env({
        GCM_INTERACTIVE: "never",
        GIT_TERMINAL_PROMPT: "0",
      }),
      Command.workingDirectory(repoPath),
    ),
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
    Command.make("git", "remote", "get-url", remoteName).pipe(
      Command.env({
        GCM_INTERACTIVE: "never",
        GIT_TERMINAL_PROMPT: "0",
      }),
      Command.workingDirectory(repoPath),
    ),
  ).pipe(Effect.map((output) => output.trim()));
}

function selectRemoteName(
  remoteNames: ReadonlyArray<string>,
  requestedRemoteName: string | undefined,
): Effect.Effect<string, RepoAddError> {
  if (requestedRemoteName) {
    if (!remoteNames.includes(requestedRemoteName)) {
      return Effect.fail(
        new RepoAddError({
          message: `Unknown remote: ${requestedRemoteName}. Available remotes: ${remoteNames.join(", ")}.`,
        }),
      );
    }

    return Effect.succeed(requestedRemoteName);
  }

  if (remoteNames.length > 1) {
    return Effect.fail(
      new RepoAddError({
        message: `Repository has multiple remotes (${remoteNames.join(", ")}). Use --remote <name> to choose which remote to import.`,
      }),
    );
  }

  return Effect.succeed(remoteNames[0] as string);
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

export function runRepoAdd(
  inputPath: string | undefined,
  options: RepoAddOptions = {},
): Effect.Effect<
  CommandOutput,
  RepoAddError,
  FileSystem.FileSystem | Path.Path | CommandExecutor.CommandExecutor
> {
  return Effect.gen(function* () {
    if (!inputPath) {
      return yield* Effect.fail(
        new RepoAddError({
          message: "Usage: outpost repo add <path> [--remote <name>]",
        }),
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

    const remoteName = yield* selectRemoteName(remoteNames, options.remoteName);
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

    const now = new Date().toISOString();
    const registry = yield* loadRepoRegistry(outpostHome).pipe(
      Effect.mapError((error) => new RepoAddError({ message: error.message })),
    );
    const existingRecord = registry.repos.find(
      (repo) => repo.managedRepoPath === managedRepoPath,
    );
    const updatedRecord = {
      id: sanitizeRemoteUrl(remoteUrl),
      importedAt: existingRecord?.importedAt ?? now,
      lastFetchedAt: now,
      managedRepoPath,
      name: repoName,
      remoteName,
      remoteUrl,
      sourceRepoPath,
    };
    const nextRegistry = {
      ...registry,
      repos: existingRecord
        ? registry.repos.map((repo) =>
            repo.managedRepoPath === managedRepoPath ? updatedRecord : repo,
          )
        : [...registry.repos, updatedRecord],
    };

    yield* writeRepoRegistry(outpostHome, nextRegistry).pipe(
      Effect.mapError((error) => new RepoAddError({ message: error.message })),
    );

    const data: RepoImportResult = {
      action: managedRepoExists ? "fetched" : "cloned",
      registryAction: existingRecord ? "updated" : "created",
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
