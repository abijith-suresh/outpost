import { Effect, Schema } from "effect";
import * as ChildProcess from "effect/process/ChildProcess";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { commandResult, gitCommand } from "../child-process.js";

export const RepoMirrorDiagnosticSchema = Schema.Struct({
  stream: Schema.Literals(["stdout", "stderr"]),
  line: Schema.String,
});

export type RepoMirrorDiagnostic = typeof RepoMirrorDiagnosticSchema.Type;

export class RepoMirrorError extends Schema.TaggedError<RepoMirrorError>()("RepoMirrorError", {
  message: Schema.String,
  diagnostics: Schema.Array(RepoMirrorDiagnosticSchema),
}) {}

function runGitCommand(
  command: ChildProcess.Command,
  failureMessage: string
): Effect.Effect<void, RepoMirrorError, ChildProcessSpawner.ChildProcessSpawner> {
  return commandResult(command).pipe(
    Effect.flatMap((result) => {
      const diagnostics: Array<RepoMirrorDiagnostic> = [];
      for (const source of ["stdout", "stderr"] as const) {
        for (const rawLine of result[source].text.split(/\r?\n/u)) {
          const line = rawLine.trim();
          if (line) diagnostics.push({ stream: source, line });
        }
        if (result[source].truncated) {
          diagnostics.push({ stream: source, line: "[output truncated]" });
        }
      }
      return result.exitCode === 0
        ? Effect.void
        : Effect.fail(
            new RepoMirrorError({
              message: `${failureMessage} (exit status ${result.exitCode})`,
              diagnostics,
            })
          );
    }),
    Effect.mapError((error) =>
      error instanceof RepoMirrorError
        ? error
        : new RepoMirrorError({
            message: `${failureMessage}: ${error.message}`,
            diagnostics: [],
          })
    )
  );
}

export function cloneBareRepository(
  remoteUrl: string,
  managedRepoPath: string
): Effect.Effect<void, RepoMirrorError, ChildProcessSpawner.ChildProcessSpawner> {
  return Effect.gen(function* () {
    yield* runGitCommand(
      gitCommand("clone", "--mirror", remoteUrl, managedRepoPath),
      `git clone --mirror failed for ${remoteUrl}`
    );
    yield* fetchBareRepository(managedRepoPath);
  });
}

export function fetchBareRepository(
  managedRepoPath: string
): Effect.Effect<void, RepoMirrorError, ChildProcessSpawner.ChildProcessSpawner> {
  return Effect.gen(function* () {
    // Replace the legacy mirror refspec before fetching. Never rewrite or delete
    // refs/heads: they may contain work created by agents or older workspaces.
    yield* runGitCommand(
      gitCommand(
        "config",
        "--replace-all",
        "remote.origin.fetch",
        "+refs/heads/*:refs/remotes/origin/*"
      ).pipe(ChildProcess.setCwd(managedRepoPath)),
      `Failed to configure safe fetch refs for ${managedRepoPath}`
    );
    yield* runGitCommand(
      gitCommand("config", "remote.origin.mirror", "false").pipe(
        ChildProcess.setCwd(managedRepoPath)
      ),
      `Failed to disable mirror updates for ${managedRepoPath}`
    );
    yield* runGitCommand(
      gitCommand("fetch", "origin", "--prune", "--tags").pipe(ChildProcess.setCwd(managedRepoPath)),
      `git fetch failed for ${managedRepoPath}`
    );
  });
}

export function updateBareRepositoryRemote(
  managedRepoPath: string,
  remoteUrl: string
): Effect.Effect<void, RepoMirrorError, ChildProcessSpawner.ChildProcessSpawner> {
  return runGitCommand(
    gitCommand("remote", "set-url", "origin", remoteUrl).pipe(ChildProcess.setCwd(managedRepoPath)),
    `git remote set-url failed for ${managedRepoPath}`
  );
}
