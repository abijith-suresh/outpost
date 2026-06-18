import { describe, expect, it, vi } from "vitest";

import {
  createManagedRepoFixture,
  existsSync,
  makeRepoRecord,
  mkdirSync,
  path,
  readFileSync,
  runCli,
  setupAfterEach,
  createTempDir,
  writeRegistry,
} from "./helpers.ts";

setupAfterEach();

describe("run", () => {
  describe("repo remove", () => {
    it("removes a repo from the registry and deletes the managed repo", async () => {
      const tempHome = createTempDir("outpost-test-");
      process.env.OUTPOST_HOME = tempHome;

      await runCli(["init"]);

      const alpha = await createManagedRepoFixture({ defaultBranch: "main" });
      await runCli(["repo", "add", alpha.tempRepo]);

      const registryPath = path.join(tempHome, "repos.json");
      const registry = JSON.parse(readFileSync(registryPath, "utf8")) as {
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

      const nextRegistry = JSON.parse(readFileSync(registryPath, "utf8")) as {
        repos: Array<unknown>;
      };

      expect(nextRegistry.repos).toEqual([]);
      expect(existsSync(managedRepoPath)).toBe(false);
    });

    it("prints repo remove output as json", async () => {
      const tempHome = createTempDir("outpost-test-");
      process.env.OUTPOST_HOME = tempHome;

      await runCli(["init"]);

      const alpha = await createManagedRepoFixture({ defaultBranch: "main" });
      await runCli(["repo", "add", alpha.tempRepo]);

      const registryPath = path.join(tempHome, "repos.json");
      const registry = JSON.parse(readFileSync(registryPath, "utf8")) as {
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
      const tempHome = createTempDir("outpost-test-");
      process.env.OUTPOST_HOME = tempHome;

      await runCli(["init"]);

      const managedRepoPath = path.join(tempHome, "repos", "alpha.git");
      mkdirSync(managedRepoPath, { recursive: true });
      writeRegistry(tempHome, [
        makeRepoRecord({
          id: "alpha",
          managedRepoPath,
        }),
      ]);

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
      const tempHome = createTempDir("outpost-test-");
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
      const tempHome = createTempDir("outpost-test-");
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
