import { fileURLToPath } from "node:url";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import {
  ALL_COMMANDS,
  CONTRACT_VERSION,
  type CommandSpec,
  describeCommandMetadata,
  findCommand,
} from "../command-spec.js";
import { domainDetails, ErrorDetailFields, reasonDetails } from "../error-details.js";
import type { CommandDescriptionSchema } from "../machine-contract.js";
import type { CommandOutput } from "../types.js";

export class DescribeError extends Schema.TaggedError<DescribeError>()("DescribeError", {
  ...ErrorDetailFields,
  message: Schema.String,
}) {}

function describeInstalledCommand(spec: CommandSpec) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    let outputSchema: (typeof CommandDescriptionSchema.Type)["outputSchema"] = null;
    if (spec.json) {
      const asset = fileURLToPath(
        new URL(`../../schemas/${spec.path.join("-")}.output.json`, import.meta.url)
      );
      const content = yield* fs
        .readFileString(asset)
        .pipe(
          Effect.mapError(
            (error) => new DescribeError({ message: error.message, ...domainDetails(error) })
          )
        );
      outputSchema = yield* Effect.try({
        try: () => {
          const { $schema: _dialect, ...document } = JSON.parse(content);
          return document as NonNullable<typeof outputSchema>;
        },
        catch: (error) =>
          new DescribeError({
            message: `Invalid installed schema ${asset}: ${String(error)}`,
            ...reasonDetails("invalid-state"),
          }),
      });
    }
    return { ...describeCommandMetadata(spec), outputSchema };
  });
}

export function runDescribe(
  args: readonly string[],
  cliVersion: string
): Effect.Effect<CommandOutput<"describe">, DescribeError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    if (args.length === 0)
      return {
        command: "describe",
        data: {
          contractVersion: CONTRACT_VERSION,
          cliVersion,
          commands: yield* Effect.forEach(ALL_COMMANDS, describeInstalledCommand),
        },
      } satisfies CommandOutput<"describe">;
    const spec = findCommand(args);
    if (!spec)
      return yield* Effect.fail(
        new DescribeError({
          message: `Unknown command: ${args.join(" ")}`,
          ...reasonDetails("invalid-arguments"),
        })
      );
    return {
      command: "describe",
      data: {
        contractVersion: CONTRACT_VERSION,
        cliVersion,
        ...(yield* describeInstalledCommand(spec)),
      },
    } satisfies CommandOutput<"describe">;
  });
}
