import * as Command from "@effect/platform/Command";
import type * as CommandExecutor from "@effect/platform/CommandExecutor";
import type { PlatformError } from "@effect/platform/Error";
import { Effect, Schema, Stream } from "effect";

export const RepoMirrorDiagnosticSchema = Schema.Struct({
  stream: Schema.Literal("stdout", "stderr"),
  line: Schema.String,
});

export type RepoMirrorDiagnostic = typeof RepoMirrorDiagnosticSchema.Type;

export class RepoMirrorError extends Schema.TaggedError<RepoMirrorError>()(
  "RepoMirrorError",
  {
    message: Schema.String,
    diagnostics: Schema.Array(RepoMirrorDiagnosticSchema),
  },
) {}

function gitCommand(...args: ReadonlyArray<string>) {
  return Command.make("git", ...args).pipe(
    Command.env({
      GCM_INTERACTIVE: "never",
      GIT_TERMINAL_PROMPT: "0",
    }),
    Command.stdout("pipe"),
    Command.stderr("pipe"),
  );
}

function captureDiagnosticLines(
  stream: Stream.Stream<Uint8Array, PlatformError>,
  source: RepoMirrorDiagnostic["stream"],
): Effect.Effect<ReadonlyArray<RepoMirrorDiagnostic>, PlatformError> {
  return stream.pipe(
    Stream.decodeText(),
    Stream.runFold("", (output, chunk) => output + chunk),
    Effect.map((output) =>
      output
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => ({ stream: source, line })),
    ),
  );
}

function runGitCommand(
  command: Command.Command,
  failureMessage: string,
): Effect.Effect<void, RepoMirrorError, CommandExecutor.CommandExecutor> {
  return Effect.scoped(
    Effect.gen(function* () {
      const process = yield* Command.start(command);
      const [stdoutDiagnostics, stderrDiagnostics, exitCode] =
        yield* Effect.all(
          [
            captureDiagnosticLines(process.stdout, "stdout"),
            captureDiagnosticLines(process.stderr, "stderr"),
            process.exitCode,
          ] as const,
          { concurrency: "unbounded" },
        );
      const diagnostics = [...stdoutDiagnostics, ...stderrDiagnostics];

      if (exitCode !== 0) {
        return yield* Effect.fail(
          new RepoMirrorError({
            message: `${failureMessage} (exit status ${exitCode})`,
            diagnostics,
          }),
        );
      }
    }),
  ).pipe(
    Effect.mapError((error) =>
      error instanceof RepoMirrorError
        ? error
        : new RepoMirrorError({
            message: `${failureMessage}: ${error.message}`,
            diagnostics: [],
          }),
    ),
  );
}

export function cloneBareRepository(
  remoteUrl: string,
  managedRepoPath: string,
): Effect.Effect<void, RepoMirrorError, CommandExecutor.CommandExecutor> {
  return runGitCommand(
    gitCommand("clone", "--mirror", remoteUrl, managedRepoPath),
    `git clone --mirror failed for ${remoteUrl}`,
  );
}

export function fetchBareRepository(
  managedRepoPath: string,
): Effect.Effect<void, RepoMirrorError, CommandExecutor.CommandExecutor> {
  return runGitCommand(
    gitCommand("fetch", "--all", "--prune", "--tags").pipe(
      Command.workingDirectory(managedRepoPath),
    ),
    `git fetch failed for ${managedRepoPath}`,
  );
}

export function updateBareRepositoryRemote(
  managedRepoPath: string,
  remoteUrl: string,
): Effect.Effect<void, RepoMirrorError, CommandExecutor.CommandExecutor> {
  return runGitCommand(
    gitCommand("remote", "set-url", "origin", remoteUrl).pipe(
      Command.workingDirectory(managedRepoPath),
    ),
    `git remote set-url failed for ${managedRepoPath}`,
  );
}
