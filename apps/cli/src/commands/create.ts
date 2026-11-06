import * as Effect from "effect/Effect";
import {
  CreateError,
  createWorkspace,
  parseCreateArgsInput,
} from "../application/workspace-create.js";
import { domainDetails } from "../error-details.js";

export { CreateError } from "../application/workspace-create.js";

export function runCreate(args: ReadonlyArray<string>, options: { interactive: boolean }) {
  return parseCreateArgsInput(args).pipe(
    Effect.flatMap((input) => createWorkspace(input, options)),
    Effect.mapError(
      (error) =>
        new CreateError({
          ...domainDetails(error),
          message:
            args.some((arg) => arg === "--remote" || arg.startsWith("--remote=")) &&
            !error.message.startsWith("Cached base: ") &&
            !error.message.startsWith("Fresh base: ")
              ? `${args.some((arg) => arg === "fresh-remote" || arg === "--base-source=fresh-remote") ? "Fresh" : "Cached"} base: creation could not complete safely. Preserve all state and run outpost doctor --json; inspect the saved clone configuration outside Outpost. Raw Git diagnostics are withheld. Existing tickets require explicit workspace resume.`
              : error.message,
        })
    )
  );
}
