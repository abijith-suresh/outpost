import { describe, expect, it, vi } from "vitest";

import {
  makeRepoRecord,
  mkdirSync,
  path,
  runCli,
  setupAfterEach,
  createTempDir,
  writeRegistry,
} from "./helpers.ts";

setupAfterEach();

describe("run", () => {
  it("prints repo list output", async () => {
    const tempHome = createTempDir("outpost-test-");
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    const managedRepoPathOne = path.join(tempHome, "repos", "alpha.git");
    const managedRepoPathTwo = path.join(tempHome, "repos", "beta.git");
    mkdirSync(managedRepoPathOne, { recursive: true });

    writeRegistry(tempHome, [
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
    ]);

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
    const tempHome = createTempDir("outpost-test-");
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    const repoRecord = makeRepoRecord({
      id: "alpha",
      managedRepoPath: path.join(tempHome, "repos", "alpha.git"),
      importedAt: "2026-01-01T00:00:00.000Z",
      lastFetchedAt: "2026-01-02T00:00:00.000Z",
    });
    mkdirSync(repoRecord.managedRepoPath, { recursive: true });

    writeRegistry(tempHome, [repoRecord]);

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
    const tempHome = createTempDir("outpost-test-");
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    const repoRecord = makeRepoRecord({
      id: "alpha",
      managedRepoPath: path.join(tempHome, "repos", "alpha.git"),
    });
    mkdirSync(repoRecord.managedRepoPath, { recursive: true });

    writeRegistry(tempHome, [repoRecord]);

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
    const tempHome = createTempDir("outpost-test-");
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    const repoRecord = makeRepoRecord({
      id: "alpha",
      managedRepoPath: path.join(tempHome, "repos", "alpha.git"),
    });

    writeRegistry(tempHome, [repoRecord]);

    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["repo", "show", "alpha"]);

    expect(exitCode).toBe(0);
    expect(infoSpy).toHaveBeenNthCalledWith(4, "status: missing");
  });

  it("returns an error when repo show uses an unknown id", async () => {
    const tempHome = createTempDir("outpost-test-");
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
    const tempHome = createTempDir("outpost-test-");
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    const firstManagedRepoPath = path.join(tempHome, "repos", "alpha-one.git");
    const secondManagedRepoPath = path.join(tempHome, "repos", "alpha-two.git");

    writeRegistry(tempHome, [
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
    ]);

    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["repo", "show", "alpha"]);

    expect(exitCode).toBe(1);
    expect(errorSpy).toHaveBeenNthCalledWith(
      1,
      "Repo registry contains duplicate id: alpha",
    );
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects duplicate managed paths in the registry", async () => {
    const tempHome = createTempDir("outpost-test-");
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    const managedRepoPath = path.join(tempHome, "repos", "shared.git");
    writeRegistry(tempHome, [
      makeRepoRecord({
        id: "example.com/one/alpha",
        managedRepoPath,
      }),
      makeRepoRecord({
        id: "example.com/two/beta",
        managedRepoPath,
      }),
    ]);

    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["repo", "list"]);

    expect(exitCode).toBe(1);
    expect(errorSpy).toHaveBeenNthCalledWith(
      1,
      `Repo registry contains duplicate managed path: ${managedRepoPath}`,
    );
  });

  it("rejects managed paths that differ only by case", async () => {
    const tempHome = createTempDir("outpost-test-");
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    const upperManagedRepoPath = path.join(
      tempHome,
      "repos",
      "Group",
      "Repo.git",
    );
    const lowerManagedRepoPath = path.join(
      tempHome,
      "repos",
      "group",
      "repo.git",
    );
    writeRegistry(tempHome, [
      makeRepoRecord({
        id: "example.com/Group/Repo",
        managedRepoPath: upperManagedRepoPath,
      }),
      makeRepoRecord({
        id: "example.com/group/repo",
        managedRepoPath: lowerManagedRepoPath,
      }),
    ]);

    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["repo", "list"]);

    expect(exitCode).toBe(1);
    expect(errorSpy).toHaveBeenNthCalledWith(
      1,
      `Repo registry contains duplicate managed path: ${lowerManagedRepoPath}`,
    );
  });

  it("prints repo list output as json", async () => {
    const tempHome = createTempDir("outpost-test-");
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

    writeRegistry(tempHome, [repoRecord]);

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
});
