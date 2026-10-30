import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { type PlatformError, systemError } from "effect/PlatformError";
import * as ChildProcess from "effect/process/ChildProcess";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

/** Git must inherit PATH/HOME while refusing interactive credential prompts. */
export function gitCommand(...args: ReadonlyArray<string>): ChildProcess.Command {
  const platformOptions = process.platform === "win32" ? ["-c", "core.longpaths=true"] : [];
  return ChildProcess.make("git", [...platformOptions, ...args], {
    extendEnv: true,
    env: {
      GCM_INTERACTIVE: "never",
      GIT_TERMINAL_PROMPT: "0",
      // Trace2 can read global targets/configParams before repository discovery and expose URLs.
      // Disable it for Outpost-owned Git children, including metadata-only verification children.
      GIT_TRACE2: "0",
      GIT_TRACE2_EVENT: "0",
      GIT_TRACE2_PERF: "0",
    },
  });
}

/** Creation must not lazily contact a promisor remote while resolving or checking owned objects.
 * Explicit fetch commands still work; this disables only Git's implicit object fetches. */
export function noLazyFetchGitCommand(...args: ReadonlyArray<string>): ChildProcess.Command {
  return gitCommand(...args).pipe(ChildProcess.setEnv({ GIT_NO_LAZY_FETCH: "1" }));
}

/** Inspection must not fetch objects, refresh indexes or execute fsmonitor hooks. */
export function readOnlyGitCommand(...args: ReadonlyArray<string>): ChildProcess.Command {
  return noLazyFetchGitCommand(
    "--no-optional-locks",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.untrackedCache=false",
    ...args
  ).pipe(ChildProcess.setEnv({ GIT_OPTIONAL_LOCKS: "0" }));
}

type CommandOptions = {
  /** Defaults to OUTPOST_GIT_TIMEOUT_MS, or 120 seconds. */
  timeoutMs?: number;
  /** Per stream, retained bytes. Both pipes are drained even beyond this limit. */
  maxOutputBytes?: number;
};

type CapturedOutput = { text: string; truncated: boolean };

function capture(
  stream: Stream.Stream<Uint8Array, PlatformError>,
  limit: number
): Effect.Effect<CapturedOutput, PlatformError> {
  return Effect.suspend(() => {
    const decoder = new TextDecoder();
    let remaining = limit;
    let text = "";
    let truncated = false;
    return Stream.runForEach(stream, (chunk) =>
      Effect.sync(() => {
        const retained = chunk.subarray(0, remaining);
        text += decoder.decode(retained, { stream: true });
        remaining -= retained.byteLength;
        truncated ||= retained.byteLength < chunk.byteLength;
      })
    ).pipe(Effect.map(() => ({ text: text + decoder.decode(), truncated })));
  });
}

function executionError(description: string): PlatformError {
  return systemError({ _tag: "Unknown", module: "ChildProcess", method: "execute", description });
}

const terminationGraceMs = 1_000;

/** Own a separate POSIX process group and escalate if SIGTERM is ignored.
 * Apply this to every member of a pipeline as well as ordinary Git commands.
 */
function withTerminationPolicy(command: ChildProcess.Command): ChildProcess.Command {
  if (command._tag === "PipedCommand") {
    return ChildProcess.pipeTo(
      withTerminationPolicy(command.left),
      withTerminationPolicy(command.right),
      command.options
    );
  }
  return ChildProcess.make(command.command, command.args, {
    ...command.options,
    detached: process.platform !== "win32",
    killSignal: "SIGTERM",
    forceKillAfter: terminationGraceMs,
  });
}

