import { Effect, Stream } from "effect";
import { type PlatformError, systemError } from "effect/PlatformError";
import * as ChildProcess from "effect/process/ChildProcess";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

/** Git must inherit PATH/HOME while refusing interactive credential prompts. */
export function gitCommand(...args: ReadonlyArray<string>): ChildProcess.Command {
  return ChildProcess.make("git", [...args], {
    extendEnv: true,
    env: { GCM_INTERACTIVE: "never", GIT_TERMINAL_PROMPT: "0" },
  });
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
