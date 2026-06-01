import { createRequire } from "node:module";
import os from "node:os";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../src/index.ts";

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
