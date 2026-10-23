import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { run } from "./program.js";

export function runWithServices(argv: readonly string[], version: string): Promise<number> {
  return Effect.runPromise(run(argv, version).pipe(Effect.provide(NodeServices.layer)));
}
export function runMain(argv: readonly string[], version: string): void {
  NodeRuntime.runMain(
    run(argv, version).pipe(
      Effect.provide(NodeServices.layer),
      Effect.tap((exitCode) =>
        Effect.sync(() => {
          process.exitCode = exitCode;
        })
      )
    )
  );
}
