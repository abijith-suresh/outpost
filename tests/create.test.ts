import { describe, expect, it, vi } from "vitest";

import * as CreatePrompt from "../src/commands/create-prompt.ts";

import {
  commitFile,
  createManagedRepoFixture,
  currentBranch,
  currentCommit,
  existsSync,
  mkdirSync,
  path,
  pushBranch,
  restoreTtyProperty,
  runCli,
  localRepoId,
  setupAfterEach,
  createTempDir,
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
    mkdirSync(path.join(tempHome, "worktrees", "TICKET-321"), {
      recursive: true,
    });

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
      `A workspace already exists for ticket TICKET-321: ${path.join(tempHome, "worktrees", "TICKET-321")}\nRemove that workspace directory or choose a different ticket.`,
    );
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
});
