import { createRequire } from "node:module";
import { runEarly } from "./entry.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

export async function runCli(argv: readonly string[]): Promise<number> {
  const early = await runEarly(argv, version);
  if (early !== undefined) return early;
  const { runWithServices } = await import("./runtime.js");
  return runWithServices(argv, version);
}
