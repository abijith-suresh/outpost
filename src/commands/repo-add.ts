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

type RepoAddPreflight = {
  repoPath: string;
  repoName: string;
  outpostHome: string;
  worktreesRoot: string;
  ready: boolean;
  blockers: ReadonlyArray<string>;
};

function getRepoName(
  repoPath: string,
): Effect.Effect<string, never, Path.Path> {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    return path.basename(repoPath);
  });
}

function checkGitRepository(
  repoPath: string,
): Effect.Effect<boolean, PlatformError, CommandExecutor.CommandExecutor> {
  return Command.exitCode(
    Command.make("git", "rev-parse", "--is-inside-work-tree").pipe(
      Command.workingDirectory(repoPath),
      Command.env({
        GCM_INTERACTIVE: "never",
        GIT_TERMINAL_PROMPT: "0",
      }),
    ),
  ).pipe(Effect.map((exitCode) => exitCode === 0));
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
    const repoPath = path.resolve(inputPath);
    const repoName = yield* getRepoName(repoPath);
    const exists = yield* fs
      .exists(repoPath)
      .pipe(
        Effect.mapError(
          (error) => new RepoAddError({ message: error.message }),
        ),
      );

    if (!exists) {
      return yield* Effect.fail(
        new RepoAddError({
          message: `Repository path does not exist: ${repoPath}`,
        }),
      );
    }

    const isGitRepository = yield* checkGitRepository(repoPath).pipe(
      Effect.mapError((error) => new RepoAddError({ message: error.message })),
    );

    const blockers = isGitRepository ? [] : ["Path is not a Git working tree."];

    const data: RepoAddPreflight = {
      repoPath,
      repoName,
      outpostHome: config.outpostHome,
      worktreesRoot: config.worktreesRoot,
      ready: blockers.length === 0,
      blockers,
    };

    return {
      command: "repo add",
      data,
    } satisfies CommandOutput;
  });
}
