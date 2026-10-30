import { execFileSync } from "node:child_process";
import { chmodSync } from "node:fs";
import { NodeServices } from "@effect/platform-node";
import { Effect, Fiber } from "effect";
import * as ChildProcess from "effect/process/ChildProcess";
import { describe, expect, it } from "vitest";
import { commandExitCode, commandResult, commandString } from "../src/child-process.ts";
import { fetchBareRepository } from "../src/commands/repo-mirror.ts";
import { createTempDir, path, setupAfterEach, writeFileSync } from "./helpers.ts";

setupAfterEach();

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

it("keeps a failure containing many short diagnostic lines structured and bounded", async () => {
  const root = createTempDir("outpost-short-diagnostics-");
  const repo = path.join(root, "repo.git");
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  execFileSync(realGit, ["init", "--bare", repo]);
  const shim = path.join(root, "git");
  writeFileSync(
    shim,
    `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === 'fetch') {
  process.stderr.write('x\\n'.repeat(200000));
  process.exitCode = 23;
} else {
  const result = require('node:child_process').spawnSync(${JSON.stringify(realGit)}, args, {stdio: 'inherit'});
  process.exitCode = result.status ?? 1;
}
`
  );
  chmodSync(shim, 0o755);
  process.env.PATH = `${root}:${process.env.PATH}`;
  const result = await Effect.runPromise(
    fetchBareRepository(repo).pipe(Effect.result, Effect.provide(NodeServices.layer))
  );
  expect(result._tag).toBe("Failure");
  if (result._tag !== "Failure") throw new Error("Expected noisy fetch failure");
  expect(result.failure.message).toMatch(/exit status 23/);
  expect(result.failure.diagnostics.length).toBeLessThanOrEqual(80);
  expect(JSON.stringify(result.failure).length).toBeLessThan(30_000);
  expect(result.failure.diagnosticTruncation).toMatchObject({
    truncated: true,
    capturedOutputTruncated: true,
    omittedLineCount: expect.any(Number),
  });
});

it.each([8192, 9000])(
  "counts cumulative UTF8 stderr bytes for strict ref protocol (%i bytes)",
  async (bytes) => {
    const { acquireBranchCreation } = await import("../src/child-process.ts");
    const script = `let input='';process.stdin.on('data',b=>{input+=b;while(input.includes('\\n')){const i=input.indexOf('\\n');const line=input.slice(0,i);input=input.slice(i+1);if(line==='start')process.stdout.write('start: ok\\n');if(line==='prepare'){process.stderr.write('é'.repeat(1500));setTimeout(()=>process.stderr.write('é'.repeat(1500)),30);setTimeout(()=>{process.stderr.write('é'.repeat(${(bytes - 6000) / 2}));process.stdout.write('prepare: ok\\n');},60);}if(line==='commit')process.stdout.write('commit: ok\\n');if(line==='abort')process.stdout.write('abort: ok\\n');}});`;
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const transaction = yield* acquireBranchCreation(
          "unused",
          "refs/outpost/protocol-test",
          "1".repeat(40),
          () => node(script),
          true
        );
        yield* transaction.commit;
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.result)
    );
    expect(result._tag).toBe(bytes > 8192 ? "Failure" : "Success");
  }
);
