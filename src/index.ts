#!/usr/bin/env node

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

export function run(argv: readonly string[]): number {
  if (argv.includes("--version")) {
    console.log(version);
    return 0;
  }

  console.log("outpost: CLI foundation is ready.");
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = run(process.argv.slice(2));
}
