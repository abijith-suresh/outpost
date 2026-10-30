import * as Effect from "effect/Effect";
import type { FetchReceiptSchema } from "./base-selection.js";
import { requireOwnedReuseStorage } from "./base-selection.js";
import type { IdentitySchema } from "./borrowed-schema.js";
import { verifyDirectory } from "./borrowed-workspace.js";
import { commandResult, readOnlyGitCommand } from "./child-process.js";
import { validateWindowsGitPath, validateWindowsInvocationCwd } from "./windows-git-path.js";

export type ReceiptObservation = "matching" | "missing" | "moved" | "symbolic" | "unavailable";
/** Historical facts are never rewritten or promoted from this current observation. */
export function observeReceipt(
  common: typeof IdentitySchema.Type,
  receipt: typeof FetchReceiptSchema.Type
) {
  return Effect.gen(function* () {
    yield* verifyDirectory(common);
    yield* validateWindowsInvocationCwd();
    yield* validateWindowsGitPath(common.path, "gitdir");
    yield* requireOwnedReuseStorage(
      { id: "historical-receipt", managedRepoPath: common.path },
      "",
      receipt.ref
    );
    const symbolic = yield* commandResult(
      readOnlyGitCommand("--git-dir", common.path, "symbolic-ref", "--quiet", receipt.ref),
      { maxOutputBytes: 4096 }
    );
    if (symbolic.stdout.truncated || symbolic.stderr.truncated) return "unavailable" as const;
    if (symbolic.exitCode === 0) return "symbolic" as const;
    if (symbolic.exitCode !== 1) return "unavailable" as const;
    const found = yield* commandResult(
      readOnlyGitCommand(
        "--git-dir",
        common.path,
        "rev-parse",
        "--verify",
        "--quiet",
        "--end-of-options",
        receipt.ref
      ),
      { maxOutputBytes: 4096 }
    );
    if (found.stdout.truncated || found.stderr.truncated) return "unavailable" as const;
    if (found.exitCode === 1) return "missing" as const;
    if (found.exitCode !== 0) return "unavailable" as const;
    yield* verifyDirectory(common);
    return found.stdout.text.trim() === receipt.commit ? ("matching" as const) : ("moved" as const);
  }).pipe(Effect.catch(() => Effect.succeed("unavailable" as const)));
}
