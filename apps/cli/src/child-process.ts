import { Effect } from "effect";
import type { PlatformError } from "effect/PlatformError";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
/**
 * A `git` command that never hangs on interactive prompts.
 *
 * The environment is explicitly extended from the parent process because
 * effect v4 child processes default to *replacing* the inherited environment
 * when `env` is set, which would drop `PATH`, `HOME`, and friends.
 */
export function gitCommand(...args: ReadonlyArray<string>): ChildProcess.Command {
  return ChildProcess.make("git", [...args], {
    extendEnv: true,
    env: {
      GCM_INTERACTIVE: "never",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
}

/**
 * Run a command to completion and return its exit code.
 */
export function commandExitCode(
  command: ChildProcess.Command
): Effect.Effect<
  ChildProcessSpawner.ExitCode,
  PlatformError,
  ChildProcessSpawner.ChildProcessSpawner
> {
  return Effect.flatMap(ChildProcessSpawner.ChildProcessSpawner, (spawner) =>
    spawner.exitCode(command)
  );
}

/**
 * Run a command to completion and return its standard output as a string.
 */
export function commandString(
  command: ChildProcess.Command
): Effect.Effect<string, PlatformError, ChildProcessSpawner.ChildProcessSpawner> {
  return Effect.flatMap(ChildProcessSpawner.ChildProcessSpawner, (spawner) =>
    spawner.string(command)
  );
}
