import { Effect } from "effect";

import type { CommandOutput } from "../types.js";

export function runDoctor(): Effect.Effect<CommandOutput> {
  return Effect.succeed({
    command: "doctor",
    data: {
      node: process.version,
      platform: process.platform,
      cwd: process.cwd(),
      status: "ok",
    },
  } satisfies CommandOutput);
}
