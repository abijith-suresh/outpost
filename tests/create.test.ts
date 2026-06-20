import { describe, expect, it, vi } from "vitest";

import { Effect } from "effect";

import * as CreatePrompt from "../src/commands/create-prompt.ts";
import * as WorkspaceManifest from "../src/workspace-manifest.ts";

import {
  commitFile,
  createManagedRepoFixture,
  currentBranch,
  currentCommit,
  existsSync,
  mkdirSync,
  path,
  pushBranch,
  readFileSync,
  restoreTtyProperty,
  runCli,
  localRepoId,
  setupAfterEach,
  createTempDir,
  writeFileSync,
} from "./helpers.ts";

setupAfterEach();

describe("run", () => {
  it("creates worktrees for repeated --repo selections", async () => {
    const tempHome = createTempDir("outpost-test-");
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    const alpha = await createManagedRepoFixture({ defaultBranch: "main" });
    const beta = await createManagedRepoFixture({ defaultBranch: "develop" });

    await runCli(["repo", "add", alpha.tempRepo]);
    await runCli(["repo", "add", beta.tempRepo]);

    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const exitCode = await runCli([
      "create",
      "--ticket",
      "TICKET-123",
      "--type",
      "feat",
      "--repo",
      localRepoId(alpha.tempRemote),
      "--repo",
      localRepoId(beta.tempRemote),
    ]);
    const alphaPath = path.join(
      tempHome,
      "worktrees",
      "TICKET-123",
      path.basename(alpha.tempRepo),
    );
    const betaPath = path.join(
      tempHome,
      "worktrees",
      "TICKET-123",
      path.basename(beta.tempRepo),
    );

    expect(exitCode).toBe(0);
    expect(infoSpy).toHaveBeenNthCalledWith(1, "outpost create");
    expect(infoSpy).toHaveBeenNthCalledWith(2, "ticket: TICKET-123");
    expect(infoSpy).toHaveBeenNthCalledWith(3, "branch: feat/TICKET-123");
    expect(infoSpy).toHaveBeenNthCalledWith(
      4,
      `workspace directory: ${path.join(tempHome, "worktrees", "TICKET-123")}`,
    );
    expect(infoSpy).toHaveBeenNthCalledWith(5, "worktrees: 2");
    expect(existsSync(alphaPath)).toBe(true);
    expect(existsSync(betaPath)).toBe(true);
    expect(await currentBranch(alphaPath)).toBe("feat/TICKET-123");
    expect(await currentBranch(betaPath)).toBe("feat/TICKET-123");
  });

  it("uses an explicit --base override for all selected repos", async () => {
    const tempHome = createTempDir("outpost-test-");
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    const alpha = await createManagedRepoFixture({ defaultBranch: "main" });
    const beta = await createManagedRepoFixture({ defaultBranch: "main" });
    const { execFileSync } = await import("node:child_process");

    execFileSync("git", ["checkout", "-b", "release"], { cwd: alpha.tempRepo });
    await commitFile(alpha.tempRepo, "alpha.txt", "alpha\n", "release alpha");
    await pushBranch(alpha.tempRepo, "origin", "release");
    execFileSync("git", ["checkout", "main"], { cwd: alpha.tempRepo });

    execFileSync("git", ["checkout", "-b", "release"], { cwd: beta.tempRepo });
    await commitFile(beta.tempRepo, "beta.txt", "beta\n", "release beta");
    await pushBranch(beta.tempRepo, "origin", "release");
    execFileSync("git", ["checkout", "main"], { cwd: beta.tempRepo });

    await runCli(["repo", "add", alpha.tempRepo]);
    await runCli(["repo", "add", beta.tempRepo]);

    const exitCode = await runCli([
      "create",
      "--ticket",
      "TICKET-456",
      "--type",
      "fix",
      "--base",
      "release",
      "--repo",
      localRepoId(alpha.tempRemote),
      "--repo",
      localRepoId(beta.tempRemote),
    ]);
    const alphaPath = path.join(
      tempHome,
      "worktrees",
      "TICKET-456",
      path.basename(alpha.tempRepo),
    );
    const betaPath = path.join(
      tempHome,
      "worktrees",
      "TICKET-456",
      path.basename(beta.tempRepo),
    );

    expect(exitCode).toBe(0);
    expect(await currentCommit(alphaPath)).toBe(
      execFileSync("git", ["rev-parse", "origin/release"], {
        cwd: alpha.tempRepo,
        encoding: "utf8",
      }).trim(),
    );
    expect(await currentCommit(betaPath)).toBe(
      execFileSync("git", ["rev-parse", "origin/release"], {
        cwd: beta.tempRepo,
        encoding: "utf8",
      }).trim(),
    );
  });

  it("fails before creating anything when a repo id is unknown", async () => {
    const tempHome = createTempDir("outpost-test-");
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    const alpha = await createManagedRepoFixture({ defaultBranch: "main" });
    await runCli(["repo", "add", alpha.tempRepo]);

    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const exitCode = await runCli([
      "create",
      "--ticket",
      "TICKET-789",
      "--type",
      "feat",
      "--repo",
      localRepoId(alpha.tempRemote),
      "--repo",
      "missing",
    ]);

    expect(exitCode).toBe(1);
    expect(errorSpy).toHaveBeenNthCalledWith(1, "Unknown repo id: missing");
    expect(existsSync(path.join(tempHome, "worktrees", "TICKET-789"))).toBe(
      false,
    );
  });

  it("fails non-interactively when required create flags are missing", async () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["create", "--ticket", "TICKET-100"]);

    expect(exitCode).toBe(1);
    expect(errorSpy).toHaveBeenNthCalledWith(
      1,
      "Usage: outpost create --ticket <id> --type <branch-type> --repo <id> [--repo <id> ...] [--base <branch>] [--dry-run]\n--type is required.\nAt least one --repo is required.",
    );
  });

  it("rejects create ticket values with path separators", async () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const exitCode = await runCli([
      "create",
      "--ticket",
      "BAD/TICKET",
      "--type",
      "feat",
      "--repo",
      "alpha",
    ]);

    expect(exitCode).toBe(1);
    expect(errorSpy).toHaveBeenNthCalledWith(
      1,
      "--ticket may not contain path separators.",
    );
  });

  it("preserves git validation for traversal-only ticket values", async () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const exitCode = await runCli([
      "create",
      "--ticket",
      ".",
      "--type",
      "feat",
      "--repo",
      "alpha",
    ]);

    expect(exitCode).toBe(1);
    expect(errorSpy).toHaveBeenNthCalledWith(
      1,
      "Invalid create branch name: feat/.",
    );
  });

  it("rejects create branch names that are not valid git branches", async () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const exitCode = await runCli([
      "create",
      "--ticket",
      "VALID-123",
      "--type",
      "feat test",
      "--repo",
      "alpha",
    ]);

    expect(exitCode).toBe(1);
    expect(errorSpy).toHaveBeenNthCalledWith(
      1,
      "Invalid create branch name: feat test/VALID-123",
    );
  });

  it("prompts for all missing create inputs on an interactive tty", async () => {
    const tempHome = createTempDir("outpost-test-");
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    const alpha = await createManagedRepoFixture({ defaultBranch: "main" });
    await runCli(["repo", "add", alpha.tempRepo]);

    const stdinDescriptor = Object.getOwnPropertyDescriptor(
      process.stdin,
      "isTTY",
    );
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(
      process.stdout,
      "isTTY",
    );

    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: true,
    });

    const promptSpy = vi
      .spyOn(CreatePrompt, "promptForMissingCreateArgs")
      .mockResolvedValue({
        ticket: "PROMPT-123",
        type: "feat",
        repoIds: [localRepoId(alpha.tempRemote)],
      });

    try {
      const exitCode = await runCli(["create"]);
      const worktreePath = path.join(
        tempHome,
        "worktrees",
        "PROMPT-123",
        path.basename(alpha.tempRepo),
      );

      expect(exitCode).toBe(0);
      expect(promptSpy).toHaveBeenCalledTimes(1);
      expect(promptSpy).toHaveBeenCalledWith({
        ticket: undefined,
        type: undefined,
        repoIds: [],
        base: undefined,
        availableRepos: [
          {
            id: localRepoId(alpha.tempRemote),
            name: path.basename(alpha.tempRepo),
          },
        ],
      });
      expect(existsSync(worktreePath)).toBe(true);
      expect(await currentBranch(worktreePath)).toBe("feat/PROMPT-123");
    } finally {
      restoreTtyProperty(process.stdin, stdinDescriptor);
      restoreTtyProperty(process.stdout, stdoutDescriptor);
    }
  });

  it("fails clearly when interactive create has no repos to choose from", async () => {
    const tempHome = createTempDir("outpost-test-");
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    const stdinDescriptor = Object.getOwnPropertyDescriptor(
      process.stdin,
      "isTTY",
    );
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(
      process.stdout,
      "isTTY",
    );

    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: true,
    });

    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    try {
      const exitCode = await runCli(["create"]);

      expect(exitCode).toBe(1);
      expect(errorSpy).toHaveBeenNthCalledWith(
        1,
        "No repos are available. Run `outpost repo add <path>` first.",
      );
    } finally {
      restoreTtyProperty(process.stdin, stdinDescriptor);
      restoreTtyProperty(process.stdout, stdoutDescriptor);
    }
  });

  it("prompts only for missing create inputs on an interactive tty", async () => {
    const tempHome = createTempDir("outpost-test-");
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    const alpha = await createManagedRepoFixture({ defaultBranch: "main" });
    await runCli(["repo", "add", alpha.tempRepo]);

    const stdinDescriptor = Object.getOwnPropertyDescriptor(
      process.stdin,
      "isTTY",
    );
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(
      process.stdout,
      "isTTY",
    );

    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: true,
    });

    const promptSpy = vi
      .spyOn(CreatePrompt, "promptForMissingCreateArgs")
      .mockResolvedValue({
        ticket: "PARTIAL-456",
        type: "fix",
        repoIds: [localRepoId(alpha.tempRemote)],
      });

    try {
      const exitCode = await runCli(["create", "--ticket", "PARTIAL-456"]);
      const worktreePath = path.join(
        tempHome,
        "worktrees",
        "PARTIAL-456",
        path.basename(alpha.tempRepo),
      );

      expect(exitCode).toBe(0);
      expect(promptSpy).toHaveBeenCalledTimes(1);
      expect(promptSpy).toHaveBeenCalledWith({
        ticket: "PARTIAL-456",
        type: undefined,
        repoIds: [],
        base: undefined,
        availableRepos: [
          {
            id: localRepoId(alpha.tempRemote),
            name: path.basename(alpha.tempRepo),
          },
        ],
      });
      expect(existsSync(worktreePath)).toBe(true);
      expect(await currentBranch(worktreePath)).toBe("fix/PARTIAL-456");
    } finally {
      restoreTtyProperty(process.stdin, stdinDescriptor);
      restoreTtyProperty(process.stdout, stdoutDescriptor);
    }
  });

  it("rejects ticket with path separator during interactive prompt", async () => {
    const tempHome = createTempDir("outpost-test-");
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    const alpha = await createManagedRepoFixture({ defaultBranch: "main" });
    await runCli(["repo", "add", alpha.tempRepo]);

    const stdinDescriptor = Object.getOwnPropertyDescriptor(
      process.stdin,
      "isTTY",
    );
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(
      process.stdout,
      "isTTY",
    );

    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: true,
    });

    vi.spyOn(CreatePrompt, "promptForMissingCreateArgs").mockResolvedValue({
      ticket: "ticket/with/slash",
      type: "feat",
      repoIds: [localRepoId(alpha.tempRemote)],
    });

    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    try {
      const exitCode = await runCli(["create"]);

      expect(exitCode).toBe(1);
      expect(errorSpy).toHaveBeenNthCalledWith(
        1,
        "--ticket may not contain path separators.",
      );
    } finally {
      restoreTtyProperty(process.stdin, stdinDescriptor);
      restoreTtyProperty(process.stdout, stdoutDescriptor);
    }
  });

  it("rejects type with path separator during interactive prompt", async () => {
    const tempHome = createTempDir("outpost-test-");
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    const alpha = await createManagedRepoFixture({ defaultBranch: "main" });
    await runCli(["repo", "add", alpha.tempRepo]);

    const stdinDescriptor = Object.getOwnPropertyDescriptor(
      process.stdin,
      "isTTY",
    );
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(
      process.stdout,
      "isTTY",
    );

    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: true,
    });

    vi.spyOn(CreatePrompt, "promptForMissingCreateArgs").mockResolvedValue({
      ticket: "TICKET-456",
      type: "feat/something",
      repoIds: [localRepoId(alpha.tempRemote)],
    });

    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    try {
      const exitCode = await runCli(["create"]);

      expect(exitCode).toBe(1);
      expect(errorSpy).toHaveBeenNthCalledWith(
        1,
        "--type may not contain path separators.",
      );
    } finally {
      restoreTtyProperty(process.stdin, stdinDescriptor);
      restoreTtyProperty(process.stdout, stdoutDescriptor);
    }
  });

  it("rejects invalid branch names from an interactive prompt", async () => {
    const tempHome = createTempDir("outpost-test-");
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    const alpha = await createManagedRepoFixture({ defaultBranch: "main" });
    await runCli(["repo", "add", alpha.tempRepo]);

    const stdinDescriptor = Object.getOwnPropertyDescriptor(
      process.stdin,
      "isTTY",
    );
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(
      process.stdout,
      "isTTY",
    );

    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: true,
    });

    vi.spyOn(CreatePrompt, "promptForMissingCreateArgs").mockResolvedValue({
      ticket: "VALID-123",
      type: "feat test",
      repoIds: [localRepoId(alpha.tempRemote)],
    });

    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    try {
      const exitCode = await runCli(["create"]);

      expect(exitCode).toBe(1);
      expect(errorSpy).toHaveBeenNthCalledWith(
        1,
        "Invalid create branch name: feat test/VALID-123",
      );
    } finally {
      restoreTtyProperty(process.stdin, stdinDescriptor);
      restoreTtyProperty(process.stdout, stdoutDescriptor);
    }
  });

  it("accepts valid ticket and type without path separators", async () => {
    const tempHome = createTempDir("outpost-test-");
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    const alpha = await createManagedRepoFixture({ defaultBranch: "main" });
    await runCli(["repo", "add", alpha.tempRepo]);

    const stdinDescriptor = Object.getOwnPropertyDescriptor(
      process.stdin,
      "isTTY",
    );
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(
      process.stdout,
      "isTTY",
    );

    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: true,
    });

    vi.spyOn(CreatePrompt, "promptForMissingCreateArgs").mockResolvedValue({
      ticket: "VALID-123",
      type: "feat",
      repoIds: [localRepoId(alpha.tempRemote)],
    });

    try {
      const exitCode = await runCli(["create"]);
      const worktreePath = path.join(
        tempHome,
        "worktrees",
        "VALID-123",
        path.basename(alpha.tempRepo),
      );

      expect(exitCode).toBe(0);
      expect(existsSync(worktreePath)).toBe(true);
      expect(await currentBranch(worktreePath)).toBe("feat/VALID-123");
    } finally {
      restoreTtyProperty(process.stdin, stdinDescriptor);
      restoreTtyProperty(process.stdout, stdoutDescriptor);
    }
  });

  it("re-prompts for repo ids when interactive create input includes unknown repos", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const ask = vi
      .fn<(question: string) => Promise<string>>()
      .mockResolvedValueOnce("REPROMPT-789")
      .mockResolvedValueOnce("feat")
      .mockResolvedValueOnce("missing")
      .mockResolvedValueOnce("alpha");

    const result = await CreatePrompt.promptForMissingCreateArgs(
      {
        ticket: undefined,
        type: undefined,
        repoIds: [],
        base: undefined,
        availableRepos: [{ id: "alpha", name: "alpha" }],
      },
      { ask },
    );

    expect(result).toEqual({
      ticket: "REPROMPT-789",
      type: "feat",
      repoIds: ["alpha"],
      base: undefined,
    });
    expect(ask).toHaveBeenCalledTimes(4);
    expect(logSpy).toHaveBeenCalledWith("Unknown repo id: missing");
  });

  it("fails before creating anything when the ticket directory already exists", async () => {
    const tempHome = createTempDir("outpost-test-");
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    const alpha = await createManagedRepoFixture({ defaultBranch: "main" });
    await runCli(["repo", "add", alpha.tempRepo]);
    const ticketDirectory = path.join(tempHome, "worktrees", "TICKET-321");
    mkdirSync(ticketDirectory, {
      recursive: true,
    });
    const sentinelPath = path.join(ticketDirectory, "keep.txt");
    writeFileSync(sentinelPath, "keep\n");

    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const exitCode = await runCli([
      "create",
      "--ticket",
      "TICKET-321",
      "--type",
      "feat",
      "--repo",
      localRepoId(alpha.tempRemote),
    ]);

    expect(exitCode).toBe(1);
    expect(errorSpy).toHaveBeenNthCalledWith(
      1,
      `A workspace already exists for ticket TICKET-321: ${ticketDirectory}\nRemove that workspace directory or choose a different ticket.`,
    );
    expect(readFileSync(sentinelPath, "utf8")).toBe("keep\n");
  });

  it("creates the expected worktree path and branch layout", async () => {
    const tempHome = createTempDir("outpost-test-");
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    const alpha = await createManagedRepoFixture({ defaultBranch: "main" });
    await runCli(["repo", "add", alpha.tempRepo]);

    const exitCode = await runCli([
      "create",
      "--ticket",
      "ABC-999",
      "--type",
      "chore",
      "--repo",
      localRepoId(alpha.tempRemote),
    ]);
    const expectedPath = path.join(
      tempHome,
      "worktrees",
      "ABC-999",
      path.basename(alpha.tempRepo),
    );

    expect(exitCode).toBe(0);
    expect(existsSync(expectedPath)).toBe(true);
    expect(await currentBranch(expectedPath)).toBe("chore/ABC-999");
  });

  it("prints create output as json", async () => {
    const tempHome = createTempDir("outpost-test-");
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    const alpha = await createManagedRepoFixture({ defaultBranch: "main" });
    await runCli(["repo", "add", alpha.tempRepo]);

    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const exitCode = await runCli([
      "create",
      "--ticket",
      "JSON-42",
      "--type",
      "feat",
      "--repo",
      localRepoId(alpha.tempRemote),
      "--json",
    ]);
    const output = infoSpy.mock.calls[0]?.[0] as string;

    expect(exitCode).toBe(0);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(output).toContain('"command": "create"');
    expect(output).toContain('"ticket": "JSON-42"');
    expect(output).toContain('"branch": "feat/JSON-42"');
    expect(output).toContain(
      `"ticketDirectory": "${path.join(tempHome, "worktrees", "JSON-42")}"`,
    );
    expect(output).toContain(`"repoId": "${localRepoId(alpha.tempRemote)}"`);
    expect(output).toContain(
      `"path": "${path.join(tempHome, "worktrees", "JSON-42", path.basename(alpha.tempRepo))}"`,
    );
    expect(output).toContain('"base": "main"');
    expect(output).toContain('"dryRun": false');
  });

  it("plans create worktrees without creating anything when --dry-run is used", async () => {
    const tempHome = createTempDir("outpost-test-");
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    const alpha = await createManagedRepoFixture({ defaultBranch: "main" });
    await runCli(["repo", "add", alpha.tempRepo]);

    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const exitCode = await runCli([
      "create",
      "--ticket",
      "DRY-101",
      "--type",
      "feat",
      "--repo",
      localRepoId(alpha.tempRemote),
      "--dry-run",
    ]);
    const ticketDirectory = path.join(tempHome, "worktrees", "DRY-101");
    const worktreePath = path.join(
      ticketDirectory,
      path.basename(alpha.tempRepo),
    );

    expect(exitCode).toBe(0);
    expect(infoSpy).toHaveBeenNthCalledWith(4, "dry run: true");
    expect(existsSync(ticketDirectory)).toBe(false);
    expect(existsSync(worktreePath)).toBe(false);
  });

  it("prints create dry run output as json", async () => {
    const tempHome = createTempDir("outpost-test-");
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    const alpha = await createManagedRepoFixture({ defaultBranch: "main" });
    await runCli(["repo", "add", alpha.tempRepo]);

    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const exitCode = await runCli([
      "create",
      "--ticket",
      "DRY-JSON-202",
      "--type",
      "feat",
      "--repo",
      localRepoId(alpha.tempRemote),
      "--dry-run",
      "--json",
    ]);
    const output = infoSpy.mock.calls[0]?.[0] as string;

    expect(exitCode).toBe(0);
    expect(output).toContain('"command": "create"');
    expect(output).toContain('"ticket": "DRY-JSON-202"');
    expect(output).toContain('"dryRun": true');
  });

  it("writes a manifest after successful create", async () => {
    const tempHome = createTempDir("outpost-test-");
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    const alpha = await createManagedRepoFixture({ defaultBranch: "main" });
    await runCli(["repo", "add", alpha.tempRepo]);

    const exitCode = await runCli([
      "create",
      "--ticket",
      "MANIFEST-1",
      "--type",
      "feat",
      "--repo",
      localRepoId(alpha.tempRemote),
    ]);

    expect(exitCode).toBe(0);

    const manifestPath = path.join(tempHome, "workspaces", "MANIFEST-1.json");
    expect(existsSync(manifestPath)).toBe(true);

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(manifest.ticket).toBe("MANIFEST-1");
    expect(manifest.type).toBe("feat");
    expect(manifest.branch).toBe("feat/MANIFEST-1");
    expect(manifest.workspacePath).toBe("MANIFEST-1");
    expect(manifest.createdAt).toBeTruthy();
    expect(Array.isArray(manifest.repositories)).toBe(true);
    expect(manifest.repositories.length).toBe(1);

    const repo = manifest.repositories[0];
    expect(repo.id).toBe(localRepoId(alpha.tempRemote));
    expect(repo.name).toBe(path.basename(alpha.tempRepo));
    expect(repo.base).toBe("main");
    expect(repo.managedPath).toBeTruthy();
    expect(repo.worktreePath).toBe(path.basename(alpha.tempRepo));
  });

  it("stores only relative paths in the manifest", async () => {
    const tempHome = createTempDir("outpost-test-");
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    const alpha = await createManagedRepoFixture({ defaultBranch: "main" });
    await runCli(["repo", "add", alpha.tempRepo]);

    const exitCode = await runCli([
      "create",
      "--ticket",
      "REL-1",
      "--type",
      "fix",
      "--repo",
      localRepoId(alpha.tempRemote),
    ]);

    expect(exitCode).toBe(0);

    const manifestPath = path.join(tempHome, "workspaces", "REL-1.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

    expect(path.isAbsolute(manifest.workspacePath)).toBe(false);

    for (const repo of manifest.repositories) {
      expect(path.isAbsolute(repo.managedPath)).toBe(false);
      expect(path.isAbsolute(repo.worktreePath)).toBe(false);
    }
  });

  it("dry-run writes nothing to disk", async () => {
    const tempHome = createTempDir("outpost-test-");
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    const alpha = await createManagedRepoFixture({ defaultBranch: "main" });
    await runCli(["repo", "add", alpha.tempRepo]);

    const exitCode = await runCli([
      "create",
      "--ticket",
      "DRY-NOTHING",
      "--type",
      "feat",
      "--repo",
      localRepoId(alpha.tempRemote),
      "--dry-run",
    ]);

    expect(exitCode).toBe(0);

    const manifestPath = path.join(tempHome, "workspaces", "DRY-NOTHING.json");
    const ticketDir = path.join(tempHome, "worktrees", "DRY-NOTHING");
    const lockPath = path.join(tempHome, "workspaces", ".dry-nothing.lock");

    expect(existsSync(manifestPath)).toBe(false);
    expect(existsSync(ticketDir)).toBe(false);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("rolls back worktrees and branches when manifest write fails", async () => {
    const tempHome = createTempDir("outpost-test-");
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    const alpha = await createManagedRepoFixture({ defaultBranch: "main" });
    const beta = await createManagedRepoFixture({ defaultBranch: "main" });
    await runCli(["repo", "add", alpha.tempRepo]);
    await runCli(["repo", "add", beta.tempRepo]);

    vi.spyOn(WorkspaceManifest, "writeManifest").mockImplementation(() => {
      return Effect.fail(
        new WorkspaceManifest.ManifestError({
          message: "Simulated manifest write failure",
        }),
      );
    });

    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const exitCode = await runCli([
      "create",
      "--ticket",
      "ROLLBACK-1",
      "--type",
      "feat",
      "--repo",
      localRepoId(alpha.tempRemote),
      "--repo",
      localRepoId(beta.tempRemote),
    ]);

    expect(exitCode).toBe(1);

    const manifestPath = path.join(tempHome, "workspaces", "ROLLBACK-1.json");
    const lockPath = path.join(tempHome, "workspaces", ".rollback-1.lock");

    expect(existsSync(manifestPath)).toBe(false);
    expect(existsSync(lockPath)).toBe(false);

    const { execFileSync } = await import("node:child_process");
    const branchExists = (managedPath: string, branch: string) => {
      try {
        execFileSync("git", [
          "--git-dir",
          managedPath,
          "show-ref",
          "--verify",
          "--quiet",
          `refs/heads/${branch}`,
        ]);
        return true;
      } catch {
        return false;
      }
    };

    const registry = JSON.parse(
      readFileSync(path.join(tempHome, "repos.json"), "utf8"),
    );
    const alphaManaged = registry.repos.find(
      (r: { id: string }) => r.id === localRepoId(alpha.tempRemote),
    );
    const betaManaged = registry.repos.find(
      (r: { id: string }) => r.id === localRepoId(beta.tempRemote),
    );

    if (alphaManaged) {
      expect(
        branchExists(alphaManaged.managedRepoPath, "feat/ROLLBACK-1"),
      ).toBe(false);
    }
    if (betaManaged) {
      expect(branchExists(betaManaged.managedRepoPath, "feat/ROLLBACK-1")).toBe(
        false,
      );
    }
  });

  it("reports original error when manifest write fails", async () => {
    const tempHome = createTempDir("outpost-test-");
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    const alpha = await createManagedRepoFixture({ defaultBranch: "main" });
    await runCli(["repo", "add", alpha.tempRepo]);

    vi.spyOn(WorkspaceManifest, "writeManifest").mockImplementation(() => {
      return Effect.fail(
        new WorkspaceManifest.ManifestError({
          message: "Simulated manifest write failure",
        }),
      );
    });

    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const exitCode = await runCli([
      "create",
      "--ticket",
      "ROLLBACK-DIAG",
      "--type",
      "fix",
      "--repo",
      localRepoId(alpha.tempRemote),
    ]);

    expect(exitCode).toBe(1);

    const errorOutput = errorSpy.mock.calls.map((call) => call[0]).join("\n");

    expect(errorOutput).toContain("Simulated manifest write failure");
  });

  it("preserves residual files created during a failed create rollback", async () => {
    const tempHome = createTempDir("outpost-test-");
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    const alpha = await createManagedRepoFixture({ defaultBranch: "main" });
    await runCli(["repo", "add", alpha.tempRepo]);

    const ticketDirectory = path.join(
      tempHome,
      "worktrees",
      "ROLLBACK-RESIDUAL",
    );
    const sentinelPath = path.join(ticketDirectory, "keep.txt");

    vi.spyOn(WorkspaceManifest, "writeManifest").mockImplementation(() => {
      writeFileSync(sentinelPath, "keep\n");
      return Effect.fail(
        new WorkspaceManifest.ManifestError({
          message: "Simulated manifest write failure",
        }),
      );
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const exitCode = await runCli([
      "create",
      "--ticket",
      "ROLLBACK-RESIDUAL",
      "--type",
      "feat",
      "--repo",
      localRepoId(alpha.tempRemote),
    ]);

    expect(exitCode).toBe(1);
    expect(readFileSync(sentinelPath, "utf8")).toBe("keep\n");
    expect(
      existsSync(path.join(ticketDirectory, path.basename(alpha.tempRepo))),
    ).toBe(false);
  });

  it("rejects concurrent create for the same ticket", async () => {
    const tempHome = createTempDir("outpost-test-");
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    const alpha = await createManagedRepoFixture({ defaultBranch: "main" });
    await runCli(["repo", "add", alpha.tempRepo]);

    const createPromise1 = runCli([
      "create",
      "--ticket",
      "CONCURRENT",
      "--type",
      "feat",
      "--repo",
      localRepoId(alpha.tempRemote),
    ]);

    const createPromise2 = runCli([
      "create",
      "--ticket",
      "CONCURRENT",
      "--type",
      "fix",
      "--repo",
      localRepoId(alpha.tempRemote),
    ]);

    const [exitCode1, exitCode2] = await Promise.all([
      createPromise1,
      createPromise2,
    ]);

    const successCodes = [exitCode1, exitCode2].filter((c) => c === 0);
    const failCodes = [exitCode1, exitCode2].filter((c) => c === 1);

    expect(successCodes.length).toBe(1);
    expect(failCodes.length).toBe(1);

    const manifestPath = path.join(tempHome, "workspaces", "CONCURRENT.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const worktreePath = path.join(
      tempHome,
      "worktrees",
      "CONCURRENT",
      path.basename(alpha.tempRepo),
    );

    expect(existsSync(worktreePath)).toBe(true);
    expect(await currentBranch(worktreePath)).toBe(manifest.branch);
  });

  it("serializes concurrent portable ticket aliases", async () => {
    const tempHome = createTempDir("outpost-test-");
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    const alpha = await createManagedRepoFixture({ defaultBranch: "main" });
    await runCli(["repo", "add", alpha.tempRepo]);

    const [upperExitCode, lowerExitCode] = await Promise.all([
      runCli([
        "create",
        "--ticket",
        "PORTABLE-ALIAS",
        "--type",
        "feat",
        "--repo",
        localRepoId(alpha.tempRemote),
      ]),
      runCli([
        "create",
        "--ticket",
        "portable-alias",
        "--type",
        "fix",
        "--repo",
        localRepoId(alpha.tempRemote),
      ]),
    ]);

    expect([upperExitCode, lowerExitCode].sort()).toEqual([0, 1]);

    const manifests = ["PORTABLE-ALIAS", "portable-alias"].filter((ticket) =>
      existsSync(path.join(tempHome, "workspaces", `${ticket}.json`)),
    );
    expect(manifests).toHaveLength(1);

    const winningTicket = manifests[0];
    const worktreePath = path.join(
      tempHome,
      "worktrees",
      winningTicket,
      path.basename(alpha.tempRepo),
    );
    expect(existsSync(worktreePath)).toBe(true);
  });

  it("reports clear diagnostic when a lock exists for the ticket", async () => {
    const tempHome = createTempDir("outpost-test-");
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    const alpha = await createManagedRepoFixture({ defaultBranch: "main" });
    await runCli(["repo", "add", alpha.tempRepo]);

    const workspacesDir = path.join(tempHome, "workspaces");
    mkdirSync(workspacesDir, { recursive: true });
    const lockPath = path.join(workspacesDir, ".stale-lock.lock");
    writeFileSync(lockPath, "", { flag: "wx" });

    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const exitCode = await runCli([
      "create",
      "--ticket",
      "STALE-LOCK",
      "--type",
      "feat",
      "--repo",
      localRepoId(alpha.tempRemote),
    ]);

    expect(exitCode).toBe(1);
    expect(errorSpy.mock.calls[0]?.[0]).toContain(
      "is locked by another operation",
    );
  });

  it("rejects create when a manifest already exists for the ticket", async () => {
    const tempHome = createTempDir("outpost-test-");
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    const alpha = await createManagedRepoFixture({ defaultBranch: "main" });
    await runCli(["repo", "add", alpha.tempRepo]);

    await runCli([
      "create",
      "--ticket",
      "EXISTING-MANIFEST",
      "--type",
      "feat",
      "--repo",
      localRepoId(alpha.tempRemote),
    ]);

    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const exitCode = await runCli([
      "create",
      "--ticket",
      "EXISTING-MANIFEST",
      "--type",
      "fix",
      "--repo",
      localRepoId(alpha.tempRemote),
    ]);

    expect(exitCode).toBe(1);
    expect(errorSpy.mock.calls[0]?.[0]).toContain(
      "workspace manifest already exists",
    );
  });

  it("rejects create when a portable ticket collision exists in manifests", async () => {
    const tempHome = createTempDir("outpost-test-");
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    const alpha = await createManagedRepoFixture({ defaultBranch: "main" });
    await runCli(["repo", "add", alpha.tempRepo]);

    await runCli([
      "create",
      "--ticket",
      "case-ticket",
      "--type",
      "feat",
      "--repo",
      localRepoId(alpha.tempRemote),
    ]);

    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const exitCode = await runCli([
      "create",
      "--ticket",
      "CASE-TICKET",
      "--type",
      "fix",
      "--repo",
      localRepoId(alpha.tempRemote),
    ]);

    expect(exitCode).toBe(1);
    expect(errorSpy.mock.calls[0]?.[0]).toContain("Ticket identity collision");
  });

  it("rejects create when the target branch already exists", async () => {
    const tempHome = createTempDir("outpost-test-");
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    const alpha = await createManagedRepoFixture({ defaultBranch: "main" });
    await runCli(["repo", "add", alpha.tempRepo]);

    const { execFileSync } = await import("node:child_process");
    const registry = JSON.parse(
      readFileSync(path.join(tempHome, "repos.json"), "utf8"),
    );
    const managedRepo = registry.repos.find(
      (r: { id: string }) => r.id === localRepoId(alpha.tempRemote),
    );

    execFileSync("git", [
      "--git-dir",
      managedRepo.managedRepoPath,
      "branch",
      "feat/BRANCH-EXISTS",
      "HEAD",
    ]);

    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const exitCode = await runCli([
      "create",
      "--ticket",
      "BRANCH-EXISTS",
      "--type",
      "feat",
      "--repo",
      localRepoId(alpha.tempRemote),
    ]);

    expect(exitCode).toBe(1);
    expect(errorSpy.mock.calls[0]?.[0]).toContain("already exists for repo");
  });

  it("rejects repos whose worktree names have a real case collision", async () => {
    const tempHome = createTempDir("outpost-test-");
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    const alpha = await createManagedRepoFixture({
      defaultBranch: "main",
      repoName: "CaseRepo",
    });
    const beta = await createManagedRepoFixture({
      defaultBranch: "main",
      repoName: "caserepo",
    });
    await runCli(["repo", "add", alpha.tempRepo]);
    await runCli(["repo", "add", beta.tempRepo]);

    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const exitCode = await runCli([
      "create",
      "--ticket",
      "WORKTREE-CASE-COLLISION",
      "--type",
      "feat",
      "--repo",
      localRepoId(alpha.tempRemote),
      "--repo",
      localRepoId(beta.tempRemote),
    ]);

    expect(exitCode).toBe(1);
    expect(errorSpy.mock.calls[0]?.[0]).toContain(
      "same portable worktree path",
    );
    expect(
      existsSync(path.join(tempHome, "worktrees", "WORKTREE-CASE-COLLISION")),
    ).toBe(false);
  });

  it("writes AGENTS.md to workspace directory on create", async () => {
    const tempHome = createTempDir("outpost-test-");
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    const alpha = await createManagedRepoFixture({ defaultBranch: "main" });
    await runCli(["repo", "add", alpha.tempRepo]);

    const exitCode = await runCli([
      "create",
      "--ticket",
      "AGENTS-1",
      "--type",
      "feat",
      "--repo",
      localRepoId(alpha.tempRemote),
    ]);

    expect(exitCode).toBe(0);

    const ticketDirectory = path.join(tempHome, "worktrees", "AGENTS-1");
    const agentsPath = path.join(ticketDirectory, "AGENTS.md");
    expect(existsSync(agentsPath)).toBe(true);

    const content = readFileSync(agentsPath, "utf8");
    expect(content.startsWith("<!-- outpost:workspace-agents sha256=")).toBe(
      true,
    );
  });

  it("AGENTS.md is written before the manifest", async () => {
    const tempHome = createTempDir("outpost-test-");
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    const alpha = await createManagedRepoFixture({ defaultBranch: "main" });
    await runCli(["repo", "add", alpha.tempRepo]);

    const exitCode = await runCli([
      "create",
      "--ticket",
      "AGENTS-BEFORE",
      "--type",
      "fix",
      "--repo",
      localRepoId(alpha.tempRemote),
    ]);

    expect(exitCode).toBe(0);

    const ticketDirectory = path.join(tempHome, "worktrees", "AGENTS-BEFORE");
    const agentsPath = path.join(ticketDirectory, "AGENTS.md");
    const content = readFileSync(agentsPath, "utf8");

    expect(content).toContain("AGENTS-BEFORE");
    expect(content).toContain(path.basename(alpha.tempRepo));
    expect(content.startsWith("<!-- outpost:workspace-agents sha256=")).toBe(
      true,
    );

    const manifestPath = path.join(
      tempHome,
      "workspaces",
      "AGENTS-BEFORE.json",
    );
    expect(existsSync(manifestPath)).toBe(true);
  });

  it("dry-run does not create AGENTS.md", async () => {
    const tempHome = createTempDir("outpost-test-");
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    const alpha = await createManagedRepoFixture({ defaultBranch: "main" });
    await runCli(["repo", "add", alpha.tempRepo]);

    const exitCode = await runCli([
      "create",
      "--ticket",
      "DRY-AGENTS",
      "--type",
      "feat",
      "--repo",
      localRepoId(alpha.tempRemote),
      "--dry-run",
    ]);

    expect(exitCode).toBe(0);

    const ticketDirectory = path.join(tempHome, "worktrees", "DRY-AGENTS");
    const agentsPath = path.join(ticketDirectory, "AGENTS.md");
    expect(existsSync(agentsPath)).toBe(false);
  });

  it("rollback deletes AGENTS.md when manifest write fails", async () => {
    const tempHome = createTempDir("outpost-test-");
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    const alpha = await createManagedRepoFixture({ defaultBranch: "main" });
    await runCli(["repo", "add", alpha.tempRepo]);

    vi.spyOn(WorkspaceManifest, "writeManifest").mockImplementation(() => {
      return Effect.fail(
        new WorkspaceManifest.ManifestError({
          message: "Simulated manifest write failure",
        }),
      );
    });

    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const exitCode = await runCli([
      "create",
      "--ticket",
      "ROLLBACK-AGENTS",
      "--type",
      "feat",
      "--repo",
      localRepoId(alpha.tempRemote),
    ]);

    expect(exitCode).toBe(1);

    const ticketDirectory = path.join(tempHome, "worktrees", "ROLLBACK-AGENTS");
    const agentsPath = path.join(ticketDirectory, "AGENTS.md");
    expect(existsSync(agentsPath)).toBe(false);
  });

  it("rollback preserves residual files and removes AGENTS.md", async () => {
    const tempHome = createTempDir("outpost-test-");
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    const alpha = await createManagedRepoFixture({ defaultBranch: "main" });
    await runCli(["repo", "add", alpha.tempRepo]);

    const ticketDirectory = path.join(
      tempHome,
      "worktrees",
      "ROLLBACK-RESIDUAL-AGENTS",
    );
    const sentinelPath = path.join(ticketDirectory, "keep.txt");

    vi.spyOn(WorkspaceManifest, "writeManifest").mockImplementation(() => {
      writeFileSync(sentinelPath, "keep\n");
      return Effect.fail(
        new WorkspaceManifest.ManifestError({
          message: "Simulated manifest write failure",
        }),
      );
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const exitCode = await runCli([
      "create",
      "--ticket",
      "ROLLBACK-RESIDUAL-AGENTS",
      "--type",
      "feat",
      "--repo",
      localRepoId(alpha.tempRemote),
    ]);

    expect(exitCode).toBe(1);
    expect(readFileSync(sentinelPath, "utf8")).toBe("keep\n");

    const agentsPath = path.join(ticketDirectory, "AGENTS.md");
    expect(existsSync(agentsPath)).toBe(false);

    expect(
      existsSync(path.join(ticketDirectory, path.basename(alpha.tempRepo))),
    ).toBe(false);
  });
});
