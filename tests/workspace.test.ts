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

function writeManifestFixture(
  outpostHome: string,
  reposRoot: string,
  ticket: string,
  type: string,
  branch: string,
  repositories: Array<{
    id: string;
    name: string;
    base: string;
    bareRepoPath: string;
  }>,
) {
  const manifestsDir = path.join(outpostHome, "workspaces");
  mkdirSync(manifestsDir, { recursive: true });
  const manifest = {
    ticket,
    type,
    branch,
    createdAt: new Date().toISOString(),
    workspacePath: ticket,
    repositories: repositories.map((repo) => ({
      id: repo.id,
      name: repo.name,
      base: repo.base,
      managedPath: path.relative(reposRoot, repo.bareRepoPath),
      worktreePath: repo.name,
    })),
  };
  const manifestPath = path.join(manifestsDir, `${ticket}.json`);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
}

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
    const calls = infoSpy.mock.calls.map((call) => call[0]);
    expect(calls[0]).toBe("outpost workspace show");
    expect(calls[1]).toBe("ticket: SHOW-123");
    expect(calls[2]).toBe(`workspace directory: ${ticketDirectory}`);
    expect(calls[3]).toBe("status: unmanaged");
    expect(calls[4]).toBe("worktrees: 1");
    expect(calls[5]).toBe(`- ${path.basename(alpha.tempRepo)}`);
    expect(calls[6]).toBe(`  path: ${worktreePath}`);
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
    expect(output).toContain('"status": "unmanaged"');
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
    const calls = infoSpy.mock.calls.map((call) => call[0]);
    expect(calls[0]).toBe("outpost workspace list");
    expect(calls[1]).toBe("workspaces: 2");
    expect(calls[2]).toContain("- LIST-123");
    expect(calls[3]).toBe(
      `  workspace directory: ${path.join(tempHome, "worktrees", "LIST-123")}`,
    );
    expect(calls[4]).toBe("  worktrees: 1");
    expect(calls[5]).toContain("- LIST-456");
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
    expect(output).toContain('"status": "unmanaged"');
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

      const registry = readRegistry(tempHome);
      const managedRepoPath = registry.repos[0].managedRepoPath;
      const reposRoot = path.join(tempHome, "repos");

      writeManifestFixture(
        tempHome,
        reposRoot,
        "REMOVE-123",
        "feat",
        "feat/REMOVE-123",
        [
          {
            id: registry.repos[0].id,
            name: registry.repos[0].name,
            base: "main",
            bareRepoPath: managedRepoPath,
          },
        ],
      );

      const ticketDirectory = path.join(tempHome, "worktrees", "REMOVE-123");

      expect(existsSync(ticketDirectory)).toBe(true);

      const infoSpy = vi
        .spyOn(console, "log")
        .mockImplementation(() => undefined);

      const exitCode = await runCli(["workspace", "remove", "REMOVE-123"]);

      expect(exitCode).toBe(0);
      const calls = infoSpy.mock.calls.map((call) => call[0]);
      expect(calls[0]).toBe("outpost workspace remove");
      expect(calls[1]).toBe("ticket: REMOVE-123");
      expect(calls[2]).toBe(`workspace directory: ${ticketDirectory}`);
      expect(calls[3]).toBe("status: success");
      expect(existsSync(ticketDirectory)).toBe(false);

      const manifestPath = path.join(tempHome, "workspaces", "REMOVE-123.json");
      expect(existsSync(manifestPath)).toBe(false);
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

      const registry = readRegistry(tempHome);
      const managedRepoPath = registry.repos[0].managedRepoPath;
      const reposRoot = path.join(tempHome, "repos");

      writeManifestFixture(
        tempHome,
        reposRoot,
        "REMOVE-JSON-456",
        "feat",
        "feat/REMOVE-JSON-456",
        [
          {
            id: registry.repos[0].id,
            name: registry.repos[0].name,
            base: "main",
            bareRepoPath: managedRepoPath,
          },
        ],
      );

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
      expect(output).toContain('"status": "success"');
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
      const reposRoot = path.join(tempHome, "repos");

      writeManifestFixture(
        tempHome,
        reposRoot,
        "REMOVE-123",
        "feat",
        "feat/REMOVE-123",
        [
          {
            id: registry.repos[0].id,
            name: registry.repos[0].name,
            base: "main",
            bareRepoPath: managedRepoPath,
          },
        ],
      );

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
      const secondRepo = registry.repos.find(
        (repo) => repo.id === localRepoId(second.tempRemote),
      ) as NonNullable<(typeof registry.repos)[number]>;
      const reposRoot = path.join(tempHome, "repos");

      writeManifestFixture(
        tempHome,
        reposRoot,
        "REMOVE-SHARED-123",
        "feat",
        "feat/REMOVE-SHARED-123",
        [
          {
            id: secondRepo.id,
            name: secondRepo.name,
            base: "main",
            bareRepoPath: secondRepo.managedRepoPath,
          },
        ],
      );

      const exitCode = await runCli([
        "workspace",
        "remove",
        "REMOVE-SHARED-123",
      ]);
      const secondWorktreeList = execFileSync(
        "git",
        ["--git-dir", secondRepo.managedRepoPath, "worktree", "list"],
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
      const reposRoot = path.join(linkedHome, "repos");

      writeManifestFixture(
        linkedHome,
        reposRoot,
        "REMOVE-LINKED-123",
        "feat",
        "feat/REMOVE-LINKED-123",
        [
          {
            id: registry.repos[0].id,
            name: registry.repos[0].name,
            base: "main",
            bareRepoPath: managedRepoPath,
          },
        ],
      );

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
      const reposRoot = path.join(tempHome, "repos");

      writeManifestFixture(
        tempHome,
        reposRoot,
        "REMOVE-123",
        "feat",
        "feat/REMOVE-123",
        [
          {
            id: registry.repos[0].id,
            name: registry.repos[0].name,
            base: "main",
            bareRepoPath: managedRepoPath,
          },
        ],
      );

      rmSync(managedRepoPath, { recursive: true, force: true });

      const exitCode = await runCli(["workspace", "remove", "REMOVE-123"]);
      expect(exitCode).toBe(0);
      expect(existsSync(ticketDirectory)).toBe(false);
    });
  });

  describe("manifest-backed commands", () => {
    it("reports ready status when manifest and all paths exist", async () => {
      const tempHome = createTempDir("outpost-test-");
      process.env.OUTPOST_HOME = tempHome;

      await runCli(["init"]);

      const alpha = await createManagedRepoFixture({ defaultBranch: "main" });
      await runCli(["repo", "add", alpha.tempRepo]);
      await runCli([
        "create",
        "--ticket",
        "READY-123",
        "--type",
        "feat",
        "--repo",
        localRepoId(alpha.tempRemote),
      ]);

      const registry = readRegistry(tempHome);
      const managedRepoPath = registry.repos[0].managedRepoPath;
      const reposRoot = path.join(tempHome, "repos");

      writeManifestFixture(
        tempHome,
        reposRoot,
        "READY-123",
        "feat",
        "feat/READY-123",
        [
          {
            id: registry.repos[0].id,
            name: registry.repos[0].name,
            base: "main",
            bareRepoPath: managedRepoPath,
          },
        ],
      );

      const infoSpy = vi
        .spyOn(console, "log")
        .mockImplementation(() => undefined);

      const exitCode = await runCli(["workspace", "list"]);
      expect(exitCode).toBe(0);

      const output = infoSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toContain("- READY-123 [ready]");
    });

    it("reports missing status when manifest exists but worktree directory is missing", async () => {
      const tempHome = createTempDir("outpost-test-");
      process.env.OUTPOST_HOME = tempHome;

      await runCli(["init"]);

      const manifestsDir = path.join(tempHome, "workspaces");
      mkdirSync(manifestsDir, { recursive: true });

      const manifestPath = path.join(manifestsDir, "MISSING-123.json");
      writeFileSync(
        manifestPath,
        JSON.stringify(
          {
            ticket: "MISSING-123",
            type: "feat",
            branch: "feat/MISSING-123",
            createdAt: new Date().toISOString(),
            workspacePath: "MISSING-123",
            repositories: [],
          },
          null,
          2,
        ) + "\n",
      );

      const infoSpy = vi
        .spyOn(console, "log")
        .mockImplementation(() => undefined);

      const exitCode = await runCli(["workspace", "list"]);
      expect(exitCode).toBe(0);

      const output = infoSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toContain("- MISSING-123 [missing]");
    });

    it("reports invalid status for corrupt JSON manifest", async () => {
      const tempHome = createTempDir("outpost-test-");
      process.env.OUTPOST_HOME = tempHome;

      await runCli(["init"]);

      const manifestsDir = path.join(tempHome, "workspaces");
      mkdirSync(manifestsDir, { recursive: true });

      writeFileSync(
        path.join(manifestsDir, "CORRUPT-123.json"),
        "{not valid json",
      );

      const infoSpy = vi
        .spyOn(console, "log")
        .mockImplementation(() => undefined);

      const exitCode = await runCli(["workspace", "list"]);
      expect(exitCode).toBe(0);

      const output = infoSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toContain("- CORRUPT-123 [invalid]");
      expect(output).toContain("diagnostic:");
    });

    it("reports unmanaged status for ticket directory without manifest", async () => {
      const tempHome = createTempDir("outpost-test-");
      process.env.OUTPOST_HOME = tempHome;

      await runCli(["init"]);

      const worktreesRoot = path.join(tempHome, "worktrees");
      const unmanagedDir = path.join(worktreesRoot, "UNMANAGED-123");
      mkdirSync(unmanagedDir, { recursive: true });

      const infoSpy = vi
        .spyOn(console, "log")
        .mockImplementation(() => undefined);

      const exitCode = await runCli(["workspace", "list"]);
      expect(exitCode).toBe(0);

      const output = infoSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toContain("- UNMANAGED-123 [unmanaged]");
    });

    it("list continues when one manifest is invalid but others are valid", async () => {
      const tempHome = createTempDir("outpost-test-");
      process.env.OUTPOST_HOME = tempHome;

      await runCli(["init"]);

      const alpha = await createManagedRepoFixture({ defaultBranch: "main" });
      await runCli(["repo", "add", alpha.tempRepo]);
      await runCli([
        "create",
        "--ticket",
        "GOOD-123",
        "--type",
        "feat",
        "--repo",
        localRepoId(alpha.tempRemote),
      ]);

      const registry = readRegistry(tempHome);
      const managedRepoPath = registry.repos[0].managedRepoPath;
      const reposRoot = path.join(tempHome, "repos");

      writeManifestFixture(
        tempHome,
        reposRoot,
        "GOOD-123",
        "feat",
        "feat/GOOD-123",
        [
          {
            id: registry.repos[0].id,
            name: registry.repos[0].name,
            base: "main",
            bareRepoPath: managedRepoPath,
          },
        ],
      );

      const manifestsDir = path.join(tempHome, "workspaces");
      writeFileSync(
        path.join(manifestsDir, "BAD-123.json"),
        "{not json at all",
      );

      const infoSpy = vi
        .spyOn(console, "log")
        .mockImplementation(() => undefined);

      const exitCode = await runCli(["workspace", "list"]);
      expect(exitCode).toBe(0);

      const output = infoSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toContain("- BAD-123 [invalid]");
      expect(output).toContain("- GOOD-123 [ready]");
    });

    it("show uses manifest identity rather than directory-inferred data", async () => {
      const tempHome = createTempDir("outpost-test-");
      process.env.OUTPOST_HOME = tempHome;

      await runCli(["init"]);

      const alpha = await createManagedRepoFixture({ defaultBranch: "main" });
      await runCli(["repo", "add", alpha.tempRepo]);
      await runCli([
        "create",
        "--ticket",
        "SHOW-MANIFEST-123",
        "--type",
        "feat",
        "--repo",
        localRepoId(alpha.tempRemote),
      ]);

      const registry = readRegistry(tempHome);
      const managedRepoPath = registry.repos[0].managedRepoPath;
      const reposRoot = path.join(tempHome, "repos");

      writeManifestFixture(
        tempHome,
        reposRoot,
        "SHOW-MANIFEST-123",
        "feat",
        "feat/SHOW-MANIFEST-123",
        [
          {
            id: registry.repos[0].id,
            name: registry.repos[0].name,
            base: "main",
            bareRepoPath: managedRepoPath,
          },
        ],
      );

      const infoSpy = vi
        .spyOn(console, "log")
        .mockImplementation(() => undefined);

      const exitCode = await runCli(["workspace", "show", "SHOW-MANIFEST-123"]);
      expect(exitCode).toBe(0);

      const output = infoSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toContain("ticket: SHOW-MANIFEST-123");
      expect(output).toContain("type: feat");
      expect(output).toContain("branch: feat/SHOW-MANIFEST-123");
      expect(output).toContain("status: ready");
    });

    it("dirty worktree removal is refused", async () => {
      const tempHome = createTempDir("outpost-test-");
      process.env.OUTPOST_HOME = tempHome;

      await runCli(["init"]);

      const alpha = await createManagedRepoFixture({ defaultBranch: "main" });
      await runCli(["repo", "add", alpha.tempRepo]);
      await runCli([
        "create",
        "--ticket",
        "DIRTY-123",
        "--type",
        "feat",
        "--repo",
        localRepoId(alpha.tempRemote),
      ]);

      const registry = readRegistry(tempHome);
      const managedRepoPath = registry.repos[0].managedRepoPath;
      const reposRoot = path.join(tempHome, "repos");

      writeManifestFixture(
        tempHome,
        reposRoot,
        "DIRTY-123",
        "feat",
        "feat/DIRTY-123",
        [
          {
            id: registry.repos[0].id,
            name: registry.repos[0].name,
            base: "main",
            bareRepoPath: managedRepoPath,
          },
        ],
      );

      const ticketDirectory = path.join(tempHome, "worktrees", "DIRTY-123");
      const worktreePath = path.join(ticketDirectory, registry.repos[0].name);
      writeFileSync(path.join(worktreePath, "uncommitted.txt"), "dirty\n");

      const errorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);

      const exitCode = await runCli(["workspace", "remove", "DIRTY-123"]);
      expect(exitCode).toBe(1);
      expect(errorSpy.mock.calls.map((c) => c[0]).join(" ")).toContain(
        "uncommitted changes",
      );
      expect(existsSync(worktreePath)).toBe(true);
    });

    it("mismatched worktree ownership stops removal", async () => {
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
        "MISMATCH-123",
        "--type",
        "feat",
        "--repo",
        localRepoId(alpha.tempRemote),
      ]);

      const registry = readRegistry(tempHome);
      const alphaRepo = registry.repos.find(
        (r) => r.id === localRepoId(alpha.tempRemote),
      ) as NonNullable<(typeof registry.repos)[number]>;
      const betaRepo = registry.repos.find(
        (r) => r.id === localRepoId(beta.tempRemote),
      ) as NonNullable<(typeof registry.repos)[number]>;
      const reposRoot = path.join(tempHome, "repos");

      writeManifestFixture(
        tempHome,
        reposRoot,
        "MISMATCH-123",
        "feat",
        "feat/MISMATCH-123",
        [
          {
            id: alphaRepo.id,
            name: alphaRepo.name,
            base: "main",
            bareRepoPath: betaRepo.managedRepoPath,
          },
        ],
      );

      const errorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);

      const exitCode = await runCli(["workspace", "remove", "MISMATCH-123"]);
      expect(exitCode).toBe(1);
      expect(errorSpy.mock.calls.map((c) => c[0]).join(" ")).toContain(
        "ownership mismatch",
      );
    });

    it("normal removal preserves branches in the bare repo", async () => {
      const { execFileSync } = await import("node:child_process");
      const tempHome = createTempDir("outpost-test-");
      process.env.OUTPOST_HOME = tempHome;

      await runCli(["init"]);

      const alpha = await createManagedRepoFixture({ defaultBranch: "main" });
      await runCli(["repo", "add", alpha.tempRepo]);
      await runCli([
        "create",
        "--ticket",
        "BRANCH-123",
        "--type",
        "feat",
        "--repo",
        localRepoId(alpha.tempRemote),
      ]);

      const registry = readRegistry(tempHome);
      const managedRepoPath = registry.repos[0].managedRepoPath;
      const reposRoot = path.join(tempHome, "repos");

      writeManifestFixture(
        tempHome,
        reposRoot,
        "BRANCH-123",
        "feat",
        "feat/BRANCH-123",
        [
          {
            id: registry.repos[0].id,
            name: registry.repos[0].name,
            base: "main",
            bareRepoPath: managedRepoPath,
          },
        ],
      );

      const exitCode = await runCli(["workspace", "remove", "BRANCH-123"]);
      expect(exitCode).toBe(0);

      const branches = execFileSync(
        "git",
        ["--git-dir", managedRepoPath, "branch"],
        { encoding: "utf8" },
      );
      expect(branches).toContain("feat/BRANCH-123");
    });

    it("normal removal deletes manifest last", async () => {
      const tempHome = createTempDir("outpost-test-");
      process.env.OUTPOST_HOME = tempHome;

      await runCli(["init"]);

      const alpha = await createManagedRepoFixture({ defaultBranch: "main" });
      await runCli(["repo", "add", alpha.tempRepo]);
      await runCli([
        "create",
        "--ticket",
        "DEL-MANIFEST-123",
        "--type",
        "feat",
        "--repo",
        localRepoId(alpha.tempRemote),
      ]);

      const registry = readRegistry(tempHome);
      const managedRepoPath = registry.repos[0].managedRepoPath;
      const reposRoot = path.join(tempHome, "repos");

      writeManifestFixture(
        tempHome,
        reposRoot,
        "DEL-MANIFEST-123",
        "feat",
        "feat/DEL-MANIFEST-123",
        [
          {
            id: registry.repos[0].id,
            name: registry.repos[0].name,
            base: "main",
            bareRepoPath: managedRepoPath,
          },
        ],
      );

      const manifestPath = path.join(
        tempHome,
        "workspaces",
        "DEL-MANIFEST-123.json",
      );
      expect(existsSync(manifestPath)).toBe(true);

      const exitCode = await runCli([
        "workspace",
        "remove",
        "DEL-MANIFEST-123",
      ]);
      expect(exitCode).toBe(0);
      expect(existsSync(manifestPath)).toBe(false);
    });

    it("lock is released on removal success", async () => {
      const tempHome = createTempDir("outpost-test-");
      process.env.OUTPOST_HOME = tempHome;

      await runCli(["init"]);

      const alpha = await createManagedRepoFixture({ defaultBranch: "main" });
      await runCli(["repo", "add", alpha.tempRepo]);
      await runCli([
        "create",
        "--ticket",
        "LOCK-REL-123",
        "--type",
        "feat",
        "--repo",
        localRepoId(alpha.tempRemote),
      ]);

      const registry = readRegistry(tempHome);
      const managedRepoPath = registry.repos[0].managedRepoPath;
      const reposRoot = path.join(tempHome, "repos");

      writeManifestFixture(
        tempHome,
        reposRoot,
        "LOCK-REL-123",
        "feat",
        "feat/LOCK-REL-123",
        [
          {
            id: registry.repos[0].id,
            name: registry.repos[0].name,
            base: "main",
            bareRepoPath: managedRepoPath,
          },
        ],
      );

      const exitCode = await runCli(["workspace", "remove", "LOCK-REL-123"]);
      expect(exitCode).toBe(0);

      const lockPath = path.join(tempHome, "workspaces", ".LOCK-REL-123.lock");
      expect(existsSync(lockPath)).toBe(false);
    });

    it("lock is released on removal failure", async () => {
      const tempHome = createTempDir("outpost-test-");
      process.env.OUTPOST_HOME = tempHome;

      await runCli(["init"]);

      const alpha = await createManagedRepoFixture({ defaultBranch: "main" });
      await runCli(["repo", "add", alpha.tempRepo]);
      await runCli([
        "create",
        "--ticket",
        "LOCK-FAIL-123",
        "--type",
        "feat",
        "--repo",
        localRepoId(alpha.tempRemote),
      ]);

      const registry = readRegistry(tempHome);
      const managedRepoPath = registry.repos[0].managedRepoPath;
      const reposRoot = path.join(tempHome, "repos");
      const ticketDirectory = path.join(tempHome, "worktrees", "LOCK-FAIL-123");

      writeManifestFixture(
        tempHome,
        reposRoot,
        "LOCK-FAIL-123",
        "feat",
        "feat/LOCK-FAIL-123",
        [
          {
            id: registry.repos[0].id,
            name: registry.repos[0].name,
            base: "main",
            bareRepoPath: managedRepoPath,
          },
        ],
      );

      const worktreePath = path.join(ticketDirectory, registry.repos[0].name);
      writeFileSync(path.join(worktreePath, "dirty.txt"), "modified\n");

      const exitCode = await runCli(["workspace", "remove", "LOCK-FAIL-123"]);
      expect(exitCode).toBe(1);

      const lockPath = path.join(tempHome, "workspaces", ".LOCK-FAIL-123.lock");
      expect(existsSync(lockPath)).toBe(false);
    });

    it("errors clearly when manifest is missing for managed removal", async () => {
      const tempHome = createTempDir("outpost-test-");
      process.env.OUTPOST_HOME = tempHome;

      await runCli(["init"]);

      const alpha = await createManagedRepoFixture({ defaultBranch: "main" });
      await runCli(["repo", "add", alpha.tempRepo]);
      await runCli([
        "create",
        "--ticket",
        "NO-MANIFEST-123",
        "--type",
        "feat",
        "--repo",
        localRepoId(alpha.tempRemote),
      ]);

      const errorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);

      const exitCode = await runCli(["workspace", "remove", "NO-MANIFEST-123"]);
      expect(exitCode).toBe(1);
      expect(errorSpy.mock.calls.map((c) => c[0]).join(" ")).toContain(
        "unmanaged",
      );
    });
  });
});
