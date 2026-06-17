import { describe, expect, it, vi } from "vitest";

import {
  addGitRemote,
  initBareGitRepo,
  initGitRepo,
  mkdirSync,
  os,
  path,
  readFileSync,
  runCli,
  sanitizeRemoteUrl,
  setupAfterEach,
} from "./helpers.ts";

setupAfterEach();

describe("run", () => {
  it("imports the current repo into the managed bare repo store", async () => {
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
