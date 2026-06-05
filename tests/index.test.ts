import { createRequire } from "node:module";
import os from "node:os";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../src/index.ts";
import * as CreatePrompt from "../src/commands/create-prompt.ts";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

const ORIGINAL_ENV = { ...process.env };

function sanitizeRemoteUrl(remoteUrl: string): string {
  return remoteUrl
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function makeRepoRecord(repo: {
  id: string;
  managedRepoPath: string;
  name?: string;
  remoteName?: string;
  remoteUrl?: string;
  sourceRepoPath?: string;
  importedAt?: string;
  lastFetchedAt?: string;
}) {
  return {
    id: repo.id,
    importedAt: repo.importedAt ?? "2026-01-01T00:00:00.000Z",
    lastFetchedAt: repo.lastFetchedAt ?? "2026-01-01T00:00:00.000Z",
    managedRepoPath: repo.managedRepoPath,
    name: repo.name ?? repo.id,
    remoteName: repo.remoteName ?? "origin",
    remoteUrl: repo.remoteUrl ?? `https://example.com/${repo.id}.git`,
    sourceRepoPath: repo.sourceRepoPath ?? `/tmp/${repo.id}`,
  };
}

async function initGitRepo(repoPath: string) {
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["init"], { cwd: repoPath });
}

async function initBareGitRepo(repoPath: string) {
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["init", "--bare", repoPath]);
}

async function addGitRemote(
  repoPath: string,
  remoteName: string,
  remotePath: string,
) {
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["remote", "add", remoteName, remotePath], {
    cwd: repoPath,
  });
}

async function configureGitIdentity(repoPath: string) {
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["config", "user.name", "Outpost Test"], {
    cwd: repoPath,
  });
  execFileSync("git", ["config", "user.email", "outpost@example.com"], {
    cwd: repoPath,
  });
}

async function commitFile(
  repoPath: string,
  fileName: string,
  contents: string,
  message: string,
) {
  const { execFileSync } = await import("node:child_process");
  writeFileSync(path.join(repoPath, fileName), contents);
  execFileSync("git", ["add", fileName], { cwd: repoPath });
  execFileSync("git", ["commit", "-m", message], { cwd: repoPath });
}

async function pushBranch(
  repoPath: string,
  remoteName: string,
  branchName: string,
  extraArgs: ReadonlyArray<string> = [],
) {
  const { execFileSync } = await import("node:child_process");
  execFileSync(
    "git",
    ["push", ...extraArgs, remoteName, `HEAD:refs/heads/${branchName}`],
    { cwd: repoPath },
  );
}

async function setBareRepoHead(repoPath: string, branchName: string) {
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["symbolic-ref", "HEAD", `refs/heads/${branchName}`], {
    cwd: repoPath,
  });
}

async function createManagedRepoFixture(options?: {
  defaultBranch?: string;
  repoName?: string;
}) {
  const timestamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const tempRepo = options?.repoName
    ? path.join(
        os.tmpdir(),
        `outpost-create-repo-${timestamp}`,
        options.repoName,
      )
    : path.join(os.tmpdir(), `outpost-create-repo-${timestamp}`);
  const tempRemote = path.join(
    os.tmpdir(),
    `outpost-create-remote-${timestamp}.git`,
  );
  const defaultBranch = options?.defaultBranch ?? "main";

  mkdirSync(tempRepo, { recursive: true });
  await initBareGitRepo(tempRemote);
  await initGitRepo(tempRepo);
  await configureGitIdentity(tempRepo);
  await addGitRemote(tempRepo, "origin", tempRemote);
  await commitFile(tempRepo, "README.md", `# ${timestamp}\n`, "initial");

  if (defaultBranch !== "master") {
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["branch", "-M", defaultBranch], { cwd: tempRepo });
  }

  await pushBranch(tempRepo, "origin", defaultBranch, ["-u"]);
  await setBareRepoHead(tempRemote, defaultBranch);

  return {
    defaultBranch,
    tempRemote,
    tempRepo,
  };
}

async function currentBranch(repoPath: string) {
  const { execFileSync } = await import("node:child_process");
  return execFileSync("git", ["branch", "--show-current"], {
    cwd: repoPath,
    encoding: "utf8",
  }).trim();
}

async function currentCommit(repoPath: string) {
  const { execFileSync } = await import("node:child_process");
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoPath,
    encoding: "utf8",
  }).trim();
}

function restoreTtyProperty(
  stream: NodeJS.ReadStream | NodeJS.WriteStream,
  descriptor: PropertyDescriptor | undefined,
) {
  if (descriptor) {
    Object.defineProperty(stream, "isTTY", descriptor);
    return;
  }

  Reflect.deleteProperty(stream, "isTTY");
}

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...ORIGINAL_ENV };
});