/** Hold a verify-only Git transaction. Aborting releases Git's own ref locks without writing refs. */
function acquireRefTransaction(
  repoPath: string,
  ref: string,
  commit: string,
  options: { create?: boolean; command?: typeof noLazyFetchGitCommand; strict?: boolean } = {}
) {
  return Effect.gen(function* () {
    const timeoutMs = Number(process.env.OUTPOST_GIT_TIMEOUT_MS ?? 120_000);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
      return yield* Effect.fail(executionError("Command timeout must be positive and finite."));
    const prepared = yield* Deferred.make<void, PlatformError>();
    const aborted = yield* Deferred.make<void, PlatformError>();
    const committed = yield* Deferred.make<void, PlatformError>();
    const stdoutEnded = yield* Deferred.make<void, PlatformError>();
    const stderrEnded = yield* Deferred.make<void, PlatformError>();
    const input = yield* Queue.unbounded<Uint8Array, Cause.Done>();
    const command = withTerminationPolicy(
      (options.command ?? noLazyFetchGitCommand)(
        "--git-dir",
        repoPath,
        "update-ref",
        "--no-deref",
        "--stdin"
      )
    );
    if (command._tag !== "StandardCommand")
      return yield* Effect.fail(executionError("Expected a single Git ref verification command."));
    const child = yield* ChildProcess.make(command.command, command.args, {
      ...command.options,
      stdin: Stream.fromQueue(input),
    });
    let diagnostic = "";
    let diagnosticOverflow = false;
    let diagnosticBytes = 0;
    yield* Stream.runForEach(child.stderr, (bytes) =>
      Effect.sync(() => {
        const available = Math.max(0, 8192 - diagnosticBytes);
        diagnosticBytes += bytes.byteLength;
        diagnosticOverflow ||= diagnosticBytes > 8192;
        diagnostic += new TextDecoder().decode(bytes.subarray(0, available));
      })
    ).pipe(
      Effect.andThen(Deferred.succeed(stderrEnded, undefined)),
      Effect.catch((error) => Deferred.fail(stderrEnded, error)),
      Effect.forkScoped
    );
    let protocol = "";
    let protocolBytes = 0;
    let protocolOverflow = false;
    let wasPrepared = false;
    yield* child.stdout.pipe(
      Stream.runForEach((bytes) => {
        protocolBytes += bytes.byteLength;
        protocolOverflow ||= protocolBytes > 8192;
        if (protocolOverflow)
          return Deferred.fail(
            prepared,
            executionError("Git ref verification output exceeded its protocol bound.")
          );
        protocol += new TextDecoder().decode(bytes);
        return Effect.gen(function* () {
          if (protocol.split(/\r?\n/).includes("prepare: ok")) {
            wasPrepared = true;
            yield* Deferred.succeed(prepared, undefined);
          }
          if (protocol.split(/\r?\n/).includes("commit: ok"))
            yield* Deferred.succeed(committed, undefined);
          if (protocol.split(/\r?\n/).includes("abort: ok"))
            yield* Deferred.succeed(aborted, undefined);
        });
      }),
      Effect.andThen(Deferred.succeed(stdoutEnded, undefined)),
      Effect.catch((error) =>
        Effect.all([Deferred.fail(prepared, error), Deferred.fail(stdoutEnded, error)])
      ),
      Effect.forkScoped
    );
    yield* child.exitCode.pipe(
      Effect.flatMap((code) =>
        Deferred.fail(
          prepared,
          executionError(`Cannot lock existing branch ${ref} (exit ${code}). ${diagnostic}`)
        )
      ),
      Effect.catch((error) => Deferred.fail(prepared, error)),
      Effect.forkScoped
    );
    let released = false;
    const finish = (operation: "abort" | "commit") =>
      Effect.gen(function* () {
        if (released) return;
        if (!wasPrepared && !(yield* child.isRunning)) {
          released = true;
          return;
        }
        yield* Queue.offer(input, new TextEncoder().encode(`${operation}\n`));
        // Ordered EOF closes stdin after abort without depending on Windows signals.
        yield* Queue.end(input);
        const code = yield* child.exitCode;
        if (code !== 0)
          return yield* Effect.fail(
            executionError(
              `Existing branch lock cleanup failed for ${ref}. Preserve its lock and inspect the operation journal. ${diagnostic}`
            )
          );
        yield* Deferred.await(operation === "commit" ? committed : aborted);
        if (options.strict)
          yield* Effect.all([Deferred.await(stdoutEnded), Deferred.await(stderrEnded)]);
        if (
          options.strict &&
          (diagnosticOverflow ||
            protocolOverflow ||
            protocol.replaceAll("\r\n", "\n") !== `start: ok\nprepare: ok\n${operation}: ok\n`)
        )
          return yield* Effect.fail(
            executionError("Incomplete strict ref transaction acknowledgement; preserve state.")
          );
        released = true;
      }).pipe(
        Effect.timeoutOrElse({
          duration: "2 seconds",
          orElse: () =>
            child
              .kill({ killSignal: "SIGTERM", forceKillAfter: terminationGraceMs })
              .pipe(
                Effect.andThen(
                  Effect.fail(
                    executionError(
                      `Existing branch lock cleanup was not confirmed for ${ref}; preserve state and inspect the operation journal.`
                    )
                  )
                )
              ),
        })
      );
    const release = finish("abort");
    // Ordinary success explicitly checks release before admitting a manifest.
    // This idempotent fallback also attempts release during failure/cancellation;
    // a failed operation's recorded plan remains manual recovery evidence.
    yield* Effect.acquireRelease(Effect.void, () => release.pipe(Effect.ignore));
    yield* Queue.offer(
      input,
      new TextEncoder().encode(
        `start\n${options.create ? "create" : "verify"} ${ref} ${commit}\nprepare\n`
      )
    );
    yield* Deferred.await(prepared).pipe(
      Effect.timeoutOrElse({
        duration: timeoutMs,
        orElse: () => Effect.fail(executionError(`Timed out locking existing branch ${ref}.`)),
      })
    );
    if (
      options.strict &&
      (diagnosticOverflow ||
        protocolOverflow ||
        protocol.replaceAll("\r\n", "\n") !== "start: ok\nprepare: ok\n")
    )
      return yield* Effect.fail(executionError("Incomplete strict prepared transaction response."));
    const verify = child.isRunning.pipe(
      Effect.flatMap((running) =>
        running
          ? Effect.void
          : Effect.fail(
              executionError(
                `Existing branch verification ended for ${ref}; preserve residual work and inspect outpost doctor --json.`
              )
            )
      )
    );
    return { verify, release, commit: finish("commit") };
  });
}

