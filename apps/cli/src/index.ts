import { createRequire } from "node:module";

import { NodeServices } from "@effect/platform-node";
import { Effect } from "effect";

import { run } from "./program.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

export function runCli(argv: readonly string[]): Promise<number> {
  return Effect.runPromise(run(argv, version).pipe(Effect.provide(NodeServices.layer)));
}
