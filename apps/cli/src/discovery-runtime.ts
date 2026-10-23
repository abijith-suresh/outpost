import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { formatCommandDetail, parseCommandInput, requireCommand } from "./command-spec.js";
import { runDescribe } from "./commands/describe.js";
import { domainDetails, reasonDetails } from "./error-reasons.js";
import { jsonErrorEnvelope, printCommandOutput } from "./renderer.js";

export function runDiscovery(
  args: readonly string[],
  version: string,
  asJson: boolean
): Promise<number> {
  const command = Effect.gen(function* () {
    const spec = requireCommand(["describe"]);
    yield* Effect.try({
      try: () => parseCommandInput(spec, args),
      catch: () => ({
        ...reasonDetails("invalid-arguments"),
        message: formatCommandDetail(spec).split("\n\n")[0].replace("Usage:\n  ", "Usage: "),
      }),
    });
    return yield* runDescribe(args, version);
  });
  return Effect.runPromise(
    command.pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          Console.error(
            asJson
              ? jsonErrorEnvelope("describe", {
                  code: "INVALID_ARGUMENT",
                  message: error.message,
                  ...domainDetails(error),
                })
              : error.message
          ).pipe(Effect.as(1)),
        onSuccess: (output) => printCommandOutput(output, asJson).pipe(Effect.as(0)),
      }),
      Effect.provide(NodeFileSystem.layer)
    )
  );
}