export function acquireBranchVerification(repoPath: string, ref: string, commit: string) {
  return acquireRefTransaction(repoPath, ref, commit).pipe(
    Effect.map(({ verify, release }) => ({ verify, release }))
  );
}

/** New refs are rechecked for symbolic identity under the prepared create lock. */
export function acquireBranchCreation(
  repoPath: string,
  ref: string,
  commit: string,
  command: typeof noLazyFetchGitCommand,
  strict = false
) {
  return acquireRefTransaction(repoPath, ref, commit, { create: true, command, strict });
}

/**
 * Scoped execution drains stdout, stderr, and waits concurrently. Interruption
 * and timeout close the process scope, requesting SIGTERM and escalating to
 * SIGKILL after one second. POSIX cleanup covers the owned process group;
 * detached descendants and OS-level termination failures have platform limits.
 * A nonzero status is intentionally returned for callers implementing probes.
 */
export function commandResult(command: ChildProcess.Command, options: CommandOptions = {}) {
  return Effect.suspend(() => {
    const timeoutMs = options.timeoutMs ?? Number(process.env.OUTPOST_GIT_TIMEOUT_MS ?? 120_000);
    const maxOutputBytes = options.maxOutputBytes ?? 256 * 1024;
    if (
      !Number.isFinite(timeoutMs) ||
      timeoutMs <= 0 ||
      !Number.isSafeInteger(maxOutputBytes) ||
      maxOutputBytes < 1
    ) {
      return Effect.fail(
        executionError("Command timeout and output limit must be positive finite values.")
      );
    }
    return Effect.scoped(
      Effect.gen(function* () {
        const child = yield* withTerminationPolicy(command);
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            capture(child.stdout, maxOutputBytes),
            capture(child.stderr, maxOutputBytes),
            child.exitCode,
          ],
          { concurrency: "unbounded" }
        );
        return { stdout, stderr, exitCode };
      })
    ).pipe(
      Effect.timeoutOrElse({
        duration: timeoutMs,
        orElse: () =>
          Effect.fail(
            executionError(
              `Command timed out after ${timeoutMs}ms. Set OUTPOST_GIT_TIMEOUT_MS to change the limit.`
            )
          ),
      })
    );
  });
}

/** Exit-status probes explicitly accept nonzero statuses, but still drain both pipes. */
export function commandExitCode(
  command: ChildProcess.Command,
  options?: CommandOptions
): Effect.Effect<
  ChildProcessSpawner.ExitCode,
  PlatformError,
  ChildProcessSpawner.ChildProcessSpawner
> {
  return commandResult(command, options).pipe(Effect.map((result) => result.exitCode));
}

/** Output consumers must never mistake failed or truncated output for a result. */
export function commandString(
  command: ChildProcess.Command,
  options?: CommandOptions
): Effect.Effect<string, PlatformError, ChildProcessSpawner.ChildProcessSpawner> {
  return commandResult(command, options).pipe(
    Effect.flatMap((result) => {
      if (result.exitCode !== 0) {
        return Effect.fail(
          executionError(
            `Command failed (exit status ${result.exitCode}): ${result.stderr.text}${result.stderr.truncated ? " [stderr truncated]" : ""}`
          )
        );
      }
      if (result.stdout.truncated) {
        return Effect.fail(executionError("Command stdout exceeded the configured output limit."));
      }
      return Effect.succeed(result.stdout.text);
    })
  );
}
