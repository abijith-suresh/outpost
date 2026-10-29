import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { NodePath, NodeServices } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vitest";
import { commandString, gitCommand } from "../src/child-process.ts";
import {
  runConfigSet,
  runGuidanceSet,
  validateWorktreesRootInput,
} from "../src/commands/settings.ts";
import { classifyAgentsOwnership } from "../src/workspace-agents.ts";
import {
  createManagedRepoFixture,
  createTempDir,
  existsSync,
  localManagedRepoPath,
  localRepoId,
  mkdirSync,
  path,
  readFileSync,
  readRegistry,
  runCli,
  setupAfterEach,
  writeFileSync,
} from "./helpers.ts";

setupAfterEach();

// Fixture inspection must use the same command-scoped Windows capability as
// Outpost. Encoded random names can push internal pack files beyond MAX_PATH.
function fixtureGit(args: string[], options: { encoding: "utf8" } = { encoding: "utf8" }) {
  return execFileSync(
    "git",
    process.platform === "win32" ? ["-c", "core.longpaths=true", ...args] : args,
    options
  );
}

async function cli(...args: string[]) {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  log.mockClear();
  error.mockClear();
  const command = ["outpost", ...args, "--json"];
  const code = await runCli(command.slice(1));
  const stdout = log.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
  const stderr = error.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
  const diagnostics = JSON.stringify({ command, code, stdout, stderr }, null, 2);
  let envelope: ReturnType<typeof JSON.parse>;
  try {
    // Partial results use stdout even though the command exits nonzero.
    envelope = JSON.parse(stderr || stdout);
  } catch (cause) {
    throw new Error(`CLI did not return one JSON envelope:\n${diagnostics}`, { cause });
  }
  return {
    code,
    envelope,
    diagnostics: JSON.stringify({ command, code, envelope, stdout, stderr }, null, 2),
  };
}
function expectCliCode(result: Awaited<ReturnType<typeof cli>>, code: number) {
  expect(result.code, result.diagnostics).toBe(code);
}
function expectCliSuccess(result: Awaited<ReturnType<typeof cli>>) {
  expect(result.code, result.diagnostics).toBe(0);
  expect(result.envelope.ok, result.diagnostics).toBe(true);
  return result;
}
async function cliSuccess(...args: string[]) {
  return expectCliSuccess(await cli(...args));
}
async function fixture() {
  const home = createTempDir();
  process.env.OUTPOST_HOME = home;
  expectCliSuccess(await cli("init"));
  const repo = await createManagedRepoFixture({ defaultBranch: "main" });
  expectCliSuccess(await cli("repo", "add", repo.tempRepo));
  return { home, repo, id: localRepoId(repo.tempRemote) };
}
const createArgs = (ticket: string, id: string) => [
  "--ticket",
  ticket,
  "--type",
  "feat",
  "--repo",
  id,
];

