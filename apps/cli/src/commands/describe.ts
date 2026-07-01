import { Effect, Schema } from "effect";

import type { CommandOutput } from "../types.js";
import {
  ALL_COMMANDS,
  findCommand,
  type CommandSpec,
} from "../command-spec.js";

export class DescribeError extends Schema.TaggedError<DescribeError>()(
  "DescribeError",
  {
    message: Schema.String,
  },
) {}

export function runDescribe(
  args: readonly string[],
): Effect.Effect<CommandOutput, DescribeError> {
  return Effect.gen(function* () {
    if (args.length === 0) {
      return {
        command: "describe",
        data: {
          commands: ALL_COMMANDS.map((spec) => ({
            path: spec.path,
            usage: spec.path.join(" "),
            description: spec.description,
            mutation: spec.mutation,
            interactive: spec.interactive,
            json: spec.json,
            dryRun: spec.dryRun,
          })),
        },
      } satisfies CommandOutput;
    }

    const path = args;
    const spec: CommandSpec | undefined = findCommand(path);

    if (!spec) {
      return yield* Effect.fail(
        new DescribeError({
          message: `Unknown command: ${path.join(" ")}`,
        }),
      );
    }

    return {
      command: "describe",
      data: {
        path: spec.path,
        usage: spec.path.join(" "),
        description: spec.description,
        arguments: spec.arguments ?? [],
        options: spec.options ?? [],
        mutation: spec.mutation,
        interactive: spec.interactive,
        json: spec.json,
        dryRun: spec.dryRun,
      },
    } satisfies CommandOutput;
  });
}
