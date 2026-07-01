import { NodeContext } from "@effect/platform-node";
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import {
  getPortablePathKey,
  resolvePathWithinRoot,
  validatePathSegment,
} from "../src/path-safety.ts";
import { path } from "./helpers.ts";

describe("path safety", () => {
  it("resolves paths contained by the root", async () => {
    const root = path.join(path.sep, "tmp", "outpost", "worktrees");

    const resolved = await Effect.runPromise(
      resolvePathWithinRoot(root, "TICKET-123", "manifest.json").pipe(
        Effect.provide(NodeContext.layer),
      ),
    );

    expect(resolved).toBe(path.join(root, "TICKET-123", "manifest.json"));
  });

  it("rejects paths that escape the root", async () => {
    const root = path.join(path.sep, "tmp", "outpost", "worktrees");

    const exit = await Effect.runPromise(
      Effect.exit(
        resolvePathWithinRoot(root, "..", "repos", "repos.json"),
      ).pipe(Effect.provide(NodeContext.layer)),
    );

    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("centralizes ticket segment validation", async () => {
    const exit = await Effect.runPromise(
      Effect.exit(validatePathSegment("--ticket", "../repos")),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(exit.cause.toString()).toContain(
        "--ticket may not contain path separators.",
      );
    }
  });

  it("normalizes case and trailing Windows-aliased characters", async () => {
    const upper = await Effect.runPromise(
      getPortablePathKey("/tmp/repos/Group/Repo.git").pipe(
        Effect.provide(NodeContext.layer),
      ),
    );
    const lowerAliased = await Effect.runPromise(
      getPortablePathKey("/tmp/repos/group/repo.git. ").pipe(
        Effect.provide(NodeContext.layer),
      ),
    );

    expect(upper).toBe(lowerAliased);
  });
});
