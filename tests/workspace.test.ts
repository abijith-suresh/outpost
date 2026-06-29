import { chmodSync, rmSync, symlinkSync } from "node:fs";

import * as FileSystem from "@effect/platform/FileSystem";
import { NodeContext } from "@effect/platform-node";
import { Effect, Exit } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  makeAgentsRemovalPrompt,
  type AgentsRemovalPrompt,
  type PromptReadline,
} from "../src/commands/workspace-remove-prompt.ts";
import { runWorkspaceRemove } from "../src/commands/workspace-remove.ts";
import {
  AGENTS_MARKER_PREFIX,
  computeSha256,
} from "../src/workspace-agents.ts";

import {
  createManagedRepoFixture,
  existsSync,
  mkdirSync,
  path,
  readFileSync,
  readRegistry,
  runCli,
  localRepoId,
  setupAfterEach,
  createTempDir,
  writeFileSync,
} from "./helpers.ts";

setupAfterEach();

type PromptScenario = "decline" | "empty" | "eof" | "sigint" | "rejection";

class RemovalPromptReadline implements PromptReadline {
  private readonly listeners = new Map<"SIGINT" | "close", Array<() => void>>();

  constructor(
    private readonly scenario: PromptScenario | "yes",
    private readonly onQuestion?: () => void,
  ) {}

  once(event: "SIGINT" | "close", listener: () => void): void {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
  }

  question(): Promise<string> {
    this.onQuestion?.();

    if (this.scenario === "eof" || this.scenario === "sigint") {
      queueMicrotask(() =>
        this.emit(this.scenario === "eof" ? "close" : "SIGINT"),
      );
      return new Promise(() => undefined);
    }

    if (this.scenario === "rejection") {
      return Promise.reject(new Error("simulated question rejection"));
    }

    return Promise.resolve(
      this.scenario === "yes" ? "yes" : this.scenario === "empty" ? "" : "no",
    );
  }

  close(): void {
    this.emit("close");
  }

  private emit(event: "SIGINT" | "close"): void {
    const listeners = this.listeners.get(event) ?? [];
    this.listeners.delete(event);
    for (const listener of listeners) {
      listener();
    }
  }
}

function removalPrompt(
  scenario: PromptScenario | "yes",
  onQuestion?: () => void,
): AgentsRemovalPrompt {
  return makeAgentsRemovalPrompt({
    createReadline: () => new RemovalPromptReadline(scenario, onQuestion),
  });
}

function managedAgentsContent(body: string): string {
  return `${AGENTS_MARKER_PREFIX}${computeSha256(body)} -->\n${body}`;
}

async function createAgentsWorkspace(ticket: string) {
  const tempHome = createTempDir("outpost-test-");
  process.env.OUTPOST_HOME = tempHome;
  await runCli(["init"]);

  const repo = await createManagedRepoFixture({ defaultBranch: "main" });
  await runCli(["repo", "add", repo.tempRepo]);
  expect(
    await runCli([
      "create",
      "--ticket",
      ticket,
      "--type",
      "feat",
      "--repo",
      localRepoId(repo.tempRemote),
    ]),
  ).toBe(0);

  const registry = readRegistry(tempHome);
  const managedRepoPath = registry.repos[0].managedRepoPath;
  const ticketDirectory = path.join(tempHome, "worktrees", ticket);
  const worktreePath = path.join(ticketDirectory, path.basename(repo.tempRepo));

  return {
    agentsPath: path.join(ticketDirectory, "AGENTS.md"),
    branch: `feat/${ticket}`,
    lockPath: path.join(
      tempHome,
      "workspaces",
      `.${ticket.toLowerCase()}.lock`,
    ),
    managedRepoPath,
    manifestPath: path.join(tempHome, "workspaces", `${ticket}.json`),
    tempHome,
    ticket,
    ticketDirectory,
    worktreePath,
  };
}

async function runInteractiveWorkspaceRemove(
  ticket: string,
  prompt: AgentsRemovalPrompt,
) {
  return Effect.runPromise(
    Effect.exit(
      runWorkspaceRemove(ticket, [], {
        interactive: true,
        promptAgentsRemovalConsent: prompt,
      }).pipe(Effect.provide(NodeContext.layer)),
    ),
  );
}

