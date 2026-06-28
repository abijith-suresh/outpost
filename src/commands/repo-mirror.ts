import * as Command from "@effect/platform/Command";
import type * as CommandExecutor from "@effect/platform/CommandExecutor";
import type { PlatformError } from "@effect/platform/Error";
import { Effect } from "effect";

function gitCommand(...args: ReadonlyArray<string>) {
  return Command.make("git", ...args).pipe(
    Command.env({
      GCM_INTERACTIVE: "never",
      GIT_TERMINAL_PROMPT: "0",
    }),
    Command.stderr("pipe"),
  );
}

export function cloneBareRepository(
  remoteUrl: string,
  managedRepoPath: string,
): Effect.Effect<void, PlatformError, CommandExecutor.CommandExecutor> {
  return Command.exitCode(
    gitCommand("clone", "--mirror", remoteUrl, managedRepoPath),
  ).pipe(
    Effect.flatMap((exitCode) =>
      exitCode === 0
        ? Effect.void
        : Effect.fail({
            _tag: "SystemError",
            reason: "Unknown",
            module: "Command",
            method: "clone",
            message: `git clone --mirror failed for ${remoteUrl}`,
          } as PlatformError),
    ),
  );
}

export function fetchBareRepository(
  managedRepoPath: string,
): Effect.Effect<void, PlatformError, CommandExecutor.CommandExecutor> {
  return Command.exitCode(
    gitCommand("fetch", "--all", "--prune", "--tags").pipe(
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

export function updateBareRepositoryRemote(
  managedRepoPath: string,
  remoteUrl: string,
): Effect.Effect<void, PlatformError, CommandExecutor.CommandExecutor> {
  return Command.exitCode(
    gitCommand("remote", "set-url", "origin", remoteUrl).pipe(
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
            method: "remote set-url",
            message: `git remote set-url failed for ${managedRepoPath}`,
          } as PlatformError),
    ),
  );
}
