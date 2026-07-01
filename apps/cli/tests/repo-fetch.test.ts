import { execFileSync } from "node:child_process";
import { chmodSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  addGitRemote,
  initBareGitRepo,
  initGitRepo,
  makeRepoRecord,
  mkdirSync,
  path,
  readFileSync,
  runCli,
  setupAfterEach,
  createTempDir,
  writeFileSync,
  writeRegistry,
} from "./helpers.ts";

const GIT_STDOUT_SENTINEL = "OUTPOST_GIT_STDOUT_SENTINEL";
const GIT_STDERR_SENTINEL = "OUTPOST_GIT_STDERR_SENTINEL";

function installFailingGitShim(subcommand: "fetch"): void {
  const shimRoot = createTempDir("outpost-git-shim-");
  const shimPath = path.join(shimRoot, "git");
  const realGit = execFileSync("sh", ["-c", "command -v git"], {
    encoding: "utf8",
  }).trim();

  writeFileSync(
    shimPath,
    `#!/bin/sh
if [ "$1" = "${subcommand}" ]; then
  index=0
  while [ "$index" -lt 2048 ]; do
    printf '${GIT_STDOUT_SENTINEL}-%s-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\\n' "$index"
    printf '${GIT_STDERR_SENTINEL}-%s-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\\n' "$index" >&2
    index=$((index + 1))
  done
  exit 23
fi
exec "$OUTPOST_TEST_REAL_GIT" "$@"
`,
  );
  chmodSync(shimPath, 0o755);
  process.env.OUTPOST_TEST_REAL_GIT = realGit;
  process.env.PATH = `${shimRoot}:${process.env.PATH ?? ""}`;
}

setupAfterEach();

describe("run", () => {
  it("succeeds when repo fetch --all runs against an empty registry", async () => {
    const tempHome = createTempDir("outpost-test-");
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
    const tempHome = createTempDir("outpost-test-");
    const tempRepo = createTempDir("outpost-repo-");
    const tempRemote = createTempDir("outpost-remote-");
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    mkdirSync(tempRepo, { recursive: true });

    await initBareGitRepo(tempRemote);
    await initGitRepo(tempRepo);
    await addGitRemote(tempRepo, "origin", tempRemote);
    await runCli(["repo", "add", tempRepo]);

    const registryPath = path.join(tempHome, "repos.json");
    const registry = JSON.parse(readFileSync(registryPath, "utf8")) as {
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
      repos: Array<ReturnType<typeof makeRepoRecord>>;
    };

    expect(exitCode).toBe(0);
    expect(nextRegistry.repos[0]?.lastFetchedAt).not.toBe(
      previousLastFetchedAt,
    );
  });

  it("continues across repo fetch failures, reports both results, and exits 1", async () => {
    const tempHome = createTempDir("outpost-test-");
    const tempRepo = createTempDir("outpost-repo-");
    const tempRemote = createTempDir("outpost-remote-");
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
    const tempHome = createTempDir("outpost-test-");
    const tempRepo = createTempDir("outpost-repo-");
    const tempRemote = createTempDir("outpost-remote-");
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
    expect(output).toContain('"ok": false');
    expect(output).toContain('"exitCode": 1');
    expect(output).toContain('"command": "repo fetch"');
    expect(output).toContain('"repoCount": 2');
    expect(output).toContain('"fetchedCount": 1');
    expect(output).toContain('"failedCount": 1');
    expect(output).toContain('"fetchStatus": "fetched"');
    expect(output).toContain('"fetchStatus": "failed"');
    expect(output).toContain('"error":');
  });

  it("keeps captured git fetch diagnostics structured in json and out of human output", async () => {
    const tempHome = createTempDir("outpost-test-");
    const managedRepoPath = path.join(tempHome, "repos", "diagnostic.git");
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);
    mkdirSync(managedRepoPath, { recursive: true });
    const repo = makeRepoRecord({
      id: "diagnostic",
      managedRepoPath,
    });
    writeRegistry(tempHome, [repo]);
    installFailingGitShim("fetch");

    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["repo", "fetch", "--all", "--json"]);

    expect(exitCode).toBe(1);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledTimes(1);

    const output = JSON.parse(String(infoSpy.mock.calls[0]?.[0])) as {
      data: {
        results: Array<{
          error: string;
          diagnostics: Array<{ stream: string; line: string }>;
        }>;
      };
    };
    const result = output.data.results[0];

    expect(result?.error).toBe(
      `git fetch failed for ${managedRepoPath} (exit status 23)`,
    );
    expect(result?.diagnostics).toHaveLength(4096);
    expect(result?.diagnostics).toContainEqual({
      stream: "stdout",
      line: `${GIT_STDOUT_SENTINEL}-0-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`,
    });
    expect(result?.diagnostics).toContainEqual({
      stream: "stderr",
      line: `${GIT_STDERR_SENTINEL}-2047-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`,
    });

    infoSpy.mockClear();

    const humanExitCode = await runCli(["repo", "fetch", "--all"]);
    const humanOutput = infoSpy.mock.calls
      .map(([line]) => String(line))
      .join("\n");

    expect(humanExitCode).toBe(1);
    expect(humanOutput).toContain(
      `error: git fetch failed for ${managedRepoPath} (exit status 23)`,
    );
    expect(humanOutput).not.toContain(GIT_STDOUT_SENTINEL);
    expect(humanOutput).not.toContain(GIT_STDERR_SENTINEL);
    expect(errorSpy).not.toHaveBeenCalled();
  }, 10_000);

  it("updates an existing registry record when repo add is rerun", async () => {
    const tempHome = createTempDir("outpost-test-");
    const tempRepo = createTempDir("outpost-repo-");
    const tempRemote = createTempDir("outpost-remote-");
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
    ) as { repos: Array<unknown> };

    expect(registry.repos).toHaveLength(1);
  });
});
