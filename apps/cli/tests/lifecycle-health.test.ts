import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { NodeServices } from "@effect/platform-node";
import { Effect, Fiber } from "effect";
import { describe, expect, it, vi } from "vitest";
import { runCreate } from "../src/commands/create.ts";
import * as Store from "../src/store.ts";
import * as WorkspaceManifest from "../src/workspace-manifest.ts";
import {
  createManagedRepoFixture,
  createTempDir,
  existsSync,
  path,
  readFileSync,
  readRegistry,
  runCli,
  setupAfterEach,
  writeFileSync,
} from "./helpers.ts";

setupAfterEach();

describe("initialization recovery", () => {
  it("retries after a failed config marker write while preserving the installed registry", async () => {
    const home = createTempDir();
    process.env.OUTPOST_HOME = home;
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const configPath = path.join(home, "config.json");
    const original = Store.writeJsonFileAtomic;
    const write = vi
      .spyOn(Store, "writeJsonFileAtomic")
      .mockImplementation((file, value) =>
        file === configPath
          ? Effect.fail(new Store.StoreError({ message: "simulated config marker write failure" }))
          : original(file, value)
      );
    expect(await runCli(["init"])).toBe(1);
    expect(existsSync(configPath)).toBe(false);
    expect(existsSync(path.join(home, ".mutation.lock"))).toBe(false);
    const registryPath = path.join(home, "repos.json");
    expect(readRegistry(home).repos).toEqual([]);
    // Preserve its exact bytes, not just a reconstructed empty snapshot.
    writeFileSync(registryPath, '{ "repos": [] }\n');
    write.mockRestore();
    expect(await runCli(["init"])).toBe(0);
    expect(readFileSync(registryPath, "utf8")).toBe('{ "repos": [] }\n');
    expect(existsSync(configPath)).toBe(true);
  });

  it("preserves invalid pre-existing registry data and leaves the config marker absent", async () => {
    const home = createTempDir();
    process.env.OUTPOST_HOME = home;
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const registryPath = path.join(home, "repos.json");
    writeFileSync(registryPath, "foreign data\n");
    expect(await runCli(["init"])).toBe(1);
    expect(readFileSync(registryPath, "utf8")).toBe("foreign data\n");
    expect(existsSync(path.join(home, "config.json"))).toBe(false);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Existing registry preserved"));
  });

  it("reports an older partial init or lost registry without replacing it with empty state", async () => {
    const home = createTempDir();
    process.env.OUTPOST_HOME = home;
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await runCli(["init"])).toBe(0);
    rmSync(path.join(home, "repos.json"));
    expect(await runCli(["init"])).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Initialization is incomplete"));
    expect(existsSync(path.join(home, "repos.json"))).toBe(false);
  });
});

it("marks broken HEAD invalid in show and doctor while accepting changed branches and detached HEAD", async () => {
  const home = createTempDir();
  process.env.OUTPOST_HOME = home;
  const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
  expect(await runCli(["init"])).toBe(0);
  const source = await createManagedRepoFixture({ defaultBranch: "main" });
  expect(await runCli(["repo", "add", source.tempRepo])).toBe(0);
  const repo = readRegistry(home).repos[0];
  expect(await runCli(["create", "--ticket", "HEALTH", "--type", "fix", "--repo", repo.id])).toBe(
    0
  );
  const worktree = path.join(home, "worktrees", "HEALTH", repo.name);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: worktree, encoding: "utf8" }).trim();
  const showStatus = async () => {
    output.mockClear();
    expect(await runCli(["workspace", "show", "HEALTH", "--json"])).toBe(0);
    return JSON.parse(String(output.mock.calls[0][0])).data.status;
  };
  git("switch", "-c", "fix/other-valid-branch");
  expect(await showStatus()).toBe("ready");
  git("checkout", "--detach");
  expect(await showStatus()).toBe("ready");
  git("symbolic-ref", "HEAD", "refs/heads/broken-unborn");
  expect(await showStatus()).toBe("invalid");
  output.mockClear();
  expect(await runCli(["doctor", "--json"])).toBe(0);
  const doctor = JSON.parse(String(output.mock.calls[0][0])).data;
  expect(doctor.status).toBe("degraded");
  expect(doctor.unhealthyWorkspaceCount).toBe(1);
  expect(doctor.workspaceHealth).toEqual([{ ticket: "HEALTH", status: "invalid" }]);
});

