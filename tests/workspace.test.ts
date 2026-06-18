import { symlinkSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  createManagedRepoFixture,
  existsSync,
  mkdirSync,
  path,
  readRegistry,
  runCli,
  localRepoId,
  setupAfterEach,
  createTempDir,
  writeFileSync,
} from "./helpers.ts";

setupAfterEach();

describe("run", () => {
  it("prints workspace show output", async () => {
    const tempHome = createTempDir("outpost-test-");
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    const alpha = await createManagedRepoFixture({ defaultBranch: "main" });
    await runCli(["repo", "add", alpha.tempRepo]);
    await runCli([
      "create",
      "--ticket",
      "SHOW-123",
      "--type",
      "feat",
      "--repo",
      localRepoId(alpha.tempRemote),
    ]);

    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);
    const ticketDirectory = path.join(tempHome, "worktrees", "SHOW-123");
    const worktreePath = path.join(
      ticketDirectory,
      path.basename(alpha.tempRepo),
    );

    const exitCode = await runCli(["workspace", "show", "SHOW-123"]);

    expect(exitCode).toBe(0);
    expect(infoSpy).toHaveBeenNthCalledWith(1, "outpost workspace show");
    expect(infoSpy).toHaveBeenNthCalledWith(2, "ticket: SHOW-123");
    expect(infoSpy).toHaveBeenNthCalledWith(
      3,
      `workspace directory: ${ticketDirectory}`,
    );
    expect(infoSpy).toHaveBeenNthCalledWith(4, "worktrees: 1");
    expect(infoSpy).toHaveBeenNthCalledWith(
      5,
      `- ${path.basename(alpha.tempRepo)}`,
    );
    expect(infoSpy).toHaveBeenNthCalledWith(6, `  path: ${worktreePath}`);
  });

  it("prints workspace show output as json", async () => {
    const tempHome = createTempDir("outpost-test-");
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    const alpha = await createManagedRepoFixture({ defaultBranch: "main" });
    await runCli(["repo", "add", alpha.tempRepo]);
    await runCli([
      "create",
      "--ticket",
      "SHOW-JSON-456",
      "--type",
      "feat",
      "--repo",
      localRepoId(alpha.tempRemote),
    ]);

    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const exitCode = await runCli([
      "workspace",
      "show",
      "SHOW-JSON-456",
      "--json",
    ]);
    const output = infoSpy.mock.calls[0]?.[0] as string;

    expect(exitCode).toBe(0);
    expect(output).toContain('"command": "workspace show"');
    expect(output).toContain('"ticket": "SHOW-JSON-456"');
    expect(output).toContain(
      `"ticketDirectory": "${path.join(tempHome, "worktrees", "SHOW-JSON-456")}"`,
    );
    expect(output).toContain(`"repoName": "${path.basename(alpha.tempRepo)}"`);
  });

  it("prints workspace list output", async () => {
    const tempHome = createTempDir("outpost-test-");
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    const alpha = await createManagedRepoFixture({ defaultBranch: "main" });
    const beta = await createManagedRepoFixture({ defaultBranch: "main" });
    await runCli(["repo", "add", alpha.tempRepo]);
    await runCli(["repo", "add", beta.tempRepo]);
    await runCli([
      "create",
      "--ticket",
      "LIST-123",
      "--type",
      "feat",
      "--repo",
      localRepoId(alpha.tempRemote),
    ]);
    await runCli([
      "create",
      "--ticket",
      "LIST-456",
      "--type",
      "feat",
      "--repo",
      localRepoId(beta.tempRemote),
    ]);

    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["workspace", "list"]);

    expect(exitCode).toBe(0);
    expect(infoSpy).toHaveBeenNthCalledWith(1, "outpost workspace list");
    expect(infoSpy).toHaveBeenNthCalledWith(2, "workspaces: 2");
    expect(infoSpy).toHaveBeenNthCalledWith(3, "- LIST-123");
    expect(infoSpy).toHaveBeenNthCalledWith(
      4,
      `  workspace directory: ${path.join(tempHome, "worktrees", "LIST-123")}`,
    );
    expect(infoSpy).toHaveBeenNthCalledWith(5, "  worktrees: 1");
    expect(infoSpy).toHaveBeenNthCalledWith(6, "- LIST-456");
  });

  it("prints workspace list output as json", async () => {
    const tempHome = createTempDir("outpost-test-");
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    const alpha = await createManagedRepoFixture({ defaultBranch: "main" });
    await runCli(["repo", "add", alpha.tempRepo]);
    await runCli([
      "create",
      "--ticket",
      "LIST-JSON-789",
      "--type",
      "feat",
      "--repo",
      localRepoId(alpha.tempRemote),
    ]);

    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["workspace", "list", "--json"]);
    const output = infoSpy.mock.calls[0]?.[0] as string;

    expect(exitCode).toBe(0);
    expect(output).toContain('"command": "workspace list"');
    expect(output).toContain('"ticket": "LIST-JSON-789"');
    expect(output).toContain('"worktreeCount": 1');
  });

  it("returns an error when workspace show uses an unknown ticket", async () => {
    const tempHome = createTempDir("outpost-test-");
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["workspace", "show", "missing"]);

    expect(exitCode).toBe(1);
    expect(errorSpy).toHaveBeenNthCalledWith(
      1,
      "Unknown workspace ticket: missing",
    );
  });

  it("rejects workspace show tickets with path traversal before reading outside worktrees", async () => {
    const tempHome = createTempDir("outpost-test-");
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    const outsideWorktreesDirectory = path.join(
      tempHome,
      "repos",
      "outside-worktrees",
    );
    mkdirSync(outsideWorktreesDirectory, { recursive: true });

    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["workspace", "show", "../repos"]);

    expect(exitCode).toBe(1);
    expect(errorSpy).toHaveBeenNthCalledWith(
      1,
      "--ticket may not contain path separators.",
    );
    expect(infoSpy).not.toHaveBeenCalled();
    expect(existsSync(outsideWorktreesDirectory)).toBe(true);
  });

  describe("workspace remove", () => {
    it("removes a workspace and its worktree directories", async () => {
      const tempHome = createTempDir("outpost-test-");
      process.env.OUTPOST_HOME = tempHome;

      await runCli(["init"]);

      const alpha = await createManagedRepoFixture({ defaultBranch: "main" });
      await runCli(["repo", "add", alpha.tempRepo]);
      await runCli([
        "create",
        "--ticket",
        "REMOVE-123",
        "--type",
        "feat",
        "--repo",
        localRepoId(alpha.tempRemote),
      ]);

      const ticketDirectory = path.join(tempHome, "worktrees", "REMOVE-123");

      expect(existsSync(ticketDirectory)).toBe(true);

      const infoSpy = vi
        .spyOn(console, "log")
        .mockImplementation(() => undefined);

      const exitCode = await runCli(["workspace", "remove", "REMOVE-123"]);

      expect(exitCode).toBe(0);
      expect(infoSpy).toHaveBeenNthCalledWith(1, "outpost workspace remove");
      expect(infoSpy).toHaveBeenNthCalledWith(2, "ticket: REMOVE-123");
      expect(infoSpy).toHaveBeenNthCalledWith(
        3,
        `workspace directory: ${ticketDirectory}`,
      );
      expect(infoSpy).toHaveBeenNthCalledWith(4, "worktrees: 1");
      expect(infoSpy).toHaveBeenNthCalledWith(
        5,
        `  - ${path.basename(alpha.tempRepo)}`,
      );
      expect(existsSync(ticketDirectory)).toBe(false);
    });

    it("prints workspace remove output as json", async () => {
      const tempHome = createTempDir("outpost-test-");
      process.env.OUTPOST_HOME = tempHome;

      await runCli(["init"]);

      const alpha = await createManagedRepoFixture({ defaultBranch: "main" });
      await runCli(["repo", "add", alpha.tempRepo]);
      await runCli([
        "create",
        "--ticket",
        "REMOVE-JSON-456",
        "--type",
        "feat",
        "--repo",
        localRepoId(alpha.tempRemote),
      ]);

      const infoSpy = vi
        .spyOn(console, "log")
        .mockImplementation(() => undefined);

      const exitCode = await runCli([
        "workspace",
        "remove",
        "REMOVE-JSON-456",
        "--json",
      ]);
      const output = infoSpy.mock.calls[0]?.[0] as string;
      const ticketDirectory = path.join(
        tempHome,
        "worktrees",
        "REMOVE-JSON-456",
      );

      expect(exitCode).toBe(0);
      expect(infoSpy).toHaveBeenCalledTimes(1);
      expect(output).toContain('"command": "workspace remove"');
      expect(output).toContain('"ticket": "REMOVE-JSON-456"');
      expect(output).toContain(`"ticketDirectory": "${ticketDirectory}"`);
      expect(output).toContain('"worktreeCount": 1');
      expect(output).toContain(`"${path.basename(alpha.tempRepo)}"`);
      expect(existsSync(ticketDirectory)).toBe(false);
    });

    it("returns an error for unknown ticket", async () => {
      const tempHome = createTempDir("outpost-test-");
      process.env.OUTPOST_HOME = tempHome;

      await runCli(["init"]);

      const errorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);

      const exitCode = await runCli(["workspace", "remove", "missing"]);

      expect(exitCode).toBe(1);
      expect(errorSpy).toHaveBeenNthCalledWith(
        1,
        "Unknown workspace ticket: missing",
      );
    });

    it("rejects workspace remove tickets with path traversal before removing outside worktrees", async () => {
      const tempHome = createTempDir("outpost-test-");
      process.env.OUTPOST_HOME = tempHome;

      await runCli(["init"]);

      const reposRoot = path.join(tempHome, "repos");
      const outsideWorktreesFile = path.join(reposRoot, "keep.txt");
      writeFileSync(outsideWorktreesFile, "keep\n");

      const errorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);

      const exitCode = await runCli(["workspace", "remove", "../repos"]);

      expect(exitCode).toBe(1);
      expect(errorSpy).toHaveBeenNthCalledWith(
        1,
        "--ticket may not contain path separators.",
      );
      expect(existsSync(reposRoot)).toBe(true);
      expect(existsSync(outsideWorktreesFile)).toBe(true);
    });

    it("returns an error when workspace remove is missing the ticket", async () => {
      const tempHome = createTempDir("outpost-test-");
      process.env.OUTPOST_HOME = tempHome;

      await runCli(["init"]);

      const errorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);

      const exitCode = await runCli(["workspace", "remove"]);

      expect(exitCode).toBe(1);
      expect(errorSpy).toHaveBeenNthCalledWith(
        1,
        "Usage: outpost workspace remove <ticket> [--json]",
      );
    });

    it("prunes git worktree entries from bare repos when removing a workspace", async () => {
      const { execFileSync } = await import("node:child_process");
      const tempHome = createTempDir("outpost-test-");
      process.env.OUTPOST_HOME = tempHome;

      await runCli(["init"]);

      const alpha = await createManagedRepoFixture({ defaultBranch: "main" });
      await runCli(["repo", "add", alpha.tempRepo]);
      await runCli([
        "create",
        "--ticket",
        "REMOVE-123",
        "--type",
        "feat",
        "--repo",
        localRepoId(alpha.tempRemote),
      ]);

      const ticketDirectory = path.join(tempHome, "worktrees", "REMOVE-123");
      expect(existsSync(ticketDirectory)).toBe(true);

      const registry = readRegistry(tempHome);
      const managedRepoPath = registry.repos[0].managedRepoPath;

      const exitCode = await runCli(["workspace", "remove", "REMOVE-123"]);
      expect(exitCode).toBe(0);

      const worktreeList = execFileSync(
        "git",
        ["--git-dir", managedRepoPath, "worktree", "list"],
        { encoding: "utf8" },
      );
      expect(worktreeList).not.toContain("REMOVE-123");
    });

    it("prunes the correct mirror when registry repos share a short name", async () => {
      const { execFileSync } = await import("node:child_process");
      const tempHome = createTempDir("outpost-test-");
      process.env.OUTPOST_HOME = tempHome;

      await runCli(["init"]);

      const first = await createManagedRepoFixture({
        defaultBranch: "main",
        repoName: "shared-repo",
      });
      const second = await createManagedRepoFixture({
        defaultBranch: "main",
        repoName: "shared-repo",
      });
      await runCli(["repo", "add", first.tempRepo]);
      await runCli(["repo", "add", second.tempRepo]);
      await runCli([
        "create",
        "--ticket",
        "REMOVE-SHARED-123",
        "--type",
        "feat",
        "--repo",
        localRepoId(second.tempRemote),
      ]);

      const registry = readRegistry(tempHome);
      const secondManagedRepoPath = registry.repos.find(
        (repo) => repo.id === localRepoId(second.tempRemote),
      )?.managedRepoPath as string;

      const exitCode = await runCli([
        "workspace",
        "remove",
        "REMOVE-SHARED-123",
      ]);
      const secondWorktreeList = execFileSync(
        "git",
        ["--git-dir", secondManagedRepoPath, "worktree", "list"],
        { encoding: "utf8" },
      );

      expect(exitCode).toBe(0);
      expect(secondWorktreeList).not.toContain("REMOVE-SHARED-123");
    });

    it("matches worktree metadata through a symlinked Outpost home", async () => {
      const { execFileSync } = await import("node:child_process");
      const root = createTempDir("outpost-linked-home-");
      const realHome = path.join(root, "real-home");
      const linkedHome = path.join(root, "linked-home");
      mkdirSync(realHome, { recursive: true });
      symlinkSync(realHome, linkedHome, "dir");
      process.env.OUTPOST_HOME = linkedHome;

      await runCli(["init"]);

      const alpha = await createManagedRepoFixture({ defaultBranch: "main" });
      await runCli(["repo", "add", alpha.tempRepo]);
      await runCli([
        "create",
        "--ticket",
        "REMOVE-LINKED-123",
        "--type",
        "feat",
        "--repo",
        localRepoId(alpha.tempRemote),
      ]);

      const registry = readRegistry(linkedHome);
      const managedRepoPath = registry.repos[0].managedRepoPath;

      const exitCode = await runCli([
        "workspace",
        "remove",
        "REMOVE-LINKED-123",
      ]);
      const worktreeList = execFileSync(
        "git",
        ["--git-dir", managedRepoPath, "worktree", "list"],
        { encoding: "utf8" },
      );

      expect(exitCode).toBe(0);
      expect(worktreeList).not.toContain("REMOVE-LINKED-123");
    });

    it("workspace remove succeeds even when managed repo directory is missing", async () => {
      const { rmSync } = await import("node:fs");
      const tempHome = createTempDir("outpost-test-");
      process.env.OUTPOST_HOME = tempHome;

      await runCli(["init"]);

      const alpha = await createManagedRepoFixture({ defaultBranch: "main" });
      await runCli(["repo", "add", alpha.tempRepo]);
      await runCli([
        "create",
        "--ticket",
        "REMOVE-123",
        "--type",
        "feat",
        "--repo",
        localRepoId(alpha.tempRemote),
      ]);

      const ticketDirectory = path.join(tempHome, "worktrees", "REMOVE-123");
      expect(existsSync(ticketDirectory)).toBe(true);

      const registry = readRegistry(tempHome);
      const managedRepoPath = registry.repos[0].managedRepoPath;

      rmSync(managedRepoPath, { recursive: true, force: true });

      const exitCode = await runCli(["workspace", "remove", "REMOVE-123"]);
      expect(exitCode).toBe(0);
      expect(existsSync(ticketDirectory)).toBe(false);
    });
  });
});
