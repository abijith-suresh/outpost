import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { expect, it, vi } from "vitest";
import { runWorkspaceList } from "../src/commands/workspace-list.ts";
import type { OutpostConfig } from "../src/config.ts";
import {
  createManagedRepoFixture,
  createTempDir,
  mkdirSync,
  path,
  readFileSync,
  readRegistry,
  runCli,
  setupAfterEach,
  writeFileSync,
} from "./helpers.ts";

setupAfterEach();

it("lists real workspaces with linear manifest reads and identity resolution, and refreshes each inspection", async () => {
  const home = createTempDir();
  process.env.OUTPOST_HOME = home;
  const info = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  expect(await runCli(["init"])).toBe(0);
  const source = await createManagedRepoFixture({ defaultBranch: "main" });
  expect(await runCli(["repo", "add", source.tempRepo])).toBe(0);
  const repo = readRegistry(home).repos[0];
  const config = JSON.parse(readFileSync(path.join(home, "config.json"), "utf8")) as OutpostConfig;
  const state = path.join(home, "workspaces");
  let created = 0;
  const inspect = () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const counts = { manifestReads: 0, manifestIdentities: 0, siblingScans: 0, configReads: 0 };
        const measured: FileSystem.FileSystem = {
          ...fs,
          readFileString: (file, ...options) => {
            if (path.dirname(file) === state && file.endsWith(".json")) counts.manifestReads++;
            if (file === path.join(home, "config.json")) counts.configReads++;
            return fs.readFileString(file, ...options);
          },
          realPath: (file) => {
            if (path.dirname(file) === state && file.endsWith(".json")) counts.manifestIdentities++;
            return fs.realPath(file);
          },
          readDirectory: (directory) => {
            if (directory === state) counts.siblingScans++;
            return fs.readDirectory(directory);
          },
        };
        const output = yield* runWorkspaceList().pipe(
          Effect.provideService(FileSystem.FileSystem, measured)
        );
        return { output, counts };
      }).pipe(Effect.provide(NodeServices.layer))
    );

  for (const size of [10, 30]) {
    while (created < size) {
      const ticket = `MANY-${++created}`;
      const branch = `feat/${ticket}`;
      const directory = path.join(config.worktreesRoot, ticket);
      mkdirSync(directory);
      execFileSync(
        "git",
        [
          "--git-dir",
          repo.managedRepoPath,
          "worktree",
          "add",
          "-b",
          branch,
          path.join(directory, repo.name),
          "main",
        ],
        { stdio: "pipe" }
      );
      writeFileSync(
        path.join(state, `${ticket}.json`),
        JSON.stringify({
          ticket,
          type: "feat",
          branch,
          workspacePath: ticket,
          createdAt: new Date(0).toISOString(),
          repositories: [
            {
              id: repo.id,
              name: repo.name,
              base: "main",
              managedPath: path.relative(config.reposRoot, repo.managedRepoPath),
              worktreePath: repo.name,
            },
          ],
        })
      );
    }
    const { output, counts } = await inspect();
    expect(output.data.workspaces).toHaveLength(size);
    expect(
      output.data.workspaces.every(
        (workspace) => workspace.status === "ready" && workspace.worktreeCount === 1
      )
    ).toBe(true);
    expect(counts.manifestReads).toBeLessThanOrEqual(size + 1);
    expect(counts.manifestIdentities).toBeLessThanOrEqual(size * 2);
    expect(counts.siblingScans).toBeLessThanOrEqual(2);
    expect(counts.configReads).toBeLessThanOrEqual(2);
  }

  // A second invocation must observe new corruption/collisions and missing paths.
  const original = JSON.parse(readFileSync(path.join(state, "MANY-1.json"), "utf8"));
  writeFileSync(
    path.join(state, "many-1.json"),
    JSON.stringify({ ...original, ticket: "many-1", workspacePath: "many-1" })
  );
  writeFileSync(path.join(state, "BROKEN.json"), "invalid JSON");
  rmSync(path.join(config.worktreesRoot, "MANY-2", repo.name), { recursive: true });
  mkdirSync(path.join(config.worktreesRoot, "UNMANAGED"));
  const refreshed = await inspect();
  const statuses = new Map(
    refreshed.output.data.workspaces.map((workspace) => [workspace.ticket, workspace.status])
  );
  expect(statuses.get("MANY-1")).toBe("invalid");
  expect(statuses.get("many-1")).toBe("invalid");
  expect(statuses.get("BROKEN")).toBe("invalid");
  expect(statuses.get("MANY-2")).toBe("missing");
  expect(statuses.get("UNMANAGED")).toBe("unmanaged");
  info.mockClear();
  error.mockClear();
  expect(await runCli(["workspace", "remove", "MANY-1", "--json"])).toBe(1);
  expect(JSON.parse(String(error.mock.calls[0][0])).error).toMatchObject({
    code: "WORKSPACE_REMOVE_FAILED",
    reason: "invalid-state",
  });
  expect(readFileSync(path.join(state, "MANY-1.json"), "utf8")).toBe(JSON.stringify(original));
});
