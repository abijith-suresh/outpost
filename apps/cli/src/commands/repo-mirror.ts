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
  return runGitCommand(
    gitCommand("clone", "--mirror", remoteUrl, managedRepoPath),
    `git clone --mirror failed for ${remoteUrl}`
  );
}

export function fetchBareRepository(
  managedRepoPath: string
): Effect.Effect<void, RepoMirrorError, ChildProcessSpawner.ChildProcessSpawner> {
  return runGitCommand(
    gitCommand("fetch", "--all", "--prune", "--tags").pipe(ChildProcess.setCwd(managedRepoPath)),
    `git fetch failed for ${managedRepoPath}`
  );
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
