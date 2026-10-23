import { Effect, Schema } from "effect";
import { CONTRACT_VERSION, findCommand } from "../command-spec.js";

import { describeAll, describeCommand } from "../machine-contract.js";
import type { CommandOutput } from "../types.js";

export class DescribeError extends Schema.TaggedError<DescribeError>()("DescribeError", {
  message: Schema.String,
}) {}

export function runDescribe(
  args: readonly string[],
  cliVersion: string
): Effect.Effect<CommandOutput<"describe">, DescribeError> {
  if (args.length === 0)
    return Effect.succeed({ command: "describe", data: describeAll(cliVersion) });
  const spec = findCommand(args);
  return spec
    ? Effect.succeed({
        command: "describe",
        data: { contractVersion: CONTRACT_VERSION, cliVersion, ...describeCommand(spec) },
      })
    : Effect.fail(new DescribeError({ message: `Unknown command: ${args.join(" ")}` }));
}
