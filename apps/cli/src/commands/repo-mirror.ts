import * as Effect from "effect/Effect";
import * as ChildProcess from "effect/process/ChildProcess";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import { commandResult, gitCommand } from "../child-process.js";
import { domainDetails, ErrorDetailFields, reasonDetails } from "../error-details.js";
import { DiagnosticSchema, DiagnosticTruncationSchema } from "../result-schemas.js";
import type { DiagnosticTruncation } from "../types.js";

export const RepoMirrorDiagnosticSchema = DiagnosticSchema;

export type RepoMirrorDiagnostic = typeof RepoMirrorDiagnosticSchema.Type;

export class RepoMirrorError extends Schema.TaggedError<RepoMirrorError>()("RepoMirrorError", {
  ...ErrorDetailFields,
  message: Schema.String,
  diagnostics: Schema.Array(RepoMirrorDiagnosticSchema),
  diagnosticTruncation: Schema.optional(DiagnosticTruncationSchema),
}) {}

function runGitCommand(
  command: ChildProcess.Command,
  failureMessage: string
): Effect.Effect<void, RepoMirrorError, ChildProcessSpawner.ChildProcessSpawner> {
  return commandResult(command).pipe(
    Effect.flatMap((result) => {
      const { diagnostics, diagnosticTruncation } = collectDiagnostics(result);
      return result.exitCode === 0
        ? Effect.void
        : Effect.fail(
            new RepoMirrorError({
              message: `${failureMessage} (exit status ${result.exitCode})`,
              diagnostics,
              diagnosticTruncation,
              ...reasonDetails("operation-failed"),
            })
          );
    }),
    Effect.mapError((error) =>
      error instanceof RepoMirrorError
        ? error
        : new RepoMirrorError({
            message: `${failureMessage}: ${error.message}`,
            diagnostics: [],
            ...domainDetails(error, "operation-failed"),
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

/** Bound formatted output as well as subprocess capture: tiny lines must not multiply JSON tokens. */
export const DIAGNOSTIC_LIMITS = { maxLines: 80, maxCharacters: 16_384 } as const;
export function collectDiagnostics(result: {
  stdout: { text: string; truncated: boolean };
  stderr: { text: string; truncated: boolean };
}): { diagnostics: RepoMirrorDiagnostic[]; diagnosticTruncation: DiagnosticTruncation } {
  const diagnostics: RepoMirrorDiagnostic[] = [];
  let omittedLineCount = 0;
  let truncated = false;
  const capturedOutputTruncated = result.stdout.truncated || result.stderr.truncated;
  for (const stream of ["stdout", "stderr"] as const) {
    let streamLines = 0;
    let streamCharacters = 0;
    for (const raw of result[stream].text.split(/\r?\n/u)) {
      const line = raw.trim();
      if (!line) continue;
      if (
        streamLines >= DIAGNOSTIC_LIMITS.maxLines / 2 ||
        streamCharacters >= DIAGNOSTIC_LIMITS.maxCharacters / 2
      ) {
        omittedLineCount++;
        truncated = true;
        continue;
      }
      const kept = line.slice(0, DIAGNOSTIC_LIMITS.maxCharacters / 2 - streamCharacters);
      truncated ||= kept.length < line.length;
      streamCharacters += kept.length;
      streamLines++;
      diagnostics.push({ stream, line: kept });
    }
  }
  return {
    diagnostics,
    diagnosticTruncation: {
      truncated: truncated || capturedOutputTruncated,
      omittedLineCount,
      capturedOutputTruncated,
      ...DIAGNOSTIC_LIMITS,
    },
  };
}
