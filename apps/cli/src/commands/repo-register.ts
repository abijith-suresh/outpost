import * as Effect from "effect/Effect";
import { registerRepository } from "../application/repositories.js";
import { BorrowedError } from "../borrowed-repo.js";
import { parseCommandInput, requireCommand } from "../command-spec.js";

export { transferBorrowed } from "../application/repositories.js";
export function runRepoRegister(args: readonly string[]) {
  return Effect.gen(function* () {
    const parsed = parseCommandInput(requireCommand(["repo", "register"]), args);
    const name = parsed.options["--name"];
    if (!Array.isArray(name) || !name[0] || !parsed.arguments.path[0])
      return yield* new BorrowedError({ message: "A checkout and --name are required." });
    return yield* registerRepository({
      checkoutPath: parsed.arguments.path[0],
      name: name[0],
      dryRun: !!parsed.options["--dry-run"],
    });
  });
}
