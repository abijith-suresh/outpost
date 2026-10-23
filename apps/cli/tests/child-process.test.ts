import { NodeServices } from "@effect/platform-node";
import { Effect, Fiber } from "effect";
import * as ChildProcess from "effect/process/ChildProcess";
import { describe, expect, it } from "vitest";
import { commandExitCode, commandResult, commandString } from "../src/child-process.ts";

function node(script: string) {
  return ChildProcess.make(process.execPath, ["-e", script]);
}
function run<A, E>(effect: Effect.Effect<A, E, never>) {
  return Effect.runPromise(effect);
}

describe("checked process execution", () => {
  it("drains finite multi-megabyte stderr before waiting for an exit status", async () => {
    expect(
      await run(
        commandExitCode(
          node('process.stderr.write("x".repeat(2 * 1024 * 1024)); process.exitCode = 23')
        ).pipe(Effect.provide(NodeServices.layer))
      )
    ).toBe(23);
  });
  it("checks exit status before accepting stdout", async () => {
    await expect(
      run(
        commandString(
          node(
            'process.stdout.write("plausible result"); process.stderr.write("failure detail"); process.exitCode = 9'
          )
        ).pipe(Effect.provide(NodeServices.layer))
      )
    ).rejects.toThrow(/exit status 9.*failure detail/);
  });
  it("bounds retained bytes while draining both streams", async () => {
    const result = await run(
      commandResult(
        node(
          'process.stdout.write("o".repeat(2 * 1024 * 1024)); process.stderr.write("e".repeat(2 * 1024 * 1024))'
        ),
        { maxOutputBytes: 1024 }
      ).pipe(Effect.provide(NodeServices.layer))
    );
    expect(result.stdout).toEqual({ text: "o".repeat(1024), truncated: true });
    expect(result.stderr).toEqual({ text: "e".repeat(1024), truncated: true });
    expect(result.exitCode).toBe(0);
  });
  it("rejects truncated stdout and terminates on timeout", async () => {
    await expect(
      run(
        commandString(node('process.stdout.write("x".repeat(8192))'), { maxOutputBytes: 10 }).pipe(
          Effect.provide(NodeServices.layer)
        )
      )
    ).rejects.toThrow(/output limit/);
    await expect(
      run(
        commandString(node("setInterval(() => {}, 1000)"), { timeoutMs: 100 }).pipe(
          Effect.provide(NodeServices.layer)
        )
      )
    ).rejects.toThrow(/timed out after 100ms/);
  });
  it("terminates a real running child on fiber interruption", async () => {
    const start = Date.now();
    await run(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(commandString(node("setInterval(() => {}, 1000)")));
        yield* Effect.sleep(100);
        yield* Fiber.interrupt(fiber);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
    );
    expect(Date.now() - start).toBeLessThan(3000);
  });
});
