#!/usr/bin/env node
import { createRequire } from "node:module";
import process from "node:process";
import { runEarly } from "./entry.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };
const argv = process.argv.slice(2);
const early = await runEarly(argv, version);
if (early !== undefined) process.exitCode = early;
else {
  const { runMain } = await import("./runtime.js");
  runMain(argv, version);
}
