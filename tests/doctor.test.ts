import { describe, expect, it, vi } from "vitest";

import {
  mkdirSync,
  os,
  path,
  readRegistry,
  runCli,
  setupAfterEach,
  writeRegistry,
} from "./helpers.ts";

setupAfterEach();

describe("run", () => {
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

    writeRegistry(tempHome, [
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
    ]);

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

    writeRegistry(tempHome, [
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
    ]);

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

    const registry = readRegistry(tempHome);

    expect(registry).toEqual({ repos: [], version: 1 });
  });
});
