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
  });

  it("prints the current version", async () => {
    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["--version"]);

    expect(exitCode).toBe(0);
    expect(infoSpy).toHaveBeenCalledWith(version);
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

    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["init", "--bare", tempRemote]);
    execFileSync("git", ["init"], { cwd: tempRepo });
    execFileSync("git", ["remote", "add", "origin", tempRemote], {
      cwd: tempRepo,
    });

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
      `Unknown command: Outpost is not initialized at ${tempHome}`,
    );
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

    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["init", "--bare", tempRemote]);
    execFileSync("git", ["init"], { cwd: tempRepo });
    execFileSync("git", ["remote", "add", "origin", tempRemote], {
      cwd: tempRepo,
    });

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
    expect(infoSpy).toHaveBeenNthCalledWith(
      3,
      `- alpha: ${managedRepoPathOne}`,
    );
    expect(infoSpy).toHaveBeenNthCalledWith(4, `- beta: ${managedRepoPathTwo}`);
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
    expect(infoSpy.mock.calls[0]?.[0]).toContain('"repos": [');
    expect(infoSpy.mock.calls[0]?.[0]).toContain(`"id": "${repoRecord.id}"`);
    expect(infoSpy.mock.calls[0]?.[0]).toContain(
      `"managedRepoPath": "${repoRecord.managedRepoPath}"`,
    );
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

    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["init", "--bare", tempRemote]);
    execFileSync("git", ["init"], { cwd: tempRepo });
    execFileSync("git", ["remote", "add", "origin", tempRemote], {
      cwd: tempRepo,
    });

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

  it("returns an error when repo add finds multiple remotes", async () => {
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

    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["init", "--bare", tempOriginRemote]);
    execFileSync("git", ["init", "--bare", tempUpstreamRemote]);
    execFileSync("git", ["init"], { cwd: tempRepo });
    execFileSync("git", ["remote", "add", "origin", tempOriginRemote], {
      cwd: tempRepo,
    });
    execFileSync("git", ["remote", "add", "upstream", tempUpstreamRemote], {
      cwd: tempRepo,
    });

    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["repo", "add", tempRepo]);

    expect(exitCode).toBe(1);
    expect(errorSpy).toHaveBeenNthCalledWith(
      1,
      "Unknown command: Repository has multiple remotes (origin, upstream). Remote selection is not implemented yet.",
    );
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
  });
});
