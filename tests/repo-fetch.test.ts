import { describe, expect, it, vi } from "vitest";

import {
  addGitRemote,
  initBareGitRepo,
  initGitRepo,
  makeRepoRecord,
  mkdirSync,
  os,
  path,
  readFileSync,
  runCli,
  setupAfterEach,
  trackTempDir,
  writeFileSync,
} from "./helpers.ts";

setupAfterEach();

describe("run", () => {
  it("succeeds when repo fetch --all runs against an empty registry", async () => {
    const tempHome = trackTempDir(
      path.join(os.tmpdir(), `outpost-test-${Date.now()}`),
    );
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
    const tempHome = trackTempDir(
      path.join(os.tmpdir(), `outpost-test-${Date.now()}`),
    );
    const tempRepo = trackTempDir(
      path.join(os.tmpdir(), `outpost-repo-${Date.now()}`),
    );
    const tempRemote = trackTempDir(
      path.join(os.tmpdir(), `outpost-remote-${Date.now()}.git`),
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
    const tempHome = trackTempDir(
      path.join(os.tmpdir(), `outpost-test-${Date.now()}`),
    );
    const tempRepo = trackTempDir(
      path.join(os.tmpdir(), `outpost-repo-${Date.now()}`),
    );
    const tempRemote = trackTempDir(
      path.join(os.tmpdir(), `outpost-remote-${Date.now()}.git`),
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
    const tempHome = trackTempDir(
      path.join(os.tmpdir(), `outpost-test-${Date.now()}`),
    );
    const tempRepo = trackTempDir(
      path.join(os.tmpdir(), `outpost-repo-${Date.now()}`),
    );
    const tempRemote = trackTempDir(
      path.join(os.tmpdir(), `outpost-remote-${Date.now()}.git`),
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
    const tempHome = trackTempDir(
      path.join(os.tmpdir(), `outpost-test-${Date.now()}`),
    );
    const tempRepo = trackTempDir(
      path.join(os.tmpdir(), `outpost-repo-${Date.now()}`),
    );
    const tempRemote = trackTempDir(
      path.join(os.tmpdir(), `outpost-remote-${Date.now()}.git`),
    );
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

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
});
