import * as Effect from "effect/Effect";
import {
  inspectWorkspaceReadiness,
  WorkspaceResumeError,
} from "../application/workspace-readiness.js";
import { reasonDetails } from "../error-details.js";

export {
  preflightReusedTree,
  RESUME_LIMITS,
  verifyNewWorktreeClean,
  WorkspaceResumeError,
} from "../application/workspace-readiness.js";

export function runWorkspaceResume(ticket: string | undefined, extraArgs: ReadonlyArray<string>) {
  if (!ticket || extraArgs.length)
    return Effect.fail(
      new WorkspaceResumeError({
        ...reasonDetails("invalid-arguments"),
        message: "Usage: outpost workspace resume <ticket> [--json]",
      })
    );
  return inspectWorkspaceReadiness({ ticket }).pipe(
    Effect.map((data) => ({
      command: "workspace resume" as const,
      data,
      ...(data.resumable ? {} : { exitCode: 1 as const }),
    }))
  );
}
