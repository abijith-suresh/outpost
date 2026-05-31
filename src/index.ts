#!/usr/bin/env node

import { createRequire } from "node:module";
import process from "node:process";

import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Effect } from "effect";

import { run } from "./program.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

export function runCli(argv: readonly string[]): Promise<number> {
  return Effect.runPromise(
    run(argv, version).pipe(Effect.provide(NodeContext.layer)),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  NodeRuntime.runMain(
    run(process.argv.slice(2), version).pipe(Effect.provide(NodeContext.layer)),
  );
}