it("preserves a completed workspace when interruption arrives during the manifest commit", async () => {
  const home = createTempDir();
  process.env.OUTPOST_HOME = home;
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  expect(await runCli(["init"])).toBe(0);
  const source = await createManagedRepoFixture({ defaultBranch: "main" });
  expect(await runCli(["repo", "add", source.tempRepo])).toBe(0);
  const repo = readRegistry(home).repos[0];
  const gate = () => {
    let resolve: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve: () => resolve() };
  };
  const markerWritten = gate();
  const release = gate();
  const original = WorkspaceManifest.writeManifest;
  vi.spyOn(WorkspaceManifest, "writeManifest").mockImplementation((outpostHome, manifest) =>
    original(outpostHome, manifest).pipe(
      Effect.tap(() =>
        Effect.promise(async () => {
          markerWritten.resolve();
          await release.promise;
        })
      )
    )
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const creating = yield* Effect.forkChild(
        runCreate(["--ticket", "COMMITTED", "--type", "fix", "--repo", repo.id], {
          interactive: false,
        })
      );
      yield* Effect.promise(() => markerWritten.promise);
      const interrupting = yield* Effect.forkChild(Fiber.interrupt(creating));
      yield* Effect.sleep(10);
      release.resolve();
      yield* Fiber.join(interrupting);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );
  expect(existsSync(path.join(home, "workspaces", "COMMITTED.json"))).toBe(true);
  expect(existsSync(path.join(home, "worktrees", "COMMITTED", repo.name))).toBe(true);
  expect(existsSync(path.join(home, ".mutation.lock"))).toBe(false);
  const output = vi.spyOn(console, "log");
  output.mockClear();
  expect(await runCli(["workspace", "show", "COMMITTED", "--json"])).toBe(0);
  expect(JSON.parse(String(output.mock.calls[0][0])).data.status).toBe("ready");
});

it("records removal intent before deleting a mirror and releases the lock if journaling fails", async () => {
  const home = createTempDir();
  process.env.OUTPOST_HOME = home;
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  expect(await runCli(["init"])).toBe(0);
  const source = await createManagedRepoFixture({ defaultBranch: "main" });
  expect(await runCli(["repo", "add", source.tempRepo])).toBe(0);
  const repo = readRegistry(home).repos[0];
  const original = Store.writeJsonFileAtomic;
  vi.spyOn(Store, "writeJsonFileAtomic").mockImplementation((file, value) =>
    file.startsWith(path.join(home, "operations") + path.sep)
      ? Effect.fail(new Store.StoreError({ message: "simulated journal write failure" }))
      : original(file, value)
  );
  expect(await runCli(["repo", "remove", repo.id])).toBe(1);
  expect(existsSync(repo.managedRepoPath)).toBe(true);
  expect(readRegistry(home).repos).toHaveLength(1);
  expect(existsSync(path.join(home, ".mutation.lock"))).toBe(false);
});

it("retries unregistering after deletion succeeds but the registry write fails", async () => {
  const home = createTempDir();
  process.env.OUTPOST_HOME = home;
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  expect(await runCli(["init"])).toBe(0);
  const source = await createManagedRepoFixture({ defaultBranch: "main" });
  expect(await runCli(["repo", "add", source.tempRepo])).toBe(0);
  const repo = readRegistry(home).repos[0];
  const original = Store.writeJsonFileAtomic;
  const write = vi
    .spyOn(Store, "writeJsonFileAtomic")
    .mockImplementation((file, value) =>
      file === path.join(home, "repos.json")
        ? Effect.fail(new Store.StoreError({ message: "simulated registry write failure" }))
        : original(file, value)
    );
  expect(await runCli(["repo", "remove", repo.id])).toBe(1);
  expect(existsSync(repo.managedRepoPath)).toBe(false);
  expect(readRegistry(home).repos).toHaveLength(1);
  write.mockRestore();
  expect(await runCli(["repo", "remove", repo.id])).toBe(0);
  expect(readRegistry(home).repos).toEqual([]);
});
