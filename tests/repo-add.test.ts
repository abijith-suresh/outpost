import { renameSync, symlinkSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  addGitRemote,
  initBareGitRepo,
  initGitRepo,
  localManagedRepoPath,
  localRepoId,
  localTransportUrl,
  mkdirSync,
  path,
  readFileSync,
  runCli,
  setupAfterEach,
  createTempDir,
  writeFileSync,
} from "./helpers.ts";

setupAfterEach();

describe("run", () => {
  it("imports the current repo into the managed bare repo store", async () => {
    const tempHome = createTempDir("outpost-test-");
    const tempRepo = createTempDir("outpost-repo-");
    const tempRemote = createTempDir("outpost-remote-");
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    mkdirSync(tempRepo, { recursive: true });

    await initBareGitRepo(tempRemote);
    await initGitRepo(tempRepo);
    await addGitRemote(tempRepo, "origin", tempRemote);

    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["repo", "add", tempRepo]);
    const expectedManagedRepoPath = localManagedRepoPath(tempHome, tempRemote);

    expect(exitCode).toBe(0);
    expect(infoSpy).toHaveBeenNthCalledWith(1, "outpost repo add");
    expect(infoSpy).toHaveBeenNthCalledWith(2, `source repo path: ${tempRepo}`);
    expect(infoSpy).toHaveBeenNthCalledWith(3, "remote name: origin");
    expect(infoSpy).toHaveBeenNthCalledWith(
      4,
      `remote url: ${localTransportUrl(tempRemote)}`,
    );
    expect(infoSpy).toHaveBeenNthCalledWith(
      5,
      `repo name: ${path.basename(tempRemote)}`,
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
      repos: Array<{
        id: string;
        managedRepoPath: string;
        name: string;
        remoteName: string;
        remoteUrl: string;
        sourceRepoPath: string;
      }>;
    };

    expect(registry.repos).toHaveLength(1);
    expect(registry).not.toHaveProperty("version");
    expect(registry.repos[0]).toMatchObject({
      id: localRepoId(tempRemote),
      managedRepoPath: expectedManagedRepoPath,
      name: path.basename(tempRemote),
      remoteName: "origin",
      remoteUrl: localTransportUrl(tempRemote),
      sourceRepoPath: tempRepo,
    });
  });

  it("returns an error when repo add is run before init", async () => {
    const tempHome = createTempDir("outpost-test-");
    const tempRepo = createTempDir("outpost-repo-");
    process.env.OUTPOST_HOME = tempHome;

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
    const tempHome = createTempDir("outpost-test-");
    const tempRepo = createTempDir("outpost-repo-");
    const tempRemote = createTempDir("outpost-remote-");
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

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

  it("imports a selected remote from a multi-remote repository", async () => {
    const tempHome = createTempDir("outpost-test-");
    const tempRepo = createTempDir("outpost-repo-");
    const tempOriginRemote = createTempDir("outpost-origin-remote-");
    const tempUpstreamRemote = createTempDir("outpost-upstream-remote-");
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

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
    const expectedManagedRepoPath = localManagedRepoPath(
      tempHome,
      tempUpstreamRemote,
    );

    expect(exitCode).toBe(0);
    expect(infoSpy).toHaveBeenNthCalledWith(3, "remote name: upstream");
    expect(infoSpy).toHaveBeenNthCalledWith(
      4,
      `remote url: ${localTransportUrl(tempUpstreamRemote)}`,
    );
    expect(infoSpy).toHaveBeenNthCalledWith(
      6,
      `managed repo path: ${expectedManagedRepoPath}`,
    );

    const registry = JSON.parse(
      readFileSync(path.join(tempHome, "repos.json"), "utf8"),
    ) as {
      repos: Array<{
        managedRepoPath: string;
        remoteName: string;
        remoteUrl: string;
      }>;
    };

    expect(registry.repos).toHaveLength(1);
    expect(registry.repos[0]).toMatchObject({
      managedRepoPath: expectedManagedRepoPath,
      remoteName: "upstream",
      remoteUrl: localTransportUrl(tempUpstreamRemote),
    });
  });

  it("resolves a relative local remote for clone and stored metadata", async () => {
    const tempHome = createTempDir("outpost-test-");
    const root = createTempDir("outpost-relative-");
    const tempRepo = path.join(root, "source");
    const tempRemote = path.join(root, "remotes", "Relative.git");
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);
    mkdirSync(tempRepo, { recursive: true });
    mkdirSync(path.dirname(tempRemote), { recursive: true });
    await initBareGitRepo(tempRemote);
    await initGitRepo(tempRepo);
    await addGitRemote(tempRepo, "origin", "../remotes/Relative.git");

    const exitCode = await runCli(["repo", "add", tempRepo]);
    const registry = JSON.parse(
      readFileSync(path.join(tempHome, "repos.json"), "utf8"),
    ) as {
      repos: Array<{
        id: string;
        managedRepoPath: string;
        name: string;
        remoteUrl: string;
      }>;
    };

    expect(exitCode).toBe(0);
    expect(registry.repos[0]).toMatchObject({
      id: localRepoId(tempRemote),
      managedRepoPath: localManagedRepoPath(tempHome, tempRemote),
      name: "Relative",
      remoteUrl: localTransportUrl(tempRemote),
    });
  });

  it("updates the mirror remote and preserves importedAt and managed path on re-add", async () => {
    const tempHome = createTempDir("outpost-test-");
    const root = createTempDir("outpost-readd-");
    const tempRepo = path.join(root, "source");
    const tempRemote = path.join(root, "remotes", "Repo.git");
    const remoteLink = path.join(root, "links", "Repo.git");
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);
    mkdirSync(tempRepo, { recursive: true });
    mkdirSync(path.dirname(tempRemote), { recursive: true });
    mkdirSync(path.dirname(remoteLink), { recursive: true });
    await initBareGitRepo(tempRemote);
    symlinkSync(tempRemote, remoteLink);
    await initGitRepo(tempRepo);
    await addGitRemote(tempRepo, "origin", remoteLink);
    await runCli(["repo", "add", tempRepo]);

    const registryPath = path.join(tempHome, "repos.json");
    const registry = JSON.parse(readFileSync(registryPath, "utf8")) as {
      repos: Array<{
        id: string;
        importedAt: string;
        managedRepoPath: string;
        remoteUrl: string;
      }>;
    };
    const importedAt = registry.repos[0]?.importedAt as string;
    const derivedManagedPath = registry.repos[0]?.managedRepoPath as string;
    const preservedManagedPath = path.join(
      tempHome,
      "repos",
      "legacy",
      "Repo.git",
    );
    mkdirSync(path.dirname(preservedManagedPath), { recursive: true });
    renameSync(derivedManagedPath, preservedManagedPath);
    registry.repos[0] = {
      ...(registry.repos[0] as (typeof registry.repos)[number]),
      managedRepoPath: preservedManagedPath,
    };
    writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);

    const { execFileSync } = await import("node:child_process");
    execFileSync(
      "git",
      ["remote", "set-url", "origin", pathToFileURL(tempRemote).href],
      { cwd: tempRepo },
    );

    const exitCode = await runCli(["repo", "add", tempRepo]);
    const nextRegistry = JSON.parse(
      readFileSync(registryPath, "utf8"),
    ) as typeof registry;
    const mirrorRemote = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: preservedManagedPath,
      encoding: "utf8",
    }).trim();

    expect(exitCode).toBe(0);
    expect(nextRegistry.repos).toHaveLength(1);
    expect(nextRegistry.repos[0]).toMatchObject({
      id: localRepoId(tempRemote),
      importedAt,
      managedRepoPath: preservedManagedPath,
      remoteUrl: localTransportUrl(tempRemote),
    });
    expect(mirrorRemote).toBe(localTransportUrl(tempRemote));
  });

  it("returns an error when a multi-remote repo add omits --remote", async () => {
    const tempHome = createTempDir("outpost-test-");
    const tempRepo = createTempDir("outpost-repo-");
    const tempOriginRemote = createTempDir("outpost-origin-remote-");
    const tempUpstreamRemote = createTempDir("outpost-upstream-remote-");
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

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
    const tempHome = createTempDir("outpost-test-");
    const tempRepo = createTempDir("outpost-repo-");
    const tempOriginRemote = createTempDir("outpost-origin-remote-");
    const tempUpstreamRemote = createTempDir("outpost-upstream-remote-");
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

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
});
