import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type * as ChildProcess from "effect/unstable/process/ChildProcess";
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

/**
 * Effect 4 migration helpers.
 *
 * The v3 `Command.exitCode` / `Command.string` execution helpers were replaced
 * in v4 by the `ChildProcessSpawner` handle protocol: running a command effect
 * yields a `ChildProcessHandle`, whose `exitCode` and `stdout` (a Stream) must
 * be consumed explicitly. These helpers preserve the v3 call-site semantics on
 * top of that protocol.
 *
 * Commands are scoped in v4: running one requires `Scope` so the child process
 * is guaranteed to be cleaned up. `Effect.scoped` provides that scope for the
 * duration of the run, so callers keep the same requirements as before.
 */

/** Runs a command and returns its exit code (does not fail on non-zero). */
export function runExitCode(command: ChildProcess.Command) {
  return Effect.scoped(command.pipe(Effect.flatMap((handle) => handle.exitCode)));
}

/** Runs a command and returns its entire stdout as a utf-8 string. */
export function runString(command: ChildProcess.Command) {
  return Effect.scoped(
    command.pipe(
      Effect.map((handle) => handle.stdout),
      Stream.unwrap,
      Stream.runCollect,
      Effect.map((chunks) => Buffer.concat(chunks).toString("utf8"))
    )
  );
}
