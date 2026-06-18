import { describe, expect, it, vi } from "vitest";

import {
  createManagedRepoFixture,
  existsSync,
  path,
  runCli,
  localRepoId,
  setupAfterEach,
  createTempDir,
} from "./helpers.ts";

setupAfterEach();

describe("run", () => {
  it("fails before creating anything when selected repos would share a worktree path", async () => {
    const tempHome = createTempDir("outpost-test-");
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    const alpha = await createManagedRepoFixture({
      defaultBranch: "main",
      repoName: "shared-repo",
    });
    const beta = await createManagedRepoFixture({
      defaultBranch: "main",
      repoName: "shared-repo",
    });

    await runCli(["repo", "add", alpha.tempRepo]);
    await runCli(["repo", "add", beta.tempRepo]);

    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const exitCode = await runCli([
      "create",
      "--ticket",
      "PATH-123",
      "--type",
      "feat test",
      "--repo",
      localRepoId(alpha.tempRemote),
      "--repo",
      localRepoId(beta.tempRemote),
    ]);

    expect(exitCode).toBe(1);
    expect(errorSpy).toHaveBeenNthCalledWith(
      1,
      `Selected repos share the same name shared-repo: ${localRepoId(alpha.tempRemote)}, ${localRepoId(beta.tempRemote)}.`,
    );
    expect(existsSync(path.join(tempHome, "worktrees", "PATH-123"))).toBe(
      false,
    );
  });

  it("returns an error for unknown commands", async () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["wat"]);

    expect(exitCode).toBe(1);
    expect(errorSpy).toHaveBeenNthCalledWith(1, "Unknown command: wat");
    expect(errorSpy).toHaveBeenNthCalledWith(
      2,
      "Run `outpost --help` to see available commands.",
    );
  });
});
