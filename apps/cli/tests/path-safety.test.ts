import { NodeServices } from "@effect/platform-node";
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import {
  getPortablePathKey,
  resolvePathWithinRoot,
  validatePathSegment,
  validateSemanticIdentifier,
} from "../src/path-safety.ts";
import { path } from "./helpers.ts";

describe("path safety", () => {
  it("resolves paths contained by the root", async () => {
    const root = path.join(path.sep, "tmp", "outpost", "worktrees");

    const resolved = await Effect.runPromise(
      resolvePathWithinRoot(root, "TICKET-123", "manifest.json").pipe(
        Effect.provide(NodeServices.layer)
      )
    );

    expect(resolved).toBe(path.join(root, "TICKET-123", "manifest.json"));
  });

  it("rejects paths that escape the root", async () => {
    const root = path.join(path.sep, "tmp", "outpost", "worktrees");

    const exit = await Effect.runPromise(
      Effect.exit(resolvePathWithinRoot(root, "..", "repos", "repos.json")).pipe(
        Effect.provide(NodeServices.layer)
      )
    );

    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("centralizes ticket segment validation", async () => {
    const exit = await Effect.runPromise(Effect.exit(validatePathSegment("--ticket", "../repos")));

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(exit.cause.toString()).toContain("--ticket may not contain path separators.");
    }
  });

  it.each([
    ["empty", ""],
    ["null", "\u0000"],
    ["newline", "\n"],
    ["carriage return", "\r"],
    ["tab", "\t"],
    ["escape", "\u001b"],
    ["delete", "\u007f"],
  ])("rejects %s semantic identifiers", async (_, value) => {
    const exit = await Effect.runPromise(Effect.exit(validateSemanticIdentifier("ticket", value)));

    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("preserves Unicode semantic identifiers", async () => {
    await expect(
      Effect.runPromise(validateSemanticIdentifier("ticket", "工单-１２３"))
    ).resolves.toBeUndefined();
    await expect(
      Effect.runPromise(validateSemanticIdentifier("ticket", "ticket 123"))
    ).resolves.toBeUndefined();
  });

  it("normalizes case and trailing Windows-aliased characters", async () => {
    const upper = await Effect.runPromise(
      getPortablePathKey("/tmp/repos/Group/Repo.git").pipe(Effect.provide(NodeServices.layer))
    );
    const lowerAliased = await Effect.runPromise(
      getPortablePathKey("/tmp/repos/group/repo.git. ").pipe(Effect.provide(NodeServices.layer))
    );

    expect(upper).toBe(lowerAliased);
  });
});
