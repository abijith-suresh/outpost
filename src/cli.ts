#!/usr/bin/env node

import { createRequire } from "node:module";
import process from "node:process";

import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Effect } from "effect";

import { run } from "./program.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

const program = run(process.argv.slice(2), version).pipe(
  Effect.provide(NodeContext.layer),
  Effect.tap((exitCode) =>
    Effect.sync(() => {
      process.exitCode = exitCode;
    }),
  ),
);

NodeRuntime.runMain(program);