describe("configuration, tags and future workspace guidance", () => {
  it("keeps the Windows long-path override scoped to the Git command", async () => {
    const repo = await createManagedRepoFixture({ defaultBranch: "main" });
    // A disposable fixture has an explicit contrary value, so precedence is observable.
    execFileSync("git", ["-C", repo.tempRepo, "config", "--local", "core.longpaths", "false"]);
    const configPath = path.join(repo.tempRepo, ".git", "config");
    const before = readFileSync(configPath, "utf8");
    const globalSetting = () => {
      const result = spawnSync("git", ["config", "--global", "--get-all", "core.longpaths"], {
        encoding: "utf8",
      });
      if (result.error) throw result.error;
      return { status: result.status, value: result.stdout };
    };
    const globalBefore = globalSetting();
    const observed = await Effect.runPromise(
      commandString(
        gitCommand("-C", repo.tempRepo, "config", "--show-scope", "--get", "core.longpaths")
      ).pipe(Effect.provide(NodeServices.layer))
    );
    expect(observed.trim().split(/\s+/)).toEqual(
      process.platform === "win32" ? ["command", "true"] : ["local", "false"]
    );
    expect(readFileSync(configPath, "utf8")).toBe(before);
    expect(globalSetting()).toEqual(globalBefore);
  });

  it.each([205, 220])(
    "clones real pack files beyond 260 characters at a %i-byte Git directory and validates the full plan",
    async (gitDirBytes) => {
      // The exact admin-boundary case needs a fixed 26-character member name.
      // Keep the 220-byte case's random encoded name; random uppercase bytes
      // must not make the 205-byte fixture's minimum layout exceed its target.
      const repo = await createManagedRepoFixture({
        defaultBranch: "main",
        ...(gitDirBytes === 205 ? { repoName: "outpost-create-repo-fixed0" } : {}),
      });
      const outer = realpathSync.native(createTempDir());
      const baseline = localManagedRepoPath(path.join(outer, "h"), repo.tempRemote);
      const padding = gitDirBytes - Buffer.byteLength(baseline, "utf8");
      expect(padding).toBeGreaterThanOrEqual(0);
      const home = path.join(outer, `h${"x".repeat(padding)}`);
      mkdirSync(home);
      process.env.OUTPOST_HOME = home;
      await cliSuccess("init");
      const configPath = path.join(home, "config.json");
      const configBytes = readFileSync(configPath, "utf8");
      const sourceConfig = readFileSync(path.join(repo.tempRepo, ".git", "config"), "utf8");
      const initialCommit = fixtureGit(["-C", repo.tempRepo, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();
      await cliSuccess("repo", "add", repo.tempRepo);
      const record = readRegistry(home).repos[0];
      expect(Buffer.byteLength(record.managedRepoPath, "utf8")).toBe(gitDirBytes);
      const packDirectory = path.join(record.managedRepoPath, "objects", "pack");
      const packs = readdirSync(packDirectory).filter((name) => name.endsWith(".pack"));
      expect(packs.length).toBeGreaterThan(0);
      for (const pack of packs) expect(path.join(packDirectory, pack).length).toBeGreaterThan(260);
      await cliSuccess("repo", "fetch", "--all");
      let adminSentinel: string | undefined;
      if (gitDirBytes === 205) {
        fixtureGit([
          "--git-dir",
          record.managedRepoPath,
          "config",
          "extensions.worktreeConfig",
          "true",
        ]);
        writeFileSync(
          path.join(record.managedRepoPath, "config.worktree"),
          "[core]\n bare = true\n[outpost]\n boundary = preserved\n"
        );
        adminSentinel = path.join(record.managedRepoPath, "worktrees", record.name);
        mkdirSync(path.dirname(adminSentinel), { recursive: true });
        writeFileSync(adminSentinel, "unowned administrative-name sentinel");
      }
      const localConfigPath = path.join(record.managedRepoPath, "config");
      const localConfigBytes = readFileSync(localConfigPath, "utf8");
      if (gitDirBytes === 220 && process.platform === "win32") {
        const registryBefore = readFileSync(path.join(home, "repos.json"), "utf8");
        const refsBefore = fixtureGit(["--git-dir", record.managedRepoPath, "show-ref"], {
          encoding: "utf8",
        });
        const result = await cli("create", ...createArgs("LONG-1", record.id));
        expectCliCode(result, 1);
        expect(result.envelope.error).toMatchObject({
          reason: "invalid-arguments",
          retryable: false,
        });
        expect(result.envelope.error.message).toContain("administrative-directory");
        expect(result.envelope.error.message).toContain("maximum 243");
        expect(readFileSync(configPath, "utf8")).toBe(configBytes);
        expect(readFileSync(localConfigPath, "utf8")).toBe(localConfigBytes);
        expect(readFileSync(path.join(home, "repos.json"), "utf8")).toBe(registryBefore);
        expect(readFileSync(path.join(repo.tempRepo, ".git", "config"), "utf8")).toBe(sourceConfig);
        expect(
          fixtureGit(["--git-dir", record.managedRepoPath, "show-ref"], {
            encoding: "utf8",
          })
        ).toBe(refsBefore);
        expect(existsSync(path.join(home, "worktrees", "LONG-1"))).toBe(false);
        expect(existsSync(path.join(home, "workspaces", "LONG-1.json"))).toBe(false);
        for (const pack of packs) expect(existsSync(path.join(packDirectory, pack))).toBe(true);
      } else {
        const created = await cliSuccess("create", ...createArgs("LONG-1", record.id));
        const configAfterCreate = readFileSync(configPath, "utf8");
        expect(JSON.parse(configAfterCreate)).toEqual({
          ...JSON.parse(configBytes),
          version: 2,
          legacyWorktreesRoot: JSON.parse(configBytes).worktreesRoot,
          trustedWorktreesRoots: [JSON.parse(configBytes).worktreesRoot],
          extraInstructions: "",
        });
        const workspacePath = created.envelope.data.ticketDirectory;
        const worktreePath = created.envelope.data.worktrees[0].path;
        const resumed = await cliSuccess("workspace", "resume", "LONG-1");
        expect(resumed.envelope.data.status).toBe("ready");
        expect(resumed.envelope.data.worktrees[0]).toMatchObject({
          path: worktreePath,
          currentHead: initialCommit,
          currentBranch: "feat/LONG-1",
          originalBase: { baseCommit: initialCommit },
        });
        if (gitDirBytes === 205) {
          const adminPath = readFileSync(path.join(worktreePath, ".git"), "utf8")
            .replace(/^gitdir: /, "")
            .trim();
          expect(adminPath.length).toBe(243);
          expect(path.join(adminPath, "config.worktree").length).toBe(259);
          expect(readFileSync(path.join(adminPath, "config.worktree"), "utf8")).toContain(
            "boundary = preserved"
          );
          // The mirror stays bare; its linked checkout has separate worktree
          // configuration. Exercise startup reading that file at 259 units.
          fixtureGit(["-C", worktreePath, "config", "--worktree", "core.bare", "false"]);
        }
        expect(
          fixtureGit(["-C", worktreePath, "rev-parse", "HEAD"], {
            encoding: "utf8",
          }).trim()
        ).toBe(initialCommit);
        expect((await cliSuccess("workspace", "show", "LONG-1")).envelope.data.status).toBe(
          "ready"
        );
        expect((await cliSuccess("doctor")).envelope.data.unhealthyWorkspaceCount).toBe(0);
        await cliSuccess("workspace", "remove", "LONG-1");
        expect(existsSync(workspacePath)).toBe(false);
        expect(existsSync(path.join(home, "workspaces", "LONG-1.json"))).toBe(false);
        expect(
          fixtureGit(["--git-dir", record.managedRepoPath, "rev-parse", "refs/heads/feat/LONG-1"], {
            encoding: "utf8",
          }).trim()
        ).toBe(initialCommit);
        expect(readFileSync(configPath, "utf8")).toBe(configAfterCreate);
        expect(readFileSync(localConfigPath, "utf8")).toBe(localConfigBytes);
        expect(readFileSync(path.join(repo.tempRepo, ".git", "config"), "utf8")).toBe(sourceConfig);
        if (adminSentinel)
          expect(readFileSync(adminSentinel, "utf8")).toBe("unowned administrative-name sentinel");
      }
      if (gitDirBytes === 220) {
        const beyondHome = `${home}b`;
        mkdirSync(beyondHome);
        process.env.OUTPOST_HOME = beyondHome;
        await cliSuccess("init");
        const beforeRefusal = ["config.json", "repos.json"].map((file) =>
          readFileSync(path.join(beyondHome, file), "utf8")
        );
        const beyond = await cli("repo", "add", repo.tempRepo);
        if (process.platform === "win32") {
          expectCliCode(beyond, 1);
          expect(beyond.envelope.error.message).toContain("221 UTF-8 bytes; maximum 220");
          expect(
            ["config.json", "repos.json"].map((file) =>
              readFileSync(path.join(beyondHome, file), "utf8")
            )
          ).toEqual(beforeRefusal);
          expect(existsSync(localManagedRepoPath(beyondHome, repo.tempRemote))).toBe(false);
        } else expectCliSuccess(beyond);
      }
    }
  );

  it("refuses unsupported canonical roots before import or config migration, preserving source and metadata", async () => {
    const outer = realpathSync.native(createTempDir());
    const home = path.join(outer, "long-managed-root-".repeat(5), "nested-space-café-".repeat(4));
    mkdirSync(home, { recursive: true });
    process.env.OUTPOST_HOME = home;
    await cliSuccess("init");
    const repo = await createManagedRepoFixture({ defaultBranch: "main" });
    const paths = [
      path.join(home, "config.json"),
      path.join(home, "repos.json"),
      path.join(repo.tempRepo, ".git", "config"),
      path.join(repo.tempRepo, ".git", "HEAD"),
    ];
    const bytes = paths.map((file) => readFileSync(file, "utf8"));
    const sentinel = path.join(home, "repos", "sentinel.txt");
    writeFileSync(sentinel, "preserve unowned data");
    const added = await cli("repo", "add", repo.tempRepo);
    if (process.platform === "win32") {
      expectCliCode(added, 1);
      expect(added.envelope.error).toMatchObject({ reason: "invalid-arguments", retryable: false });
      expect(added.envelope.error.message).toContain("UTF-8 bytes; maximum 220");
      expect(added.envelope.error.action).toContain("shorter user-owned");
      expect(paths.map((file) => readFileSync(file, "utf8"))).toEqual(bytes);
      expect(existsSync(localManagedRepoPath(home, repo.tempRemote))).toBe(false);
    } else expectCliSuccess(added);
    expect(readFileSync(sentinel, "utf8")).toBe("preserve unowned data");

    const shortHome = createTempDir();
    process.env.OUTPOST_HOME = shortHome;
    await cliSuccess("init");
    const configPath = path.join(shortHome, "config.json");
    const registryPath = path.join(shortHome, "repos.json");
    const before = [configPath, registryPath].map((file) => readFileSync(file, "utf8"));
    const deepTarget = path.join(outer, "canonical café ", "deep-".repeat(40));
    mkdirSync(deepTarget, { recursive: true });
    const junction = path.join(outer, "j");
    symlinkSync(deepTarget, junction, process.platform === "win32" ? "junction" : "dir");
    const set = await cli("config", "set", "worktreesRoot", path.join(junction, "missing"));
    if (process.platform === "win32") {
      expectCliCode(set, 1);
      expect(set.envelope.error.message).toContain(realpathSync.native(deepTarget));
      expect([configPath, registryPath].map((file) => readFileSync(file, "utf8"))).toEqual(before);
      expect(JSON.parse(before[0]).version).toBe(1);
      expect(existsSync(path.join(deepTarget, "missing"))).toBe(false);
    } else expectCliSuccess(set);
  });

  it("keeps unsupported existing history visible and refuses all affected mutations before changing any member", async () => {
    const { home, repo, id } = await fixture();
    const other = await createManagedRepoFixture({ defaultBranch: "main" });
    await cliSuccess("repo", "add", other.tempRepo);
    const otherId = localRepoId(other.tempRemote);
    await cliSuccess("create", ...createArgs("PRESERVE-1", otherId), "--repo", id);
    const registryPath = path.join(home, "repos.json");
    const registry = JSON.parse(readFileSync(registryPath, "utf8"));
    const records = registry.repositories ?? registry.repos;
    const oldRecord = records.find((record: { id: string }) => record.id === id);
    const originalManaged = oldRecord.managedRepoPath;
    const otherRecord = records.find((record: { id: string }) => record.id === otherId);
    // A fetch of the first member would visibly rewrite these unsafe legacy settings.
    fixtureGit([
      "--git-dir",
      otherRecord.managedRepoPath,
      "config",
      "--replace-all",
      "remote.origin.fetch",
      "+refs/*:refs/*",
    ]);
    fixtureGit([
      "--git-dir",
      otherRecord.managedRepoPath,
      "config",
      "remote.origin.mirror",
      "true",
    ]);

    const deepManaged = path.join(home, "repos", "deep-".repeat(35), "space café", "repo.git");
    cpSync(originalManaged, deepManaged, { recursive: true });
    oldRecord.managedRepoPath = deepManaged;
    // Put the unsupported member last to exercise fetch-all's complete preflight.
    registry[registry.version === undefined ? "repos" : "repositories"] = [
      ...records.filter((record: { id: string }) => record.id !== id),
      oldRecord,
    ];
    writeFileSync(registryPath, JSON.stringify(registry));
    const manifestPath = path.join(home, "workspaces", "PRESERVE-1.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const affectedMember = manifest.repositories.find((member: { id: string }) => member.id === id);
    affectedMember.managedPath = path.relative(path.join(home, "repos"), deepManaged);
    expect(manifest.repositories.at(-1).id).toBe(id);
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const agentsPath = path.join(home, "worktrees", "PRESERVE-1", "AGENTS.md");
    const sentinel = path.join(deepManaged, "sentinel.txt");
    writeFileSync(sentinel, "preserve branch history and user data");
    const preservedPaths = [
      path.join(home, "config.json"),
      registryPath,
      manifestPath,
      agentsPath,
      sentinel,
      path.join(deepManaged, "config"),
      path.join(deepManaged, "packed-refs"),
      path.join(deepManaged, "refs", "heads", "feat", "PRESERVE-1"),
      path.join(originalManaged, "config"),
      path.join(repo.tempRepo, ".git", "config"),
      path.join(otherRecord.managedRepoPath, "config"),
      path.join(otherRecord.managedRepoPath, "refs", "heads", "feat", "PRESERVE-1"),
      path.join(home, "worktrees", "PRESERVE-1", otherRecord.name, ".git"),
      path.join(home, "worktrees", "PRESERVE-1", otherRecord.name, "README.md"),
    ];
    const before = preservedPaths.map((file) => readFileSync(file, "utf8"));
    const branchBefore = fixtureGit(["--git-dir", originalManaged, "show-ref"], {
      encoding: "utf8",
    });
    expect(
      (await cliSuccess("repo", "list")).envelope.data.repos.some(
        (record: { id: string }) => record.id === id
      )
    ).toBe(true);
    expect(
      (await cliSuccess("workspace", "list")).envelope.data.workspaces.some(
        (workspace: { ticket: string }) => workspace.ticket === "PRESERVE-1"
      )
    ).toBe(true);
    expect((await cliSuccess("workspace", "show", "PRESERVE-1")).envelope.data.ticket).toBe(
      "PRESERVE-1"
    );
    if (process.platform === "win32") {
      for (const args of [
        ["repo", "add", repo.tempRepo],
        ["repo", "fetch", "--all"],
        ["create", ...createArgs("REFUSED-1", otherId), "--repo", id],
        ["repo", "remove", id],
        ["workspace", "remove", "PRESERVE-1"],
      ]) {
        const result = await cli(...args);
        expectCliCode(result, 1);
        expect(result.envelope.error).toMatchObject({
          reason: "invalid-arguments",
          retryable: false,
        });
        expect(result.envelope.error.message).toContain("maximum 220");
        expect(preservedPaths.map((file) => readFileSync(file, "utf8"))).toEqual(before);
      }
      expect(existsSync(path.join(home, "worktrees", "REFUSED-1"))).toBe(false);
      expect(existsSync(path.join(home, "workspaces", "REFUSED-1.json"))).toBe(false);
      expect(
        existsSync(path.join(otherRecord.managedRepoPath, "refs", "heads", "feat", "REFUSED-1"))
      ).toBe(false);
      expect(fixtureGit(["--git-dir", originalManaged, "show-ref"], { encoding: "utf8" })).toBe(
        branchBefore
      );
    } else {
      // Windows enforcement is covered with native processes in the Windows CI leg.
      // POSIX still proves the legacy metadata remains readable without migrating it.
      expect(preservedPaths.map((file) => readFileSync(file, "utf8"))).toEqual(before);
    }
    // Repair the future default without reinterpreting the unsupported old records.
    await cliSuccess("config", "set", "worktreesRoot", createTempDir());
    expect(preservedPaths.slice(2).map((file) => readFileSync(file, "utf8"))).toEqual(
      before.slice(2)
    );
    expect(
      (await cliSuccess("workspace", "show", "PRESERVE-1")).envelope.data.ticketDirectory
    ).toBe(path.join(home, "worktrees", "PRESERVE-1"));
    expect(
      (await cliSuccess("repo", "list")).envelope.data.repos.some(
        (record: { id: string }) => record.id === id
      )
    ).toBe(true);
  });

  it("refuses mutating Git from an unsupported canonical cwd while metadata remains available", async () => {
    const { home } = await fixture();
    const originalCwd = process.cwd();
    const outer = realpathSync.native(createTempDir());
    const prefix = path.join(outer, "cwd café ");
    const tooLongCwd = `${prefix}${"x".repeat(260 - prefix.length)}`;
    mkdirSync(tooLongCwd);
    const alias = path.join(outer, "cwd-alias");
    symlinkSync(tooLongCwd, alias, process.platform === "win32" ? "junction" : "dir");
    const files = [path.join(home, "config.json"), path.join(home, "repos.json")];
    const before = files.map((file) => readFileSync(file, "utf8"));
    try {
      process.chdir(alias);
      expect(realpathSync.native(process.cwd())).toBe(tooLongCwd);
      await cliSuccess("config", "show");
      const result = await cli("repo", "fetch", "--all");
      if (process.platform === "win32") {
        expectCliCode(result, 1);
        expect(result.envelope.error.message).toContain("260 UTF-16 code units; maximum 258");
        expect(result.envelope.error.action).toContain("current directory");
        expect(files.map((file) => readFileSync(file, "utf8"))).toEqual(before);
      } else expectCliSuccess(result);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("fetches a local remote after its original source checkout is removed", async () => {
    const { home, repo, id } = await fixture();
    rmSync(repo.tempRepo, { recursive: true });
    await cliSuccess("repo", "fetch", "--all");
    expect(readRegistry(home).repos.find((record) => record.id === id)?.sourceRepoPath).toBe(
      repo.tempRepo
    );
  });

  it("keeps legacy and newer workspace roots stable across repeated root changes, inspection and removal", async () => {
    const { home, repo, id } = await fixture();
    const initialCommit = fixtureGit(["-C", repo.tempRepo, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    expectCliSuccess(await cli("create", ...createArgs("OLD-1", id)));
    const manifestPath = path.join(home, "workspaces", "OLD-1.json");
    // Recreate actual unversioned metadata without v3 provenance, keeping the
    // original physical paths and generated guidance bytes for legacy inspection.
    const legacy = JSON.parse(readFileSync(manifestPath, "utf8"));
    delete legacy.version;
    delete legacy.worktreesRoot;
    for (const member of legacy.repositories)
      for (const key of ["baseSource", "requestedBase", "baseRef", "baseCommit"])
        delete member[key];
    writeFileSync(manifestPath, `${JSON.stringify(legacy)}\n`);
    const manifestBytes = readFileSync(manifestPath, "utf8");
    expect(JSON.parse(manifestBytes).version).toBeUndefined();
    const oldPath = path.join(home, "worktrees", "OLD-1");
    const agentsBytes = readFileSync(path.join(oldPath, "AGENTS.md"), "utf8");
    const requestedRootA = path.join(createTempDir(), "space café", "worktrees");
    const rootA = (await cliSuccess("config", "set", "worktreesRoot", requestedRootA)).envelope.data
      .value;
    expect(existsSync(rootA)).toBe(false);
    expectCliSuccess(await cli("create", ...createArgs("NEW-1", id)));
    const rootB = path.join(createTempDir(), "future");
    expectCliSuccess(await cli("config", "set", "worktreesRoot", rootB));
    expect(readFileSync(manifestPath, "utf8")).toBe(manifestBytes);
    expect(readFileSync(path.join(oldPath, "AGENTS.md"), "utf8")).toBe(agentsBytes);
    const old = await cliSuccess("workspace", "show", "OLD-1");
    expect(old.envelope.data).toMatchObject({ status: "ready", ticketDirectory: oldPath });
    expect((await cliSuccess("workspace", "show", "NEW-1")).envelope.data).toMatchObject({
      status: "ready",
      ticketDirectory: path.join(rootA, "NEW-1"),
    });
    expect(
      (await cliSuccess("workspace", "list")).envelope.data.workspaces.map(
        (entry: { status: string }) => entry.status
      )
    ).toEqual(["ready", "ready"]);
    expect((await cliSuccess("doctor")).envelope.data.unhealthyWorkspaceCount).toBe(0);
    const worktree = path.join(oldPath, path.basename(repo.tempRepo));
    writeFileSync(path.join(worktree, "uncommitted.txt"), "keep me");
    expectCliCode(await cli("workspace", "remove", "OLD-1"), 1);
    expect(existsSync(manifestPath)).toBe(true);
    rmSync(path.join(worktree, "uncommitted.txt"));
    expectCliSuccess(await cli("workspace", "remove", "OLD-1"));
    expect(existsSync(oldPath)).toBe(false);
    expect(existsSync(path.join(rootA, "NEW-1"))).toBe(true);
    const managed = readRegistry(home).repos[0].managedRepoPath;
    expect(
      fixtureGit(["--git-dir", managed, "rev-parse", "refs/heads/feat/OLD-1"], {
        encoding: "utf8",
      }).trim()
    ).toBe(initialCommit);
  });

  it("keeps unmanaged directories at previous roots visible without adopting them", async () => {
    const { home } = await fixture();
    const leftover = path.join(home, "worktrees", "FAILED-1");
    mkdirSync(leftover);
    writeFileSync(path.join(leftover, "keep.txt"), "unowned data");
    expectCliSuccess(await cli("config", "set", "worktreesRoot", createTempDir()));
    expect((await cliSuccess("workspace", "list")).envelope.data.workspaces).toEqual([
      expect.objectContaining({
        ticket: "FAILED-1",
        ticketDirectory: leftover,
        status: "unmanaged",
      }),
    ]);
    expect((await cliSuccess("workspace", "show", "FAILED-1")).envelope.data.status).toBe(
      "unmanaged"
    );
    expectCliCode(await cli("workspace", "remove", "FAILED-1"), 1);
    expect(readFileSync(path.join(leftover, "keep.txt"), "utf8")).toBe("unowned data");
  });

  it("reports unowned same-ticket directories at another root and preserves them on removal", async () => {
    const { home, id } = await fixture();
    expectCliSuccess(await cli("create", ...createArgs("SAME-1", id)));
    const nextRoot = (await cliSuccess("config", "set", "worktreesRoot", createTempDir())).envelope
      .data.value;
    const leftover = path.join(nextRoot, "SAME-1");
    mkdirSync(leftover);
    writeFileSync(path.join(leftover, "sentinel.txt"), "unowned data");
    const entries = (await cliSuccess("workspace", "list")).envelope.data.workspaces;
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ticket: "SAME-1",
          ticketDirectory: path.join(home, "worktrees", "SAME-1"),
          status: "ready",
        }),
        expect.objectContaining({
          ticket: "SAME-1",
          ticketDirectory: leftover,
          status: "unmanaged",
        }),
      ])
    );
    expectCliSuccess(await cli("workspace", "remove", "SAME-1"));
    expect(readFileSync(path.join(leftover, "sentinel.txt"), "utf8")).toBe("unowned data");
  });

  it("filters tag intersections, keeps explicit IDs, freezes membership and preserves tags on fetch/reimport", async () => {
    const { home, repo, id } = await fixture();
    const beta = await createManagedRepoFixture({ defaultBranch: "main" });
    await cliSuccess("repo", "add", beta.tempRepo);
    const betaId = localRepoId(beta.tempRemote);
    expect(
      (await cliSuccess("repo", "tag", id, "--add", "frontend", "--add", "shared")).envelope.data
        .tags
    ).toEqual(["frontend", "shared"]);
    await cliSuccess("repo", "tag", betaId, "--add", "shared");
    const filtered = await cliSuccess("repo", "list", "--tag", "shared", "--tag", "frontend");
    expect(filtered.envelope.data.repos.map((repo: { id: string }) => repo.id)).toEqual([id]);
    expectCliSuccess(
      await cli(
        "create",
        "--ticket",
        "TAG-1",
        "--type",
        "feat",
        "--tag",
        "shared",
        "--tag",
        "frontend"
      )
    );
    const manifestPath = path.join(home, "workspaces", "TAG-1.json");
    const before = readFileSync(manifestPath, "utf8");
    expect(JSON.parse(before).repositories.map((repo: { id: string }) => repo.id)).toEqual([id]);
    await cliSuccess("repo", "tag", id, "--remove", "shared");
    await cliSuccess("repo", "tag", betaId, "--add", "frontend");
    expect(readFileSync(manifestPath, "utf8")).toBe(before);
    expectCliCode(
      await cli("create", ...createArgs("EXPLICIT-1", id), "--tag", "shared", "--dry-run"),
      1
    );
    expectCliCode(
      await cli("create", "--ticket", "EMPTY-1", "--type", "feat", "--tag", "unknown"),
      1
    );
    expectCliSuccess(await cli("repo", "fetch", "--all"));
    expectCliSuccess(await cli("repo", "add", repo.tempRepo));
    expect(readRegistry(home).repos.find((repo) => repo.id === id)?.tags).toEqual(["frontend"]);
    expectCliCode(await cli("repo", "tag", id, "--add", "Bad/Tag"), 1);
  });

  it("previews the exact factual guidance without creating files and changes only future workspaces", async () => {
    const { home, id } = await fixture();
    const instructions = path.join(createTempDir(), "instructions.txt");
    writeFileSync(instructions, "Use the team conventions.\nDo not run a release.\n");
    expectCliSuccess(await cli("guidance", "set", instructions));
    const before = readdirSync(home).sort();
    const preview = await cliSuccess("guidance", "preview", ...createArgs("GUIDE-1", id));
    expect(preview.envelope.data.content).toContain(`id: ${JSON.stringify(id)}`);
    expect(preview.envelope.data.content).toContain(
      "## Additional Instructions\n\nUse the team conventions."
    );
    expect(readdirSync(home).sort()).toEqual(before);
    expect(existsSync(path.join(home, "worktrees", "GUIDE-1"))).toBe(false);
    expectCliSuccess(await cli("create", ...createArgs("GUIDE-1", id)));
    const agentsPath = path.join(home, "worktrees", "GUIDE-1", "AGENTS.md");
    expect(readFileSync(agentsPath, "utf8")).toBe(preview.envelope.data.content);
    expect(
      (
        await Effect.runPromise(
          classifyAgentsOwnership(agentsPath).pipe(Effect.provide(NodeServices.layer))
        )
      ).ownership
    ).toBe("generated");
    expectCliSuccess(await cli("guidance", "clear"));
    expect(readFileSync(agentsPath, "utf8")).toBe(preview.envelope.data.content);
    expect(
      (await cliSuccess("guidance", "preview", ...createArgs("GUIDE-2", id))).envelope.data.content
    ).not.toContain("## Additional Instructions");
  });

  it("rejects malformed or oversized guidance before changing settings", async () => {
    const { home } = await fixture();
    const configBefore = readFileSync(path.join(home, "config.json"), "utf8");
    const file = path.join(createTempDir(), "bad.txt");
    for (const bytes of [
      Buffer.from([0xff, 0xfe]),
      Buffer.from("bad\0text"),
      Buffer.alloc(65537, 65),
    ]) {
      writeFileSync(file, bytes);
      expectCliCode(await cli("guidance", "set", file), 1);
      expect(readFileSync(path.join(home, "config.json"), "utf8")).toBe(configBefore);
    }
  });

  it("rejects unsafe root overlaps, files and relative roots without changing config", async () => {
    const { home } = await fixture();
    const before = readFileSync(path.join(home, "config.json"), "utf8");
    for (const target of [
      path.parse(home).root,
      home,
      path.dirname(home),
      path.join(home, "repos", "nested"),
      path.join(home, "workspaces", "nested"),
      path.join(home, "operations"),
      path.join(home, "worktrees", "nested"),
      path.join(home, "config.json"),
      "relative",
      "C:relative",
    ]) {
      expectCliCode(await cli("config", "set", "worktreesRoot", target), 1);
      expect(readFileSync(path.join(home, "config.json"), "utf8")).toBe(before);
    }
  });

  it("rejects a missing root under a junction or symlink into managed state", async () => {
    const { home } = await fixture();
    const linkPath = path.join(createTempDir(), "alias");
    symlinkSync(
      path.join(home, "repos"),
      linkPath,
      process.platform === "win32" ? "junction" : "dir"
    );
    const before = readFileSync(path.join(home, "config.json"), "utf8");
    expectCliCode(
      await cli("config", "set", "worktreesRoot", path.join(linkPath, "missing", "nested")),
      1
    );
    expect(readFileSync(path.join(home, "config.json"), "utf8")).toBe(before);
  });

  it("refuses future/unknown schemas and untrusted manifest roots without destructive writes", async () => {
    const { home, id } = await fixture();
    await cliSuccess("create", ...createArgs("SCHEMA-1", id));
    const configPath = path.join(home, "config.json");
    const registryPath = path.join(home, "repos.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    const registry = readFileSync(registryPath, "utf8");
    for (const changed of [
      { ...config, version: 4 },
      { ...config, version: "2" },
      { ...config, version: null },
      { ...config, futureOption: true },
    ]) {
      const bytes = JSON.stringify(changed);
      writeFileSync(configPath, bytes);
      expectCliCode(await cli("repo", "tag", id, "--add", "safe"), 1);
      expect(readFileSync(configPath, "utf8")).toBe(bytes);
      expect(readFileSync(registryPath, "utf8")).toBe(registry);
    }
    writeFileSync(configPath, JSON.stringify(config));
    writeFileSync(registryPath, JSON.stringify({ ...JSON.parse(registry), version: 4 }));
    expectCliCode(await cli("repo", "tag", id, "--add", "safe"), 1);
    writeFileSync(registryPath, registry);
    const manifestPath = path.join(home, "workspaces", "SCHEMA-1.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    for (const changed of [
      { ...manifest, version: 4 },
      { ...manifest, futureOption: true },
      { ...manifest, version: 2, worktreesRoot: createTempDir() },
    ]) {
      const bytes = JSON.stringify(changed);
      writeFileSync(manifestPath, bytes);
      expectCliCode(await cli("workspace", "remove", "SCHEMA-1"), 1);
      expect(readFileSync(manifestPath, "utf8")).toBe(bytes);
      expect(existsSync(path.join(home, "worktrees", "SCHEMA-1", "AGENTS.md"))).toBe(true);
    }
  });

  it("serializes new settings and tagging operations with the home mutation lock", async () => {
    const { home, id } = await fixture();
    const before = readFileSync(path.join(home, "config.json"), "utf8");
    writeFileSync(path.join(home, ".mutation.lock"), "another owner");
    for (const args of [
      ["config", "set", "worktreesRoot", createTempDir()],
      ["repo", "tag", id, "--add", "blocked"],
      ["guidance", "clear"],
    ]) {
      const result = await cli(...args);
      expectCliCode(result, 1);
      expect(result.envelope.error.reason).toBe("lock-held");
      expect(readFileSync(path.join(home, "config.json"), "utf8")).toBe(before);
    }
    expect(readFileSync(path.join(home, ".mutation.lock"), "utf8")).toBe("another owner");
  });

  it.each(["root", "guidance"])(
    "installs an incompatible registry before committing %s settings",
    async (setting) => {
      const { home } = await fixture();
      const configPath = path.join(home, "config.json");
      const registryPath = path.join(home, "repos.json");
      const original = JSON.parse(readFileSync(configPath, "utf8"));
      expectCliSuccess(
        await cli(
          ...(setting === "root"
            ? ["config", "set", "worktreesRoot", createTempDir()]
            : ["guidance", "clear"])
        )
      );
      const raw = JSON.parse(readFileSync(registryPath, "utf8"));
      expect(raw).toMatchObject({ version: 2, repositories: expect.any(Array) });
      expect(raw).not.toHaveProperty("repos");
      // This is the legacy loader's required shape; unknown fields were silently ignored.
      const oldLoader = Schema.Struct({ repos: Schema.Array(Schema.Unknown) });
      await expect(Effect.runPromise(Schema.decodeUnknownEffect(oldLoader)(raw))).rejects.toThrow();
      expect(JSON.parse(readFileSync(configPath, "utf8")).legacyWorktreesRoot).toBe(
        original.worktreesRoot
      );
    }
  );

  it.each(["root", "guidance"])(
    "leaves original defaults after an interrupted %s registry upgrade and repairs forward",
    async (setting) => {
      const { home } = await fixture();
      const configPath = path.join(home, "config.json");
      const registryPath = path.join(home, "repos.json");
      const original = JSON.parse(readFileSync(configPath, "utf8"));
      const registryBytes = readFileSync(registryPath, "utf8");
      const root = path.join(createTempDir(), "new");
      const instructionsPath = path.join(createTempDir(), "instructions.txt");
      writeFileSync(instructionsPath, "Future instructions");
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const failing: FileSystem.FileSystem = {
            ...fs,
            rename: (from, to) =>
              to === registryPath
                ? fs.rename(path.join(home, "nonexistent"), to)
                : fs.rename(from, to),
          };
          const operation =
            setting === "root"
              ? runConfigSet("worktreesRoot", root).pipe(Effect.asVoid)
              : runGuidanceSet(instructionsPath).pipe(Effect.asVoid);
          return yield* Effect.exit(
            operation.pipe(Effect.provideService(FileSystem.FileSystem, failing))
          );
        }).pipe(Effect.provide(NodeServices.layer))
      );
      expect(Exit.isFailure(result)).toBe(true);
      expect(JSON.parse(readFileSync(configPath, "utf8"))).toMatchObject({
        version: 2,
        worktreesRoot: original.worktreesRoot,
        legacyWorktreesRoot: original.worktreesRoot,
        extraInstructions: "",
      });
      expect(readFileSync(registryPath, "utf8")).toBe(registryBytes);
      expect(existsSync(path.join(home, ".mutation.lock"))).toBe(false);
      const retried = await cliSuccess(
        ...(setting === "root"
          ? ["config", "set", "worktreesRoot", root]
          : ["guidance", "set", instructionsPath])
      );
      expect(JSON.parse(readFileSync(registryPath, "utf8"))).toMatchObject({
        version: 2,
        repositories: expect.any(Array),
      });
      expect(JSON.parse(readFileSync(configPath, "utf8"))).toMatchObject(
        setting === "root"
          ? { worktreesRoot: retried.envelope.data.value }
          : { extraInstructions: "Future instructions" }
      );
    }
  );

  it("refuses init with migrated registry but missing configuration instead of resetting root identity", async () => {
    const { home } = await fixture();
    await cliSuccess("config", "set", "worktreesRoot", createTempDir());
    const registryPath = path.join(home, "repos.json");
    const before = readFileSync(registryPath, "utf8");
    rmSync(path.join(home, "config.json"));
    const result = await cli("init");
    expectCliCode(result, 1);
    expect(result.envelope.error.message).toContain("version 2 registry remains");
    expect(existsSync(path.join(home, "config.json"))).toBe(false);
    expect(readFileSync(registryPath, "utf8")).toBe(before);
  });

  it("rejects new Windows-invalid folder names before branch/worktree mutation", async () => {
    const { home, id } = await fixture();
    for (const ticket of ["CON", "nul.txt", "LPT1", "COM¹", "bad:name", "tail.", "tail "]) {
      expectCliCode(await cli("create", ...createArgs(ticket, id)), 1);
    }
    expect(readdirSync(path.join(home, "workspaces"))).toEqual([]);
  });
});

describe("Windows root syntax without filesystem/network access", () => {
  it.each(["C:relative", "relative", "\\rooted", "/rooted"])("refuses %s", async (value) => {
    await expect(
      Effect.runPromise(validateWorktreesRootInput(value).pipe(Effect.provide(NodePath.layerWin32)))
    ).rejects.toThrow();
  });
  it.each([
    "C:\\Users\\Agent\\workspace café",
    "D:/spaces/worktrees",
    "\\\\fixture.invalid\\share\\worktrees",
  ])("accepts absolute syntax %s", async (value) => {
    await expect(
      Effect.runPromise(validateWorktreesRootInput(value).pipe(Effect.provide(NodePath.layerWin32)))
    ).resolves.toBeUndefined();
  });
});