describe("run", () => {
  it("prints help with no arguments", async () => {
    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const exitCode = await runCli([]);

    expect(exitCode).toBe(0);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy.mock.calls[0]?.[0]).toContain("Usage:");
    expect(infoSpy.mock.calls[0]?.[0]).toContain(
      "repo add <path> [--remote <name>]",
    );
    expect(infoSpy.mock.calls[0]?.[0]).toContain("repo fetch --all [--json]");
  });

  it("prints the current version", async () => {
    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["--version"]);

    expect(exitCode).toBe(0);
    expect(infoSpy).toHaveBeenCalledWith(version);
  });

  it("prints the current version when --version follows repo list", async () => {
    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["repo", "list", "--version"]);

    expect(exitCode).toBe(0);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledWith(version);
  });

  it("prints the current version when --version precedes repo list", async () => {
    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["--version", "repo", "list"]);

    expect(exitCode).toBe(0);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledWith(version);
  });

  it("prints the current version instead of doctor json output", async () => {
    const tempHome = path.join(os.tmpdir(), `outpost-test-${Date.now()}`);
    process.env.OUTPOST_HOME = tempHome;

    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["doctor", "--json", "--version"]);

    expect(exitCode).toBe(0);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledWith(version);
  });

  it("prints help for a top-level --help flag", async () => {
    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["--help"]);

    expect(exitCode).toBe(0);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy.mock.calls[0]?.[0]).toContain("Usage:");
    expect(infoSpy.mock.calls[0]?.[0]).toContain("Global options:");
  });

  it("prints top-level help when repo add includes --help", async () => {
    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["repo", "add", "--help"]);

    expect(exitCode).toBe(0);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy.mock.calls[0]?.[0]).toContain("Usage:");
    expect(infoSpy.mock.calls[0]?.[0]).toContain(
      "repo add <path> [--remote <name>]",
    );
  });

  it("prints top-level help when repo list includes --help", async () => {
    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["repo", "list", "--help"]);

    expect(exitCode).toBe(0);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy.mock.calls[0]?.[0]).toContain("Usage:");
    expect(infoSpy.mock.calls[0]?.[0]).toContain("repo list [--json]");
  });

  it("prints top-level help when repo fetch includes --help", async () => {
    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["repo", "fetch", "--help"]);

    expect(exitCode).toBe(0);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy.mock.calls[0]?.[0]).toContain("Usage:");
    expect(infoSpy.mock.calls[0]?.[0]).toContain("repo fetch --all [--json]");
  });

  it("prints top-level help when doctor includes --help", async () => {
    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["doctor", "--help"]);

    expect(exitCode).toBe(0);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy.mock.calls[0]?.[0]).toContain("Usage:");
    expect(infoSpy.mock.calls[0]?.[0]).toContain("doctor [--json]");
  });

  it("prints help instead of json when repo add includes --json and --help", async () => {
    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["repo", "add", "--json", "--help"]);

    expect(exitCode).toBe(0);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy.mock.calls[0]?.[0]).toContain("Usage:");
    expect(infoSpy.mock.calls[0]?.[0]).not.toContain('"command":');
  });

  it("prints help when both --help and --version are present", async () => {
    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["--help", "--version"]);

    expect(exitCode).toBe(0);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy.mock.calls[0]?.[0]).toContain("Usage:");
    expect(infoSpy.mock.calls[0]?.[0]).toContain("Global options:");
    expect(infoSpy.mock.calls[0]?.[0]).not.toBe(version);
  });

  it("prints doctor output", async () => {
    const tempHome = path.join(os.tmpdir(), `outpost-test-${Date.now()}`);
    process.env.OUTPOST_HOME = tempHome;

    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["doctor"]);

    expect(exitCode).toBe(0);
    expect(infoSpy).toHaveBeenNthCalledWith(1, "outpost doctor");
    expect(infoSpy).toHaveBeenNthCalledWith(2, "status: not-initialized");
    expect(infoSpy).toHaveBeenNthCalledWith(
      3,
      `resolved outpost home: ${tempHome}`,
    );
    expect(infoSpy).toHaveBeenNthCalledWith(4, "initialized: false");
    expect(infoSpy).toHaveBeenNthCalledWith(5, "missing repos: 0");
  });

  it("prints doctor output as json", async () => {
    const tempHome = path.join(os.tmpdir(), `outpost-test-${Date.now()}`);
    process.env.OUTPOST_HOME = tempHome;

    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["doctor", "--json"]);

    expect(exitCode).toBe(0);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy.mock.calls[0]?.[0]).toContain('"command": "doctor"');
    expect(infoSpy.mock.calls[0]?.[0]).toContain('"status": "not-initialized"');
    expect(infoSpy.mock.calls[0]?.[0]).toContain('"initialized": false');
    expect(infoSpy.mock.calls[0]?.[0]).toContain('"missingRepoCount": 0');
    expect(infoSpy.mock.calls[0]?.[0]).toContain('"missingRepos": []');
    expect(infoSpy.mock.calls[0]?.[0]).toContain(
      `"outpostHome": "${tempHome}"`,
    );
  });

  it("prints initialized doctor output", async () => {
    const tempHome = path.join(os.tmpdir(), `outpost-test-${Date.now()}`);
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["doctor"]);

    expect(exitCode).toBe(0);
    expect(infoSpy).toHaveBeenNthCalledWith(1, "outpost doctor");
    expect(infoSpy).toHaveBeenNthCalledWith(2, "status: ok");
    expect(infoSpy).toHaveBeenNthCalledWith(
      3,
      `resolved outpost home: ${tempHome}`,
    );
    expect(infoSpy).toHaveBeenNthCalledWith(4, "initialized: true");
    expect(infoSpy).toHaveBeenNthCalledWith(5, "missing repos: 0");
    expect(infoSpy).toHaveBeenNthCalledWith(
      6,
      `config file path: ${path.join(tempHome, "config.json")}`,
    );
    expect(infoSpy).toHaveBeenNthCalledWith(
      7,
      `repo registry file path: ${path.join(tempHome, "repos.json")}`,
    );
    expect(infoSpy).toHaveBeenNthCalledWith(
      8,
      `repos root: ${path.join(tempHome, "repos")}`,
    );
    expect(infoSpy).toHaveBeenNthCalledWith(
      9,
      `worktrees root: ${path.join(tempHome, "worktrees")}`,
    );
    expect(infoSpy).toHaveBeenNthCalledWith(10, "repo count: 0");
  });

  it("prints degraded doctor output when managed repos are missing", async () => {
    const tempHome = path.join(os.tmpdir(), `outpost-test-${Date.now()}`);
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    const existingManagedRepoPath = path.join(tempHome, "repos", "alpha.git");
    const missingManagedRepoPath = path.join(tempHome, "repos", "beta.git");
    mkdirSync(existingManagedRepoPath, { recursive: true });

    writeFileSync(
      path.join(tempHome, "repos.json"),
      `${JSON.stringify(
        {
          version: 1,
          repos: [
            {
              id: "alpha",
              importedAt: "2026-01-01T00:00:00.000Z",
              lastFetchedAt: "2026-01-01T00:00:00.000Z",
              managedRepoPath: existingManagedRepoPath,
              name: "alpha",
              remoteName: "origin",
              remoteUrl: "https://example.com/alpha.git",
              sourceRepoPath: "/tmp/alpha",
            },
            {
              id: "beta",
              importedAt: "2026-01-02T00:00:00.000Z",
              lastFetchedAt: "2026-01-02T00:00:00.000Z",
              managedRepoPath: missingManagedRepoPath,
              name: "beta",
              remoteName: "origin",
              remoteUrl: "https://example.com/beta.git",
              sourceRepoPath: "/tmp/beta",
            },
          ],
        },
        null,
        2,
      )}\n`,
    );

    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["doctor"]);

    expect(exitCode).toBe(0);
    expect(infoSpy).toHaveBeenNthCalledWith(2, "status: degraded");
    expect(infoSpy).toHaveBeenNthCalledWith(5, "missing repos: 1");
    expect(infoSpy).toHaveBeenNthCalledWith(
      11,
      `missing managed repo: ${missingManagedRepoPath}`,
    );
  });

  it("prints degraded doctor output as json when managed repos are missing", async () => {
    const tempHome = path.join(os.tmpdir(), `outpost-test-${Date.now()}`);
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    const missingManagedRepoPath = path.join(tempHome, "repos", "missing.git");

    writeFileSync(
      path.join(tempHome, "repos.json"),
      `${JSON.stringify(
        {
          version: 1,
          repos: [
            {
              id: "missing",
              importedAt: "2026-01-01T00:00:00.000Z",
              lastFetchedAt: "2026-01-01T00:00:00.000Z",
              managedRepoPath: missingManagedRepoPath,
              name: "missing",
              remoteName: "origin",
              remoteUrl: "https://example.com/missing.git",
              sourceRepoPath: "/tmp/missing",
            },
          ],
        },
        null,
        2,
      )}\n`,
    );

    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["doctor", "--json"]);

    expect(exitCode).toBe(0);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy.mock.calls[0]?.[0]).toContain('"command": "doctor"');
    expect(infoSpy.mock.calls[0]?.[0]).toContain('"status": "degraded"');
    expect(infoSpy.mock.calls[0]?.[0]).toContain('"missingRepoCount": 1');
    expect(infoSpy.mock.calls[0]?.[0]).toContain(
      `"missingRepos": [\n      "${missingManagedRepoPath}"`,
    );
  });

  it("initializes outpost home and worktrees root", async () => {
    const tempHome = path.join(os.tmpdir(), `outpost-test-${Date.now()}`);
    process.env.OUTPOST_HOME = tempHome;

    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["init"]);

    expect(exitCode).toBe(0);
    expect(infoSpy).toHaveBeenNthCalledWith(1, "outpost init");
    expect(infoSpy).toHaveBeenNthCalledWith(2, `outpost home: ${tempHome}`);
    expect(infoSpy).toHaveBeenNthCalledWith(
      3,
      `repos root: ${path.join(tempHome, "repos")}`,
    );
    expect(infoSpy).toHaveBeenNthCalledWith(
      4,
      `worktrees root: ${path.join(tempHome, "worktrees")}`,
    );

    const registry = JSON.parse(
      readFileSync(path.join(tempHome, "repos.json"), "utf8"),
    ) as { version: number; repos: Array<unknown> };

    expect(registry).toEqual({ repos: [], version: 1 });
  });

  it("imports the current repo into the managed bare repo store", async () => {
    const tempHome = path.join(os.tmpdir(), `outpost-test-${Date.now()}`);
    const tempRepo = path.join(os.tmpdir(), `outpost-repo-${Date.now()}`);
    const tempRemote = path.join(
      os.tmpdir(),
      `outpost-remote-${Date.now()}.git`,
    );
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    const { mkdirSync } = await import("node:fs");
    mkdirSync(tempRepo, { recursive: true });

    await initBareGitRepo(tempRemote);
    await initGitRepo(tempRepo);
    await addGitRemote(tempRepo, "origin", tempRemote);

    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["repo", "add", tempRepo]);
    const expectedManagedRepoPath = path.join(
      tempHome,
      "repos",
      `${sanitizeRemoteUrl(tempRemote)}.git`,
    );

    expect(exitCode).toBe(0);
    expect(infoSpy).toHaveBeenNthCalledWith(1, "outpost repo add");
    expect(infoSpy).toHaveBeenNthCalledWith(2, `source repo path: ${tempRepo}`);
    expect(infoSpy).toHaveBeenNthCalledWith(3, "remote name: origin");
    expect(infoSpy).toHaveBeenNthCalledWith(4, `remote url: ${tempRemote}`);
    expect(infoSpy).toHaveBeenNthCalledWith(
      5,
      `repo name: ${path.basename(tempRepo)}`,
    );
    expect(infoSpy).toHaveBeenNthCalledWith(
      6,
      `managed repo path: ${expectedManagedRepoPath}`,
    );
    expect(infoSpy).toHaveBeenNthCalledWith(7, "action: cloned");
    expect(infoSpy).toHaveBeenNthCalledWith(8, "registry action: created");
    expect(infoSpy).toHaveBeenNthCalledWith(9, "ready: true");

    const registry = JSON.parse(
      readFileSync(path.join(tempHome, "repos.json"), "utf8"),
    ) as {
      version: number;
      repos: Array<{
        managedRepoPath: string;
        name: string;
        remoteName: string;
        remoteUrl: string;
        sourceRepoPath: string;
      }>;
    };

    expect(registry.version).toBe(1);
    expect(registry.repos).toHaveLength(1);
    expect(registry.repos[0]).toMatchObject({
      managedRepoPath: expectedManagedRepoPath,
      name: path.basename(tempRepo),
      remoteName: "origin",
      remoteUrl: tempRemote,
      sourceRepoPath: tempRepo,
    });
  });

  it("returns an error when repo add is run before init", async () => {
    const tempHome = path.join(os.tmpdir(), `outpost-test-${Date.now()}`);
    const tempRepo = path.join(os.tmpdir(), `outpost-repo-${Date.now()}`);
    process.env.OUTPOST_HOME = tempHome;

    const { mkdirSync } = await import("node:fs");
    mkdirSync(tempRepo, { recursive: true });

    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["repo", "add", tempRepo]);

    expect(exitCode).toBe(1);
    expect(errorSpy).toHaveBeenNthCalledWith(
      1,
      `Outpost is not initialized at ${tempHome}`,
    );
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("prints repo add output as json", async () => {
    const tempHome = path.join(os.tmpdir(), `outpost-test-${Date.now()}`);
    const tempRepo = path.join(os.tmpdir(), `outpost-repo-${Date.now()}`);
    const tempRemote = path.join(
      os.tmpdir(),
      `outpost-remote-${Date.now()}.git`,
    );
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    const { mkdirSync } = await import("node:fs");
    mkdirSync(tempRepo, { recursive: true });

    await initBareGitRepo(tempRemote);
    await initGitRepo(tempRepo);
    await addGitRemote(tempRepo, "origin", tempRemote);

    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["repo", "add", tempRepo, "--json"]);

    expect(exitCode).toBe(0);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy.mock.calls[0]?.[0]).toContain('"command": "repo add"');
    expect(infoSpy.mock.calls[0]?.[0]).toContain('"action": "cloned"');
    expect(infoSpy.mock.calls[0]?.[0]).toContain('"registryAction": "created"');
    expect(infoSpy.mock.calls[0]?.[0]).toContain('"ready": true');
  });

  it("prints repo list output", async () => {
    const tempHome = path.join(os.tmpdir(), `outpost-test-${Date.now()}`);
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    const managedRepoPathOne = path.join(tempHome, "repos", "alpha.git");
    const managedRepoPathTwo = path.join(tempHome, "repos", "beta.git");
    mkdirSync(managedRepoPathOne, { recursive: true });

    writeFileSync(
      path.join(tempHome, "repos.json"),
      `${JSON.stringify(
        {
          version: 1,
          repos: [
            {
              id: "alpha",
              importedAt: "2026-01-01T00:00:00.000Z",
              lastFetchedAt: "2026-01-01T00:00:00.000Z",
              managedRepoPath: managedRepoPathOne,
              name: "alpha",
              remoteName: "origin",
              remoteUrl: "https://example.com/alpha.git",
              sourceRepoPath: "/tmp/alpha",
            },
            {
              id: "beta",
              importedAt: "2026-01-02T00:00:00.000Z",
              lastFetchedAt: "2026-01-02T00:00:00.000Z",
              managedRepoPath: managedRepoPathTwo,
              name: "beta",
              remoteName: "origin",
              remoteUrl: "https://example.com/beta.git",
              sourceRepoPath: "/tmp/beta",
            },
          ],
        },
        null,
        2,
      )}\n`,
    );

    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["repo", "list"]);

    expect(exitCode).toBe(0);
    expect(infoSpy).toHaveBeenNthCalledWith(1, "outpost repo list");
    expect(infoSpy).toHaveBeenNthCalledWith(2, "repos: 2");
    expect(infoSpy).toHaveBeenNthCalledWith(3, "missing repos: 1");
    expect(infoSpy).toHaveBeenNthCalledWith(
      4,
      `- alpha (id: alpha) [ok]: ${managedRepoPathOne}`,
    );
    expect(infoSpy).toHaveBeenNthCalledWith(
      5,
      `- beta (id: beta) [missing]: ${managedRepoPathTwo}`,
    );
  });

  it("prints repo show output", async () => {
    const tempHome = path.join(os.tmpdir(), `outpost-test-${Date.now()}`);
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    const repoRecord = makeRepoRecord({
      id: "alpha",
      managedRepoPath: path.join(tempHome, "repos", "alpha.git"),
      importedAt: "2026-01-01T00:00:00.000Z",
      lastFetchedAt: "2026-01-02T00:00:00.000Z",
    });
    mkdirSync(repoRecord.managedRepoPath, { recursive: true });

    writeFileSync(
      path.join(tempHome, "repos.json"),
      `${JSON.stringify({ version: 1, repos: [repoRecord] }, null, 2)}\n`,
    );

    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["repo", "show", "alpha"]);

    expect(exitCode).toBe(0);
    expect(infoSpy).toHaveBeenNthCalledWith(1, "outpost repo show");
    expect(infoSpy).toHaveBeenNthCalledWith(2, "id: alpha");
    expect(infoSpy).toHaveBeenNthCalledWith(3, "name: alpha");
    expect(infoSpy).toHaveBeenNthCalledWith(4, "status: ok");
    expect(infoSpy).toHaveBeenNthCalledWith(
      5,
      `managed repo path: ${repoRecord.managedRepoPath}`,
    );
    expect(infoSpy).toHaveBeenNthCalledWith(
      6,
      `source repo path: ${repoRecord.sourceRepoPath}`,
    );
    expect(infoSpy).toHaveBeenNthCalledWith(
      7,
      `remote name: ${repoRecord.remoteName}`,
    );
    expect(infoSpy).toHaveBeenNthCalledWith(
      8,
      `remote url: ${repoRecord.remoteUrl}`,
    );
    expect(infoSpy).toHaveBeenNthCalledWith(
      9,
      `imported at: ${repoRecord.importedAt}`,
    );
    expect(infoSpy).toHaveBeenNthCalledWith(
      10,
      `last fetched at: ${repoRecord.lastFetchedAt}`,
    );
  });

  it("prints repo show output as json", async () => {
    const tempHome = path.join(os.tmpdir(), `outpost-test-${Date.now()}`);
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    const repoRecord = makeRepoRecord({
      id: "alpha",
      managedRepoPath: path.join(tempHome, "repos", "alpha.git"),
    });
    mkdirSync(repoRecord.managedRepoPath, { recursive: true });

    writeFileSync(
      path.join(tempHome, "repos.json"),
      `${JSON.stringify({ version: 1, repos: [repoRecord] }, null, 2)}\n`,
    );

    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["repo", "show", "alpha", "--json"]);

    expect(exitCode).toBe(0);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy.mock.calls[0]?.[0]).toContain('"command": "repo show"');
    expect(infoSpy.mock.calls[0]?.[0]).toContain('"id": "alpha"');
    expect(infoSpy.mock.calls[0]?.[0]).toContain('"status": "ok"');
    expect(infoSpy.mock.calls[0]?.[0]).toContain(
      `"managedRepoPath": "${repoRecord.managedRepoPath}"`,
    );
  });

  it("returns repo show status missing when managed repo is gone", async () => {
    const tempHome = path.join(os.tmpdir(), `outpost-test-${Date.now()}`);
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    const repoRecord = makeRepoRecord({
      id: "alpha",
      managedRepoPath: path.join(tempHome, "repos", "alpha.git"),
    });

    writeFileSync(
      path.join(tempHome, "repos.json"),
      `${JSON.stringify({ version: 1, repos: [repoRecord] }, null, 2)}\n`,
    );

    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["repo", "show", "alpha"]);

    expect(exitCode).toBe(0);
    expect(infoSpy).toHaveBeenNthCalledWith(4, "status: missing");
  });

  it("returns an error when repo show uses an unknown id", async () => {
    const tempHome = path.join(os.tmpdir(), `outpost-test-${Date.now()}`);
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["repo", "show", "missing"]);

    expect(exitCode).toBe(1);
    expect(errorSpy).toHaveBeenNthCalledWith(1, "Unknown repo id: missing");
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("returns an error when repo show is missing the id", async () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["repo", "show"]);

    expect(exitCode).toBe(1);
    expect(errorSpy).toHaveBeenNthCalledWith(
      1,
      "Usage: outpost repo show <id> [--json]",
    );
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("returns an error when repo show includes an extra positional argument", async () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["repo", "show", "alpha", "beta"]);

    expect(exitCode).toBe(1);
    expect(errorSpy).toHaveBeenNthCalledWith(
      1,
      "Usage: outpost repo show <id> [--json]",
    );
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("returns an error when repo show finds duplicate ids in the registry", async () => {
    const tempHome = path.join(os.tmpdir(), `outpost-test-${Date.now()}`);
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    const firstManagedRepoPath = path.join(tempHome, "repos", "alpha-one.git");
    const secondManagedRepoPath = path.join(tempHome, "repos", "alpha-two.git");

    writeFileSync(
      path.join(tempHome, "repos.json"),
      `${JSON.stringify(
        {
          version: 1,
          repos: [
            makeRepoRecord({
              id: "alpha",
              managedRepoPath: firstManagedRepoPath,
            }),
            makeRepoRecord({
              id: "alpha",
              managedRepoPath: secondManagedRepoPath,
              sourceRepoPath: "/tmp/alpha-two",
              remoteUrl: "https://example.com/alpha-two.git",
            }),
          ],
        },
        null,
        2,
      )}\n`,
    );

    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["repo", "show", "alpha"]);

    expect(exitCode).toBe(1);
    expect(errorSpy).toHaveBeenNthCalledWith(
      1,
      "Duplicate repo id in registry: alpha",
    );
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("prints repo list output as json", async () => {
    const tempHome = path.join(os.tmpdir(), `outpost-test-${Date.now()}`);
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    const repoRecord = {
      id: "alpha",
      importedAt: "2026-01-01T00:00:00.000Z",
      lastFetchedAt: "2026-01-01T00:00:00.000Z",
      managedRepoPath: path.join(tempHome, "repos", "alpha.git"),
      name: "alpha",
      remoteName: "origin",
      remoteUrl: "https://example.com/alpha.git",
      sourceRepoPath: "/tmp/alpha",
    };
    mkdirSync(repoRecord.managedRepoPath, { recursive: true });

    writeFileSync(
      path.join(tempHome, "repos.json"),
      `${JSON.stringify({ version: 1, repos: [repoRecord] }, null, 2)}\n`,
    );

    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["repo", "list", "--json"]);

    expect(exitCode).toBe(0);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy.mock.calls[0]?.[0]).toContain('"command": "repo list"');
    expect(infoSpy.mock.calls[0]?.[0]).toContain('"missingRepoCount": 0');
    expect(infoSpy.mock.calls[0]?.[0]).toContain('"repos": [');
    expect(infoSpy.mock.calls[0]?.[0]).toContain(`"id": "${repoRecord.id}"`);
    expect(infoSpy.mock.calls[0]?.[0]).toContain(
      `"managedRepoPath": "${repoRecord.managedRepoPath}"`,
    );
    expect(infoSpy.mock.calls[0]?.[0]).toContain('"status": "ok"');
  });

  it("succeeds when repo fetch --all runs against an empty registry", async () => {
    const tempHome = path.join(os.tmpdir(), `outpost-test-${Date.now()}`);
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["repo", "fetch", "--all"]);

    expect(exitCode).toBe(0);
    expect(infoSpy).toHaveBeenNthCalledWith(1, "outpost repo fetch");
    expect(infoSpy).toHaveBeenNthCalledWith(2, "repos: 0");
    expect(infoSpy).toHaveBeenNthCalledWith(3, "fetched: 0");
    expect(infoSpy).toHaveBeenNthCalledWith(4, "failed: 0");
  });

  it("updates lastFetchedAt for successful repo fetch --all", async () => {
    const tempHome = path.join(os.tmpdir(), `outpost-test-${Date.now()}`);
    const tempRepo = path.join(os.tmpdir(), `outpost-repo-${Date.now()}`);
    const tempRemote = path.join(
      os.tmpdir(),
      `outpost-remote-${Date.now()}.git`,
    );
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    mkdirSync(tempRepo, { recursive: true });

    await initBareGitRepo(tempRemote);
    await initGitRepo(tempRepo);
    await addGitRemote(tempRepo, "origin", tempRemote);
    await runCli(["repo", "add", tempRepo]);

    const registryPath = path.join(tempHome, "repos.json");
    const registry = JSON.parse(readFileSync(registryPath, "utf8")) as {
      version: number;
      repos: Array<ReturnType<typeof makeRepoRecord>>;
    };
    const previousLastFetchedAt = "2026-02-01T00:00:00.000Z";
    registry.repos[0] = {
      ...registry.repos[0],
      lastFetchedAt: previousLastFetchedAt,
    };
    writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);

    const exitCode = await runCli(["repo", "fetch", "--all"]);
    const nextRegistry = JSON.parse(readFileSync(registryPath, "utf8")) as {
      version: number;
      repos: Array<ReturnType<typeof makeRepoRecord>>;
    };

    expect(exitCode).toBe(0);
    expect(nextRegistry.repos[0]?.lastFetchedAt).not.toBe(
      previousLastFetchedAt,
    );
  });

  it("continues across repo fetch failures, reports both results, and exits 1", async () => {
    const tempHome = path.join(os.tmpdir(), `outpost-test-${Date.now()}`);
    const tempRepo = path.join(os.tmpdir(), `outpost-repo-${Date.now()}`);
    const tempRemote = path.join(
      os.tmpdir(),
      `outpost-remote-${Date.now()}.git`,
    );
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    mkdirSync(tempRepo, { recursive: true });

    await initBareGitRepo(tempRemote);
    await initGitRepo(tempRepo);
    await addGitRemote(tempRepo, "origin", tempRemote);
    await runCli(["repo", "add", tempRepo]);

    const invalidManagedRepoPath = path.join(tempHome, "repos", "broken.git");
    mkdirSync(invalidManagedRepoPath, { recursive: true });

    const registryPath = path.join(tempHome, "repos.json");
    const registry = JSON.parse(readFileSync(registryPath, "utf8")) as {
      version: number;
      repos: Array<ReturnType<typeof makeRepoRecord>>;
    };
    registry.repos.push(
      makeRepoRecord({
        id: "broken",
        managedRepoPath: invalidManagedRepoPath,
        sourceRepoPath: "/tmp/broken",
        remoteUrl: "https://example.com/broken.git",
      }),
    );
    writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);

    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["repo", "fetch", "--all"]);

    expect(exitCode).toBe(1);
    expect(infoSpy).toHaveBeenNthCalledWith(2, "repos: 2");
    expect(infoSpy).toHaveBeenNthCalledWith(3, "fetched: 1");
    expect(infoSpy).toHaveBeenNthCalledWith(4, "failed: 1");
    expect(
      infoSpy.mock.calls.some(
        (call) => call[0] === "- broken (id: broken) [failed]",
      ),
    ).toBe(true);
    expect(
      infoSpy.mock.calls.some((call) =>
        String(call[0]).startsWith("  error: "),
      ),
    ).toBe(true);
    expect(
      infoSpy.mock.calls.some((call) => String(call[0]).includes("[fetched]")),
    ).toBe(true);
  });

  it("prints repo fetch partial failure as json with counts, statuses, and errors", async () => {
    const tempHome = path.join(os.tmpdir(), `outpost-test-${Date.now()}`);
    const tempRepo = path.join(os.tmpdir(), `outpost-repo-${Date.now()}`);
    const tempRemote = path.join(
      os.tmpdir(),
      `outpost-remote-${Date.now()}.git`,
    );
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    mkdirSync(tempRepo, { recursive: true });

    await initBareGitRepo(tempRemote);
    await initGitRepo(tempRepo);
    await addGitRemote(tempRepo, "origin", tempRemote);
    await runCli(["repo", "add", tempRepo]);

    const invalidManagedRepoPath = path.join(
      tempHome,
      "repos",
      "broken-json.git",
    );
    mkdirSync(invalidManagedRepoPath, { recursive: true });

    const registryPath = path.join(tempHome, "repos.json");
    const registry = JSON.parse(readFileSync(registryPath, "utf8")) as {
      version: number;
      repos: Array<ReturnType<typeof makeRepoRecord>>;
    };
    registry.repos.push(
      makeRepoRecord({
        id: "broken-json",
        managedRepoPath: invalidManagedRepoPath,
        sourceRepoPath: "/tmp/broken-json",
        remoteUrl: "https://example.com/broken-json.git",
      }),
    );
    writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);

    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["repo", "fetch", "--all", "--json"]);
    const output = infoSpy.mock.calls[0]?.[0] as string;

    expect(exitCode).toBe(1);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(output).toContain('"command": "repo fetch"');
    expect(output).toContain('"repoCount": 2');
    expect(output).toContain('"fetchedCount": 1');
    expect(output).toContain('"failedCount": 1');
    expect(output).toContain('"fetchStatus": "fetched"');
    expect(output).toContain('"fetchStatus": "failed"');
    expect(output).toContain('"error":');
  });

  it("updates an existing registry record when repo add is rerun", async () => {
    const tempHome = path.join(os.tmpdir(), `outpost-test-${Date.now()}`);
    const tempRepo = path.join(os.tmpdir(), `outpost-repo-${Date.now()}`);
    const tempRemote = path.join(
      os.tmpdir(),
      `outpost-remote-${Date.now()}.git`,
    );
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    const { mkdirSync } = await import("node:fs");
    mkdirSync(tempRepo, { recursive: true });

    await initBareGitRepo(tempRemote);
    await initGitRepo(tempRepo);
    await addGitRemote(tempRepo, "origin", tempRemote);

    await runCli(["repo", "add", tempRepo]);

    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const secondExitCode = await runCli(["repo", "add", tempRepo]);

    expect(secondExitCode).toBe(0);
    expect(infoSpy).toHaveBeenNthCalledWith(7, "action: fetched");
    expect(infoSpy).toHaveBeenNthCalledWith(8, "registry action: updated");
    expect(infoSpy).toHaveBeenNthCalledWith(9, "ready: true");

    const registry = JSON.parse(
      readFileSync(path.join(tempHome, "repos.json"), "utf8"),
    ) as { version: number; repos: Array<unknown> };

    expect(registry.version).toBe(1);
    expect(registry.repos).toHaveLength(1);
  });

  it("imports a selected remote from a multi-remote repository", async () => {
    const tempHome = path.join(os.tmpdir(), `outpost-test-${Date.now()}`);
    const tempRepo = path.join(os.tmpdir(), `outpost-repo-${Date.now()}`);
    const tempOriginRemote = path.join(
      os.tmpdir(),
      `outpost-origin-remote-${Date.now()}.git`,
    );
    const tempUpstreamRemote = path.join(
      os.tmpdir(),
      `outpost-upstream-remote-${Date.now()}.git`,
    );
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    const { mkdirSync } = await import("node:fs");
    mkdirSync(tempRepo, { recursive: true });

    await initBareGitRepo(tempOriginRemote);
    await initBareGitRepo(tempUpstreamRemote);
    await initGitRepo(tempRepo);
    await addGitRemote(tempRepo, "origin", tempOriginRemote);
    await addGitRemote(tempRepo, "upstream", tempUpstreamRemote);

    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const exitCode = await runCli([
      "repo",
      "add",
      tempRepo,
      "--remote",
      "upstream",
    ]);
    const expectedManagedRepoPath = path.join(
      tempHome,
      "repos",
      `${sanitizeRemoteUrl(tempUpstreamRemote)}.git`,
    );

    expect(exitCode).toBe(0);
    expect(infoSpy).toHaveBeenNthCalledWith(3, "remote name: upstream");
    expect(infoSpy).toHaveBeenNthCalledWith(
      4,
      `remote url: ${tempUpstreamRemote}`,
    );
    expect(infoSpy).toHaveBeenNthCalledWith(
      6,
      `managed repo path: ${expectedManagedRepoPath}`,
    );

    const registry = JSON.parse(
      readFileSync(path.join(tempHome, "repos.json"), "utf8"),
    ) as {
      version: number;
      repos: Array<{
        managedRepoPath: string;
        remoteName: string;
        remoteUrl: string;
      }>;
    };

    expect(registry.version).toBe(1);
    expect(registry.repos).toHaveLength(1);
    expect(registry.repos[0]).toMatchObject({
      managedRepoPath: expectedManagedRepoPath,
      remoteName: "upstream",
      remoteUrl: tempUpstreamRemote,
    });
  });

  it("returns an error when a multi-remote repo add omits --remote", async () => {
    const tempHome = path.join(os.tmpdir(), `outpost-test-${Date.now()}`);
    const tempRepo = path.join(os.tmpdir(), `outpost-repo-${Date.now()}`);
    const tempOriginRemote = path.join(
      os.tmpdir(),
      `outpost-origin-remote-${Date.now()}.git`,
    );
    const tempUpstreamRemote = path.join(
      os.tmpdir(),
      `outpost-upstream-remote-${Date.now()}.git`,
    );
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    const { mkdirSync } = await import("node:fs");
    mkdirSync(tempRepo, { recursive: true });

    await initBareGitRepo(tempOriginRemote);
    await initBareGitRepo(tempUpstreamRemote);
    await initGitRepo(tempRepo);
    await addGitRemote(tempRepo, "origin", tempOriginRemote);
    await addGitRemote(tempRepo, "upstream", tempUpstreamRemote);

    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["repo", "add", tempRepo]);

    expect(exitCode).toBe(1);
    expect(errorSpy).toHaveBeenNthCalledWith(
      1,
      "Repository has multiple remotes (origin, upstream). Use --remote <name> to choose which remote to import.",
    );
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("returns an error when repo add receives an unknown remote name", async () => {
    const tempHome = path.join(os.tmpdir(), `outpost-test-${Date.now()}`);
    const tempRepo = path.join(os.tmpdir(), `outpost-repo-${Date.now()}`);
    const tempOriginRemote = path.join(
      os.tmpdir(),
      `outpost-origin-remote-${Date.now()}.git`,
    );
    const tempUpstreamRemote = path.join(
      os.tmpdir(),
      `outpost-upstream-remote-${Date.now()}.git`,
    );
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    const { mkdirSync } = await import("node:fs");
    mkdirSync(tempRepo, { recursive: true });

    await initBareGitRepo(tempOriginRemote);
    await initBareGitRepo(tempUpstreamRemote);
    await initGitRepo(tempRepo);
    await addGitRemote(tempRepo, "origin", tempOriginRemote);
    await addGitRemote(tempRepo, "upstream", tempUpstreamRemote);

    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const exitCode = await runCli([
      "repo",
      "add",
      tempRepo,
      "--remote",
      "missing",
    ]);

    expect(exitCode).toBe(1);
    expect(errorSpy).toHaveBeenNthCalledWith(
      1,
      "Unknown remote: missing. Available remotes: origin, upstream.",
    );
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("returns a usage error when repo add --remote is missing a value", async () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["repo", "add", "/tmp/repo", "--remote"]);

    expect(exitCode).toBe(1);
    expect(errorSpy).toHaveBeenNthCalledWith(
      1,
      "Usage: outpost repo add <path> [--remote <name>]\n--remote requires a value.",
    );
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("returns a usage error when repo add --remote is provided more than once", async () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const exitCode = await runCli([
      "repo",
      "add",
      "/tmp/repo",
      "--remote",
      "origin",
      "--remote",
      "upstream",
    ]);

    expect(exitCode).toBe(1);
    expect(errorSpy).toHaveBeenNthCalledWith(
      1,
      "Usage: outpost repo add <path> [--remote <name>]\n--remote may only be provided once.",
    );
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("returns a usage error when repo fetch omits --all", async () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["repo", "fetch"]);

    expect(exitCode).toBe(1);
    expect(errorSpy).toHaveBeenNthCalledWith(
      1,
      "Usage: outpost repo fetch --all [--json]",
    );
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("returns a usage error when repo fetch receives a repo id", async () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["repo", "fetch", "alpha"]);

    expect(exitCode).toBe(1);
    expect(errorSpy).toHaveBeenNthCalledWith(
      1,
      "Usage: outpost repo fetch --all [--json]",
    );
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("prints demo list output", async () => {
    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["demo", "list"]);

    expect(exitCode).toBe(0);
    expect(infoSpy).toHaveBeenNthCalledWith(1, "outpost demo list");
    expect(infoSpy).toHaveBeenNthCalledWith(
      2,
      "- workspace-bootstrap: Workspace bootstrap [ready]",
    );
    expect(infoSpy).toHaveBeenNthCalledWith(
      3,
      "- effect-foundation: Effect foundation [ready]",
    );
  });

  it("creates worktrees for repeated --repo selections", async () => {
    const tempHome = path.join(os.tmpdir(), `outpost-test-${Date.now()}`);
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
      sanitizeRemoteUrl(alpha.tempRemote),
      "--repo",
      sanitizeRemoteUrl(beta.tempRemote),
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
    const tempHome = path.join(os.tmpdir(), `outpost-test-${Date.now()}`);
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
      sanitizeRemoteUrl(alpha.tempRemote),
      "--repo",
      sanitizeRemoteUrl(beta.tempRemote),
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
    const tempHome = path.join(os.tmpdir(), `outpost-test-${Date.now()}`);
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
      sanitizeRemoteUrl(alpha.tempRemote),
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
    const tempHome = path.join(os.tmpdir(), `outpost-test-${Date.now()}`);
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
        repoIds: [sanitizeRemoteUrl(alpha.tempRemote)],
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
            id: sanitizeRemoteUrl(alpha.tempRemote),
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
    const tempHome = path.join(os.tmpdir(), `outpost-test-${Date.now()}`);
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
    const tempHome = path.join(os.tmpdir(), `outpost-test-${Date.now()}`);
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
        repoIds: [sanitizeRemoteUrl(alpha.tempRemote)],
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
            id: sanitizeRemoteUrl(alpha.tempRemote),
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
    const tempHome = path.join(os.tmpdir(), `outpost-test-${Date.now()}`);
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
      sanitizeRemoteUrl(alpha.tempRemote),
    ]);

    expect(exitCode).toBe(1);
    expect(errorSpy).toHaveBeenNthCalledWith(
      1,
      `A workspace already exists for ticket TICKET-321: ${path.join(tempHome, "worktrees", "TICKET-321")}\nRemove that workspace directory or choose a different ticket.`,
    );
  });

  it("creates the expected worktree path and branch layout", async () => {
    const tempHome = path.join(os.tmpdir(), `outpost-test-${Date.now()}`);
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
      sanitizeRemoteUrl(alpha.tempRemote),
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
    const tempHome = path.join(os.tmpdir(), `outpost-test-${Date.now()}`);
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
      sanitizeRemoteUrl(alpha.tempRemote),
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
    expect(output).toContain(
      `"repoId": "${sanitizeRemoteUrl(alpha.tempRemote)}"`,
    );
    expect(output).toContain(
      `"path": "${path.join(tempHome, "worktrees", "JSON-42", path.basename(alpha.tempRepo))}"`,
    );
    expect(output).toContain('"base": "main"');
    expect(output).toContain('"dryRun": false');
  });

  it("plans create worktrees without creating anything when --dry-run is used", async () => {
    const tempHome = path.join(os.tmpdir(), `outpost-test-${Date.now()}`);
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
      sanitizeRemoteUrl(alpha.tempRemote),
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
    const tempHome = path.join(os.tmpdir(), `outpost-test-${Date.now()}`);
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
      sanitizeRemoteUrl(alpha.tempRemote),
      "--dry-run",
      "--json",
    ]);
    const output = infoSpy.mock.calls[0]?.[0] as string;

    expect(exitCode).toBe(0);
    expect(output).toContain('"command": "create"');
    expect(output).toContain('"ticket": "DRY-JSON-202"');
    expect(output).toContain('"dryRun": true');
  });

  it("prints workspace show output", async () => {
    const tempHome = path.join(os.tmpdir(), `outpost-test-${Date.now()}`);
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
      sanitizeRemoteUrl(alpha.tempRemote),
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
    const tempHome = path.join(os.tmpdir(), `outpost-test-${Date.now()}`);
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
      sanitizeRemoteUrl(alpha.tempRemote),
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
    const tempHome = path.join(os.tmpdir(), `outpost-test-${Date.now()}`);
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
      sanitizeRemoteUrl(alpha.tempRemote),
    ]);
    await runCli([
      "create",
      "--ticket",
      "LIST-456",
      "--type",
      "feat",
      "--repo",
      sanitizeRemoteUrl(beta.tempRemote),
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
    const tempHome = path.join(os.tmpdir(), `outpost-test-${Date.now()}`);
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
      sanitizeRemoteUrl(alpha.tempRemote),
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
    const tempHome = path.join(os.tmpdir(), `outpost-test-${Date.now()}`);
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

  describe("repo remove", () => {
    it("removes a repo from the registry and deletes the managed repo", async () => {
      const tempHome = path.join(os.tmpdir(), `outpost-test-${Date.now()}`);
      process.env.OUTPOST_HOME = tempHome;

      await runCli(["init"]);

      const alpha = await createManagedRepoFixture({ defaultBranch: "main" });
      await runCli(["repo", "add", alpha.tempRepo]);

      const registryPath = path.join(tempHome, "repos.json");
      const registry = JSON.parse(readFileSync(registryPath, "utf8")) as {
        version: number;
        repos: Array<{
          id: string;
          name: string;
          managedRepoPath: string;
          remoteUrl: string;
          sourceRepoPath: string;
        }>;
      };
      const repoId = registry.repos[0].id;
      const name = registry.repos[0].name;
      const managedRepoPath = registry.repos[0].managedRepoPath;
      const remoteUrl = registry.repos[0].remoteUrl;
      const sourceRepoPath = registry.repos[0].sourceRepoPath;

      const infoSpy = vi
        .spyOn(console, "log")
        .mockImplementation(() => undefined);

      const exitCode = await runCli(["repo", "remove", repoId]);

      expect(exitCode).toBe(0);
      expect(infoSpy).toHaveBeenNthCalledWith(1, "outpost repo remove");
      expect(infoSpy).toHaveBeenNthCalledWith(2, `id: ${repoId}`);
      expect(infoSpy).toHaveBeenNthCalledWith(3, `name: ${name}`);
      expect(infoSpy).toHaveBeenNthCalledWith(
        4,
        `managed repo path: ${managedRepoPath}`,
      );
      expect(infoSpy).toHaveBeenNthCalledWith(5, `remote url: ${remoteUrl}`);
      expect(infoSpy).toHaveBeenNthCalledWith(
        6,
        `source repo path: ${sourceRepoPath}`,
      );

      const nextRegistry = JSON.parse(
        readFileSync(registryPath, "utf8"),
      ) as { version: number; repos: Array<unknown> };

      expect(nextRegistry.repos).toEqual([]);
      expect(existsSync(managedRepoPath)).toBe(false);
    });

    it("prints repo remove output as json", async () => {
      const tempHome = path.join(os.tmpdir(), `outpost-test-${Date.now()}`);
      process.env.OUTPOST_HOME = tempHome;

      await runCli(["init"]);

      const alpha = await createManagedRepoFixture({ defaultBranch: "main" });
      await runCli(["repo", "add", alpha.tempRepo]);

      const registryPath = path.join(tempHome, "repos.json");
      const registry = JSON.parse(readFileSync(registryPath, "utf8")) as {
        version: number;
        repos: Array<{
          id: string;
          managedRepoPath: string;
          remoteUrl: string;
          sourceRepoPath: string;
        }>;
      };
      const repoId = registry.repos[0].id;
      const managedRepoPath = registry.repos[0].managedRepoPath;
      const remoteUrl = registry.repos[0].remoteUrl;
      const sourceRepoPath = registry.repos[0].sourceRepoPath;

      const infoSpy = vi
        .spyOn(console, "log")
        .mockImplementation(() => undefined);

      const exitCode = await runCli(["repo", "remove", repoId, "--json"]);

      expect(exitCode).toBe(0);
      expect(infoSpy).toHaveBeenCalledTimes(1);
      const output = infoSpy.mock.calls[0]?.[0] as string;
      expect(output).toContain('"command": "repo remove"');
      expect(output).toContain(`"id": "${repoId}"`);
      expect(output).toContain(`"managedRepoPath": "${managedRepoPath}"`);
      expect(output).toContain(`"remoteUrl": "${remoteUrl}"`);
      expect(output).toContain(`"sourceRepoPath": "${sourceRepoPath}"`);
    });

    it("returns an error for unknown repo id", async () => {
      const tempHome = path.join(os.tmpdir(), `outpost-test-${Date.now()}`);
      process.env.OUTPOST_HOME = tempHome;

      await runCli(["init"]);

      const managedRepoPath = path.join(tempHome, "repos", "alpha.git");
      mkdirSync(managedRepoPath, { recursive: true });
      writeFileSync(
        path.join(tempHome, "repos.json"),
        `${JSON.stringify(
          {
            version: 1,
            repos: [
              makeRepoRecord({
                id: "alpha",
                managedRepoPath,
              }),
            ],
          },
          null,
          2,
        )}\n`,
      );

      const errorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);

      const exitCode = await runCli(["repo", "remove", "unknown-id"]);

      expect(exitCode).toBe(1);
      expect(errorSpy).toHaveBeenNthCalledWith(
        1,
        "Unknown repo id: unknown-id",
      );
    });

    it("returns an error when repo remove is missing the id", async () => {
      const tempHome = path.join(os.tmpdir(), `outpost-test-${Date.now()}`);
      process.env.OUTPOST_HOME = tempHome;

      await runCli(["init"]);

      const errorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);

      const exitCode = await runCli(["repo", "remove"]);

      expect(exitCode).toBe(1);
      expect(errorSpy).toHaveBeenNthCalledWith(
        1,
        "Usage: outpost repo remove <id>",
      );
    });

    it("returns an error when repo remove is run before init", async () => {
      const tempHome = path.join(os.tmpdir(), `outpost-test-${Date.now()}`);
      process.env.OUTPOST_HOME = tempHome;

      const errorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);

      const exitCode = await runCli(["repo", "remove", "alpha"]);

      expect(exitCode).toBe(1);
      expect(errorSpy).toHaveBeenNthCalledWith(
        1,
        `Outpost is not initialized at ${tempHome}`,
      );
    });
  });
});