async function expectWorkspaceIntact(
  fixture: Awaited<ReturnType<typeof createAgentsWorkspace>>,
  agentsContent: string,
) {
  const { execFileSync } = await import("node:child_process");

  expect(readFileSync(fixture.agentsPath, "utf8")).toBe(agentsContent);
  expect(existsSync(fixture.manifestPath)).toBe(true);
  expect(existsSync(fixture.ticketDirectory)).toBe(true);
  expect(existsSync(fixture.worktreePath)).toBe(true);
  expect(existsSync(fixture.lockPath)).toBe(false);
  expect(() =>
    execFileSync("git", [
      "--git-dir",
      fixture.managedRepoPath,
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${fixture.branch}`,
    ]),
  ).not.toThrow();
  const registrations = execFileSync(
    "git",
    ["--git-dir", fixture.managedRepoPath, "worktree", "list", "--porcelain"],
    { encoding: "utf8" },
  );
  expect(registrations).toContain(`worktree ${fixture.worktreePath}`);
}

async function installFailingGitShim(
  tempHome: string,
  failure: "status" | "worktree-remove",
) {
  const { execFileSync } = await import("node:child_process");
  const realGit = execFileSync("sh", ["-c", "command -v git"], {
    encoding: "utf8",
  }).trim();
  const binDirectory = path.join(tempHome, "bin");
  const shimPath = path.join(binDirectory, "git");
  mkdirSync(binDirectory, { recursive: true });
  writeFileSync(
    shimPath,
    `#!/bin/sh
if [ "$OUTPOST_TEST_GIT_FAILURE" = "status" ]; then
  for arg in "$@"; do
    if [ "$arg" = "status" ]; then
      exit 42
    fi
  done
fi
if [ "$OUTPOST_TEST_GIT_FAILURE" = "worktree-remove" ]; then
  previous=""
  for arg in "$@"; do
    if [ "$previous" = "worktree" ] && [ "$arg" = "remove" ]; then
      exit 43
    fi
    previous="$arg"
  done
fi
exec "${realGit}" "$@"
`,
  );
  chmodSync(shimPath, 0o755);
  process.env.PATH = `${binDirectory}:${process.env.PATH ?? ""}`;
  process.env.OUTPOST_TEST_GIT_FAILURE = failure;
}

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
    expect(calls[3]).toBe("type: feat");
    expect(calls[4]).toBe("branch: feat/SHOW-123");
    // calls[5] is "created at: ..." (timestamp varies)
    expect(calls[6]).toBe("workspace path: SHOW-123");
    expect(calls[7]).toBe("status: ready");
    // calls[8] is "manifest: ..."
    expect(calls[9]).toBe("worktrees: 1");
    expect(calls[10]).toBe(
      `- ${path.basename(alpha.tempRepo)} (id: ${localRepoId(alpha.tempRemote)})`,
    );
    expect(calls[11]).toBe(`  path: ${worktreePath}`);
    expect(calls[12]).toBe("  base: main");
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
    expect(output).toContain('"ok": true');
    expect(output).toContain('"exitCode": 0');
    expect(output).toContain('"command": "workspace show"');
    expect(output).toContain('"ticket": "SHOW-JSON-456"');
    expect(output).toContain('"status": "ready"');
    expect(output).toContain(`"name": "${path.basename(alpha.tempRepo)}"`);
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
    expect(calls[2]).toContain("- LIST-123 [ready]");
    expect(calls[3]).toBe(
      `  workspace directory: ${path.join(tempHome, "worktrees", "LIST-123")}`,
    );
    expect(calls[4]).toBe("  type: feat");
    expect(calls[5]).toBe("  branch: feat/LIST-123");
    // calls[6] is "  created at: ..." (timestamp varies)
    expect(calls[7]).toBe("  worktrees: 1");
    expect(calls[8]).toContain("- LIST-456");
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
    expect(output).toContain('"ok": true');
    expect(output).toContain('"exitCode": 0');
    expect(output).toContain('"command": "workspace list"');
    expect(output).toContain('"ticket": "LIST-JSON-789"');
    expect(output).toContain('"status": "ready"');
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

  it("shows a corrupt manifest as invalid without inferring directory contents", async () => {
    const tempHome = createTempDir("outpost-test-");
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    const ticketDirectory = path.join(tempHome, "worktrees", "CORRUPT-SHOW");
    mkdirSync(ticketDirectory, { recursive: true });
    writeFileSync(path.join(ticketDirectory, "not-a-worktree"), "keep\n");
    writeFileSync(
      path.join(tempHome, "workspaces", "CORRUPT-SHOW.json"),
      "{invalid json",
    );

    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["workspace", "show", "CORRUPT-SHOW"]);
    const output = infoSpy.mock.calls.map((call) => call[0]).join("\n");

    expect(exitCode).toBe(0);
    expect(output).toContain("status: invalid");
    expect(output).toContain("diagnostic:");
    expect(output).not.toContain("not-a-worktree");
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
      expect(output).toContain('"ok": true');
      expect(output).toContain('"exitCode": 0');
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

    it("refuses removal when the managed repo directory is missing", async () => {
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

      const manifestPath = path.join(tempHome, "workspaces", "REMOVE-123.json");
      const errorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      const exitCode = await runCli(["workspace", "remove", "REMOVE-123"]);
      expect(exitCode).toBe(1);
      expect(errorSpy.mock.calls.map((call) => call[0]).join("\n")).toContain(
        "Cannot establish cleanliness",
      );
      expect(existsSync(ticketDirectory)).toBe(true);
      expect(existsSync(manifestPath)).toBe(true);
    });

    it("rejects a manifest whose workspacePath targets another ticket directory", async () => {
      const tempHome = createTempDir("outpost-test-");
      process.env.OUTPOST_HOME = tempHome;

      await runCli(["init"]);

      const alpha = await createManagedRepoFixture({ defaultBranch: "main" });
      await runCli(["repo", "add", alpha.tempRepo]);
      await runCli([
        "create",
        "--ticket",
        "WRONG-WORKSPACE-PATH",
        "--type",
        "feat",
        "--repo",
        localRepoId(alpha.tempRemote),
      ]);

      const expectedDirectory = path.join(
        tempHome,
        "worktrees",
        "WRONG-WORKSPACE-PATH",
      );
      const otherDirectory = path.join(tempHome, "worktrees", "OTHER-TICKET");
      const sentinelPath = path.join(otherDirectory, "keep.txt");
      mkdirSync(otherDirectory, { recursive: true });
      writeFileSync(sentinelPath, "keep\n");

      const manifestPath = path.join(
        tempHome,
        "workspaces",
        "WRONG-WORKSPACE-PATH.json",
      );
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      manifest.workspacePath = "OTHER-TICKET";
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

      const errorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      const exitCode = await runCli([
        "workspace",
        "remove",
        "WRONG-WORKSPACE-PATH",
      ]);

      expect(exitCode).toBe(1);
      expect(errorSpy.mock.calls.map((call) => call[0]).join("\n")).toContain(
        "does not resolve to the expected ticket directory",
      );
      expect(existsSync(expectedDirectory)).toBe(true);
      expect(readFileSync(sentinelPath, "utf8")).toBe("keep\n");
      expect(existsSync(manifestPath)).toBe(true);
    });

    it("rejects a workspacePath symlink escape before cleanup", async () => {
      const tempHome = createTempDir("outpost-test-");
      process.env.OUTPOST_HOME = tempHome;

      await runCli(["init"]);

      const alpha = await createManagedRepoFixture({ defaultBranch: "main" });
      await runCli(["repo", "add", alpha.tempRepo]);
      await runCli([
        "create",
        "--ticket",
        "WORKSPACE-SYMLINK",
        "--type",
        "feat",
        "--repo",
        localRepoId(alpha.tempRemote),
      ]);

      const outsideDirectory = createTempDir("outpost-outside-workspace-");
      const sentinelPath = path.join(outsideDirectory, "keep.txt");
      writeFileSync(sentinelPath, "keep\n");
      symlinkSync(
        outsideDirectory,
        path.join(tempHome, "worktrees", "escape-link"),
        "dir",
      );

      const manifestPath = path.join(
        tempHome,
        "workspaces",
        "WORKSPACE-SYMLINK.json",
      );
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      manifest.workspacePath = "escape-link";
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

      const expectedDirectory = path.join(
        tempHome,
        "worktrees",
        "WORKSPACE-SYMLINK",
      );
      const errorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      const exitCode = await runCli([
        "workspace",
        "remove",
        "WORKSPACE-SYMLINK",
      ]);

      expect(exitCode).toBe(1);
      expect(errorSpy.mock.calls.map((call) => call[0]).join("\n")).toContain(
        "Path must remain within",
      );
      expect(existsSync(expectedDirectory)).toBe(true);
      expect(readFileSync(sentinelPath, "utf8")).toBe("keep\n");
      expect(existsSync(manifestPath)).toBe(true);
    });

    it("rejects a ticket directory symlink to another workspace", async () => {
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
        "SOURCE-TICKET",
        "--type",
        "feat",
        "--repo",
        localRepoId(alpha.tempRemote),
      ]);
      await runCli([
        "create",
        "--ticket",
        "TARGET-TICKET",
        "--type",
        "feat",
        "--repo",
        localRepoId(beta.tempRemote),
      ]);

      const sourceDirectory = path.join(tempHome, "worktrees", "SOURCE-TICKET");
      const targetDirectory = path.join(tempHome, "worktrees", "TARGET-TICKET");
      const sentinelPath = path.join(targetDirectory, "keep.txt");
      writeFileSync(sentinelPath, "keep\n");
      rmSync(sourceDirectory, { recursive: true, force: true });
      symlinkSync(targetDirectory, sourceDirectory, "dir");

      const errorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      const exitCode = await runCli(["workspace", "remove", "SOURCE-TICKET"]);

      expect(exitCode).toBe(1);
      expect(errorSpy.mock.calls.map((call) => call[0]).join("\n")).toContain(
        "does not resolve to the expected ticket directory",
      );
      expect(readFileSync(sentinelPath, "utf8")).toBe("keep\n");
      expect(
        existsSync(path.join(tempHome, "workspaces", "SOURCE-TICKET.json")),
      ).toBe(true);
    });

    it("rejects a managed repository symlink escape before cleanup", async () => {
      const tempHome = createTempDir("outpost-test-");
      process.env.OUTPOST_HOME = tempHome;

      await runCli(["init"]);

      const alpha = await createManagedRepoFixture({ defaultBranch: "main" });
      await runCli(["repo", "add", alpha.tempRepo]);
      await runCli([
        "create",
        "--ticket",
        "SYMLINK-ESCAPE",
        "--type",
        "feat",
        "--repo",
        localRepoId(alpha.tempRemote),
      ]);

      const registry = readRegistry(tempHome);
      const managedRepoPath = registry.repos[0].managedRepoPath;
      const outsideManagedPath = path.join(
        createTempDir("outpost-outside-managed-"),
        "outside.git",
      );
      mkdirSync(outsideManagedPath, { recursive: true });
      rmSync(managedRepoPath, { recursive: true, force: true });
      symlinkSync(outsideManagedPath, managedRepoPath, "dir");

      const ticketDirectory = path.join(
        tempHome,
        "worktrees",
        "SYMLINK-ESCAPE",
      );
      const worktreePath = path.join(ticketDirectory, registry.repos[0].name);
      const manifestPath = path.join(
        tempHome,
        "workspaces",
        "SYMLINK-ESCAPE.json",
      );

      const errorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      const exitCode = await runCli(["workspace", "remove", "SYMLINK-ESCAPE"]);

      expect(exitCode).toBe(1);
      expect(errorSpy.mock.calls.map((call) => call[0]).join("\n")).toContain(
        "Path must remain within",
      );
      expect(existsSync(worktreePath)).toBe(true);
      expect(existsSync(manifestPath)).toBe(true);
    });

    it("rejects a worktree symlink escape before cleanup", async () => {
      const { execFileSync } = await import("node:child_process");
      const tempHome = createTempDir("outpost-test-");
      process.env.OUTPOST_HOME = tempHome;

      await runCli(["init"]);

      const alpha = await createManagedRepoFixture({ defaultBranch: "main" });
      await runCli(["repo", "add", alpha.tempRepo]);
      await runCli([
        "create",
        "--ticket",
        "WORKTREE-SYMLINK",
        "--type",
        "feat",
        "--repo",
        localRepoId(alpha.tempRemote),
      ]);

      const registry = readRegistry(tempHome);
      const managedRepoPath = registry.repos[0].managedRepoPath;
      const worktreePath = path.join(
        tempHome,
        "worktrees",
        "WORKTREE-SYMLINK",
        registry.repos[0].name,
      );
      execFileSync("git", [
        "--git-dir",
        managedRepoPath,
        "worktree",
        "remove",
        worktreePath,
      ]);

      const outsideDirectory = createTempDir("outpost-outside-worktree-");
      const sentinelPath = path.join(outsideDirectory, "keep.txt");
      writeFileSync(sentinelPath, "keep\n");
      symlinkSync(outsideDirectory, worktreePath, "dir");

      const manifestPath = path.join(
        tempHome,
        "workspaces",
        "WORKTREE-SYMLINK.json",
      );
      const errorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      const exitCode = await runCli([
        "workspace",
        "remove",
        "WORKTREE-SYMLINK",
      ]);

      expect(exitCode).toBe(1);
      expect(errorSpy.mock.calls.map((call) => call[0]).join("\n")).toContain(
        "Path must remain within",
      );
      expect(readFileSync(sentinelPath, "utf8")).toBe("keep\n");
      expect(existsSync(manifestPath)).toBe(true);
    });

    it("preserves residual workspace entries and returns a nonzero partial result", async () => {
      const tempHome = createTempDir("outpost-test-");
      process.env.OUTPOST_HOME = tempHome;

      await runCli(["init"]);

      const alpha = await createManagedRepoFixture({ defaultBranch: "main" });
      await runCli(["repo", "add", alpha.tempRepo]);
      await runCli([
        "create",
        "--ticket",
        "RESIDUAL-REMOVE",
        "--type",
        "feat",
        "--repo",
        localRepoId(alpha.tempRemote),
      ]);

      const ticketDirectory = path.join(
        tempHome,
        "worktrees",
        "RESIDUAL-REMOVE",
      );
      const residualPath = path.join(ticketDirectory, "keep.txt");
      const manifestPath = path.join(
        tempHome,
        "workspaces",
        "RESIDUAL-REMOVE.json",
      );
      writeFileSync(residualPath, "keep\n");

      const infoSpy = vi
        .spyOn(console, "log")
        .mockImplementation(() => undefined);
      const exitCode = await runCli(["workspace", "remove", "RESIDUAL-REMOVE"]);
      const output = infoSpy.mock.calls.map((call) => call[0]).join("\n");

      expect(exitCode).toBe(1);
      expect(output).toContain("status: partial");
      expect(output).toContain("residual entries");
      expect(readFileSync(residualPath, "utf8")).toBe("keep\n");
      expect(existsSync(manifestPath)).toBe(true);
    });

    it("refuses cleanup when git status fails", async () => {
      const tempHome = createTempDir("outpost-test-");
      process.env.OUTPOST_HOME = tempHome;

      await runCli(["init"]);

      const alpha = await createManagedRepoFixture({ defaultBranch: "main" });
      await runCli(["repo", "add", alpha.tempRepo]);
      await runCli([
        "create",
        "--ticket",
        "STATUS-FAILURE",
        "--type",
        "feat",
        "--repo",
        localRepoId(alpha.tempRemote),
      ]);

      await installFailingGitShim(tempHome, "status");

      const ticketDirectory = path.join(
        tempHome,
        "worktrees",
        "STATUS-FAILURE",
      );
      const manifestPath = path.join(
        tempHome,
        "workspaces",
        "STATUS-FAILURE.json",
      );
      const errorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      const exitCode = await runCli(["workspace", "remove", "STATUS-FAILURE"]);

      expect(exitCode).toBe(1);
      expect(errorSpy.mock.calls.map((call) => call[0]).join("\n")).toContain(
        "Failed to establish cleanliness",
      );
      expect(existsSync(ticketDirectory)).toBe(true);
      expect(existsSync(manifestPath)).toBe(true);
    });

    it("returns nonzero partial status when git worktree cleanup fails", async () => {
      const tempHome = createTempDir("outpost-test-");
      process.env.OUTPOST_HOME = tempHome;

      await runCli(["init"]);

      const alpha = await createManagedRepoFixture({ defaultBranch: "main" });
      await runCli(["repo", "add", alpha.tempRepo]);
      await runCli([
        "create",
        "--ticket",
        "CLEANUP-FAILURE",
        "--type",
        "feat",
        "--repo",
        localRepoId(alpha.tempRemote),
      ]);

      await installFailingGitShim(tempHome, "worktree-remove");

      const ticketDirectory = path.join(
        tempHome,
        "worktrees",
        "CLEANUP-FAILURE",
      );
      const manifestPath = path.join(
        tempHome,
        "workspaces",
        "CLEANUP-FAILURE.json",
      );
      const infoSpy = vi
        .spyOn(console, "log")
        .mockImplementation(() => undefined);
      const exitCode = await runCli(["workspace", "remove", "CLEANUP-FAILURE"]);
      const output = infoSpy.mock.calls.map((call) => call[0]).join("\n");

      expect(exitCode).toBe(1);
      expect(output).toContain("status: partial");
      expect(output).toContain("git exited with status 43");
      expect(existsSync(ticketDirectory)).toBe(true);
      expect(existsSync(manifestPath)).toBe(true);
    });

    it("deletes an unchanged generated AGENTS.md", async () => {
      const fixture = await createAgentsWorkspace("AGENT-DEL-001");

      expect(await runCli(["workspace", "remove", fixture.ticket])).toBe(0);
      expect(existsSync(fixture.agentsPath)).toBe(false);
      expect(existsSync(fixture.ticketDirectory)).toBe(false);
      expect(existsSync(fixture.manifestPath)).toBe(false);
    });

    it("continues removal when AGENTS.md remains missing", async () => {
      const fixture = await createAgentsWorkspace("MISSING-AGENT-001");
      rmSync(fixture.agentsPath);

      expect(await runCli(["workspace", "remove", fixture.ticket])).toBe(0);
      expect(existsSync(fixture.ticketDirectory)).toBe(false);
    });

    it.each([
      ["modified", `${AGENTS_MARKER_PREFIX}${"0".repeat(64)} -->\n# changed\n`],
      ["foreign", "# foreign workspace instructions\n"],
    ])(
      "interactive Yes removes an unchanged %s file",
      async (_kind, content) => {
        const fixture = await createAgentsWorkspace(
          `CONSENT-YES-${_kind.toUpperCase()}`,
        );
        writeFileSync(fixture.agentsPath, content);

        const exit = await runInteractiveWorkspaceRemove(
          fixture.ticket,
          removalPrompt("yes"),
        );

        expect(Exit.isSuccess(exit)).toBe(true);
        if (Exit.isSuccess(exit)) {
          expect(exit.value.exitCode ?? 0).toBe(0);
        }
        expect(existsSync(fixture.ticketDirectory)).toBe(false);
        expect(existsSync(fixture.manifestPath)).toBe(false);
      },
    );

    it.each([
      ["decline", "decline"],
      ["empty", "empty"],
      ["EOF", "eof"],
      ["SIGINT", "sigint"],
      ["question rejection", "rejection"],
    ] as const)(
      "%s leaves every workspace artifact and Git registration intact",
      async (_label, scenario) => {
        const ticket = `CANCEL-${scenario.toUpperCase()}`;
        const fixture = await createAgentsWorkspace(ticket);
        const agentsContent = "# foreign workspace instructions\n";
        writeFileSync(fixture.agentsPath, agentsContent);

        const exit = await runInteractiveWorkspaceRemove(
          ticket,
          removalPrompt(scenario),
        );

        expect(Exit.isFailure(exit)).toBe(true);
        await expectWorkspaceIntact(fixture, agentsContent);
      },
    );

    it("non-interactive removal refuses modified AGENTS.md before teardown", async () => {
      const fixture = await createAgentsWorkspace("NI-MOD-001");
      const agentsContent = `${AGENTS_MARKER_PREFIX}${"0".repeat(64)} -->\n# changed\n`;
      writeFileSync(fixture.agentsPath, agentsContent);

      expect(await runCli(["workspace", "remove", fixture.ticket])).toBe(1);
      await expectWorkspaceIntact(fixture, agentsContent);
    });

    it("JSON removal refuses foreign AGENTS.md before teardown", async () => {
      const fixture = await createAgentsWorkspace("NI-FOREIGN-001");
      const agentsContent = "# foreign workspace instructions\n";
      writeFileSync(fixture.agentsPath, agentsContent);

      expect(
        await runCli(["workspace", "remove", fixture.ticket, "--json"]),
      ).toBe(1);
      await expectWorkspaceIntact(fixture, agentsContent);
    });

    it("preserves a different correctly hashed file created after approval", async () => {
      const fixture = await createAgentsWorkspace("EXACT-APPROVAL-001");
      writeFileSync(fixture.agentsPath, "# approved foreign file\n");
      const replacement = managedAgentsContent("# replacement renderer\n");

      const exit = await runInteractiveWorkspaceRemove(
        fixture.ticket,
        removalPrompt("yes", () =>
          writeFileSync(fixture.agentsPath, replacement),
        ),
      );

      expect(Exit.isSuccess(exit)).toBe(true);
      if (Exit.isSuccess(exit)) {
        expect(exit.value.exitCode).toBe(1);
        expect(exit.value.data.status).toBe("partial");
        expect(exit.value.data.diagnostics).toContain(
          `AGENTS.md at ${fixture.agentsPath} changed after approval. Preserving file; manifest retained for retry.`,
        );
      }
      expect(readFileSync(fixture.agentsPath, "utf8")).toBe(replacement);
      expect(existsSync(fixture.manifestPath)).toBe(true);
      expect(existsSync(fixture.ticketDirectory)).toBe(true);
      expect(existsSync(fixture.worktreePath)).toBe(false);
    });

    it("deletes AGENTS.md before deleting the manifest", async () => {
      const fixture = await createAgentsWorkspace("ORDER-001");
      const removals: Array<string> = [];

      const exit = await Effect.runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const trackingFs = {
            ...fs,
            remove: (filePath: string, options?: FileSystem.RemoveOptions) => {
              if (
                filePath === fixture.agentsPath ||
                filePath === fixture.manifestPath
              ) {
                removals.push(filePath);
              }
              return fs.remove(filePath, options);
            },
          };

          return yield* Effect.exit(
            runWorkspaceRemove(fixture.ticket, [], {
              interactive: false,
            }).pipe(Effect.provideService(FileSystem.FileSystem, trackingFs)),
          );
        }).pipe(Effect.provide(NodeContext.layer)),
      );

      expect(Exit.isSuccess(exit)).toBe(true);
      expect(removals).toEqual([fixture.agentsPath, fixture.manifestPath]);
      expect(existsSync(fixture.ticketDirectory)).toBe(false);
      expect(existsSync(fixture.manifestPath)).toBe(false);
    });

    it("worktree cleanup failure preserves AGENTS.md and manifest", async () => {
      const fixture = await createAgentsWorkspace("WTCF-AGENT-001");
      const agentsContent = readFileSync(fixture.agentsPath, "utf8");
      await installFailingGitShim(fixture.tempHome, "worktree-remove");

      expect(await runCli(["workspace", "remove", fixture.ticket])).toBe(1);
      expect(readFileSync(fixture.agentsPath, "utf8")).toBe(agentsContent);
      expect(existsSync(fixture.manifestPath)).toBe(true);
      expect(existsSync(fixture.worktreePath)).toBe(true);
    });

    it("retains residual files and the manifest after approved AGENTS cleanup", async () => {
      const fixture = await createAgentsWorkspace("RESIDUAL-AGENT-001");
      const residualPath = path.join(fixture.ticketDirectory, "keep.txt");
      writeFileSync(residualPath, "keep\n");
      const infoSpy = vi
        .spyOn(console, "log")
        .mockImplementation(() => undefined);

      expect(await runCli(["workspace", "remove", fixture.ticket])).toBe(1);
      expect(infoSpy.mock.calls.map((call) => call[0]).join("\n")).toContain(
        "residual entries",
      );
      expect(readFileSync(residualPath, "utf8")).toBe("keep\n");
      expect(existsSync(fixture.agentsPath)).toBe(false);
      expect(existsSync(fixture.manifestPath)).toBe(true);
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

    it("prioritizes invalid ownership over an earlier missing worktree", async () => {
      const { execFileSync } = await import("node:child_process");
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
        "STATUS-PRIORITY",
        "--type",
        "feat",
        "--repo",
        localRepoId(alpha.tempRemote),
        "--repo",
        localRepoId(beta.tempRemote),
      ]);

      const registry = readRegistry(tempHome);
      const alphaRepo = registry.repos.find(
        (repo) => repo.id === localRepoId(alpha.tempRemote),
      ) as NonNullable<(typeof registry.repos)[number]>;
      const alphaWorktree = path.join(
        tempHome,
        "worktrees",
        "STATUS-PRIORITY",
        alphaRepo.name,
      );
      execFileSync(
        "git",
        [
          "--git-dir",
          alphaRepo.managedRepoPath,
          "worktree",
          "remove",
          alphaWorktree,
        ],
        { encoding: "utf8" },
      );

      const fakeManagedPath = path.join(tempHome, "repos", "fake.git");
      execFileSync("git", ["init", "--bare", fakeManagedPath]);

      const manifestPath = path.join(
        tempHome,
        "workspaces",
        "STATUS-PRIORITY.json",
      );
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      manifest.repositories[1].managedPath = path.relative(
        path.join(tempHome, "repos"),
        fakeManagedPath,
      );
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

      const infoSpy = vi
        .spyOn(console, "log")
        .mockImplementation(() => undefined);
      const exitCode = await runCli(["workspace", "list"]);
      const output = infoSpy.mock.calls.map((call) => call[0]).join("\n");

      expect(exitCode).toBe(0);
      expect(output).toContain("- STATUS-PRIORITY [invalid]");
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
      writeFileSync(path.join(unmanagedDir, "not-a-worktree.txt"), "keep\n");

      const infoSpy = vi
        .spyOn(console, "log")
        .mockImplementation(() => undefined);

      const exitCode = await runCli(["workspace", "list"]);
      expect(exitCode).toBe(0);

      const output = infoSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toContain("- UNMANAGED-123 [unmanaged]");
      expect(output).toContain("worktrees: 0");
      expect(output).toContain("directory contents are not treated");

      infoSpy.mockClear();
      const showExitCode = await runCli(["workspace", "show", "UNMANAGED-123"]);
      expect(showExitCode).toBe(0);
      const showOutput = infoSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(showOutput).toContain("status: unmanaged");
      expect(showOutput).toContain("worktrees: 0");
      expect(showOutput).not.toContain("not-a-worktree.txt");
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

      const lockPath = path.join(tempHome, "workspaces", ".lock-rel-123.lock");
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

      const lockPath = path.join(tempHome, "workspaces", ".lock-fail-123.lock");
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

      const registry = readRegistry(tempHome);
      const managedRepoPath = registry.repos[0].managedRepoPath;
      const reposRoot = path.join(tempHome, "repos");

      writeManifestFixture(
        tempHome,
        reposRoot,
        "NO-MANIFEST-123",
        "feat",
        "feat/NO-MANIFEST-123",
        [
          {
            id: registry.repos[0].id,
            name: registry.repos[0].name,
            base: "main",
            bareRepoPath: managedRepoPath,
          },
        ],
      );

      const { rmSync } = await import("node:fs");
      rmSync(path.join(tempHome, "workspaces", "NO-MANIFEST-123.json"));

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
