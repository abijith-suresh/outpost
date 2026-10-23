import { Effect, Schema, Stream } from "effect";
import type { PlatformError } from "effect/PlatformError";
import * as ChildProcess from "effect/process/ChildProcess";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { gitCommand } from "../child-process.js";

export const RepoMirrorDiagnosticSchema = Schema.Struct({
  stream: Schema.Literals(["stdout", "stderr"]),
  line: Schema.String,
});

export type RepoMirrorDiagnostic = typeof RepoMirrorDiagnosticSchema.Type;

export class RepoMirrorError extends Schema.TaggedError<RepoMirrorError>()("RepoMirrorError", {
  message: Schema.String,
  diagnostics: Schema.Array(RepoMirrorDiagnosticSchema),
}) {}

function captureDiagnosticLines(
  stream: Stream.Stream<Uint8Array, PlatformError>,
  source: RepoMirrorDiagnostic["stream"]
): Effect.Effect<ReadonlyArray<RepoMirrorDiagnostic>, PlatformError> {
  return stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (output, chunk) => output + chunk
    ),
    Effect.map((output) =>
      output
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => ({ stream: source, line }))
    )
  );
}

function runGitCommand(
  command: ChildProcess.Command,
  failureMessage: string
): Effect.Effect<void, RepoMirrorError, ChildProcessSpawner.ChildProcessSpawner> {
  return Effect.scoped(
    Effect.gen(function* () {
      const process = yield* command;
      const [stdoutDiagnostics, stderrDiagnostics, exitCode] = yield* Effect.all(
        [
          captureDiagnosticLines(process.stdout, "stdout"),
          captureDiagnosticLines(process.stderr, "stderr"),
          process.exitCode,
        ] as const,
        { concurrency: "unbounded" }
      );
      const diagnostics = [...stdoutDiagnostics, ...stderrDiagnostics];

      if (exitCode !== 0) {
        return yield* Effect.fail(
          new RepoMirrorError({
            message: `${failureMessage} (exit status ${exitCode})`,
            diagnostics,
          })
        );
      }
    })
  ).pipe(
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
