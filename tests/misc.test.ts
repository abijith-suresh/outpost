import { describe, expect, it, vi } from "vitest";

import {
  createManagedRepoFixture,
  existsSync,
  os,
  path,
  runCli,
  sanitizeRemoteUrl,
  setupAfterEach,
} from "./helpers.ts";

setupAfterEach();

describe("run", () => {
  it("fails before creating anything when selected repos would share a worktree path", async () => {
    const tempHome = path.join(os.tmpdir(), `outpost-test-${Date.now()}`);
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
      "feat",
      "--repo",
      sanitizeRemoteUrl(alpha.tempRemote),
      "--repo",
      sanitizeRemoteUrl(beta.tempRemote),
    ]);

    expect(exitCode).toBe(1);
    expect(errorSpy).toHaveBeenNthCalledWith(
      1,
      `Selected repos would create the same worktree path: ${path.join(tempHome, "worktrees", "PATH-123", "shared-repo")} (repo ids: ${sanitizeRemoteUrl(alpha.tempRemote)}, ${sanitizeRemoteUrl(beta.tempRemote)}).`,
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
