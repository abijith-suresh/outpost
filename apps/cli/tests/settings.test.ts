import { execFileSync } from "node:child_process";
import { readdirSync, rmSync, symlinkSync } from "node:fs";
import { NodePath, NodeServices } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vitest";
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

async function cli(...args: string[]) {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  log.mockClear();
  error.mockClear();
  const code = await runCli([...args, "--json"]);
  return { code, envelope: JSON.parse(String((code ? error : log).mock.calls.at(-1)?.[0])) };
}
async function fixture() {
  const home = createTempDir();
  process.env.OUTPOST_HOME = home;
  expect((await cli("init")).code).toBe(0);
  const repo = await createManagedRepoFixture({ defaultBranch: "main" });
  expect((await cli("repo", "add", repo.tempRepo)).code).toBe(0);
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
  it("keeps legacy and newer workspace roots stable across repeated root changes, inspection and removal", async () => {
    const { home, repo, id } = await fixture();
    expect((await cli("create", ...createArgs("OLD-1", id))).code).toBe(0);
    const manifestPath = path.join(home, "workspaces", "OLD-1.json");
    const manifestBytes = readFileSync(manifestPath, "utf8");
    expect(JSON.parse(manifestBytes).version).toBeUndefined();
    const oldPath = path.join(home, "worktrees", "OLD-1");
    const agentsBytes = readFileSync(path.join(oldPath, "AGENTS.md"), "utf8");
    const rootA = path.join(createTempDir(), "space café", "worktrees");
    expect((await cli("config", "set", "worktreesRoot", rootA)).code).toBe(0);
    expect(existsSync(rootA)).toBe(false);
    expect((await cli("create", ...createArgs("NEW-1", id))).code).toBe(0);
    const rootB = path.join(createTempDir(), "future");
    expect((await cli("config", "set", "worktreesRoot", rootB)).code).toBe(0);
    expect(readFileSync(manifestPath, "utf8")).toBe(manifestBytes);
    expect(readFileSync(path.join(oldPath, "AGENTS.md"), "utf8")).toBe(agentsBytes);
    const old = await cli("workspace", "show", "OLD-1");
    expect(old.envelope.data).toMatchObject({ status: "ready", ticketDirectory: oldPath });
    expect((await cli("workspace", "show", "NEW-1")).envelope.data).toMatchObject({
      status: "ready",
      ticketDirectory: path.join(rootA, "NEW-1"),
    });
    expect(
      (await cli("workspace", "list")).envelope.data.workspaces.map(
        (entry: { status: string }) => entry.status
      )
    ).toEqual(["ready", "ready"]);
    expect((await cli("doctor")).envelope.data.unhealthyWorkspaceCount).toBe(0);
    const worktree = path.join(oldPath, path.basename(repo.tempRepo));
    writeFileSync(path.join(worktree, "uncommitted.txt"), "keep me");
    expect((await cli("workspace", "remove", "OLD-1")).code).toBe(1);
    expect(existsSync(manifestPath)).toBe(true);
    rmSync(path.join(worktree, "uncommitted.txt"));
    expect((await cli("workspace", "remove", "OLD-1")).code).toBe(0);
    expect(existsSync(oldPath)).toBe(false);
    expect(existsSync(path.join(rootA, "NEW-1"))).toBe(true);
    const managed = readRegistry(home).repos[0].managedRepoPath;
    expect(
      execFileSync("git", ["--git-dir", managed, "rev-parse", "refs/heads/feat/OLD-1"], {
        encoding: "utf8",
      }).trim()
    ).toMatch(/^[a-f0-9]{40}$/);
  });

  it("keeps unmanaged directories at previous roots visible without adopting them", async () => {
    const { home } = await fixture();
    const leftover = path.join(home, "worktrees", "FAILED-1");
    mkdirSync(leftover);
    writeFileSync(path.join(leftover, "keep.txt"), "unowned data");
    expect((await cli("config", "set", "worktreesRoot", createTempDir())).code).toBe(0);
    expect((await cli("workspace", "list")).envelope.data.workspaces).toEqual([
      expect.objectContaining({
        ticket: "FAILED-1",
        ticketDirectory: leftover,
        status: "unmanaged",
      }),
    ]);
    expect((await cli("workspace", "show", "FAILED-1")).envelope.data.status).toBe("unmanaged");
    expect((await cli("workspace", "remove", "FAILED-1")).code).toBe(1);
    expect(readFileSync(path.join(leftover, "keep.txt"), "utf8")).toBe("unowned data");
  });

  it("reports unowned same-ticket directories at another root and preserves them on removal", async () => {
    const { home, id } = await fixture();
    expect((await cli("create", ...createArgs("SAME-1", id))).code).toBe(0);
    const nextRoot = createTempDir();
    expect((await cli("config", "set", "worktreesRoot", nextRoot)).code).toBe(0);
    const leftover = path.join(nextRoot, "SAME-1");
    mkdirSync(leftover);
    writeFileSync(path.join(leftover, "sentinel.txt"), "unowned data");
    const entries = (await cli("workspace", "list")).envelope.data.workspaces;
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
    expect((await cli("workspace", "remove", "SAME-1")).code).toBe(0);
    expect(readFileSync(path.join(leftover, "sentinel.txt"), "utf8")).toBe("unowned data");
  });

  it("filters tag intersections, keeps explicit IDs, freezes membership and preserves tags on fetch/reimport", async () => {
    const { home, repo, id } = await fixture();
    const beta = await createManagedRepoFixture({ defaultBranch: "main" });
    await cli("repo", "add", beta.tempRepo);
    const betaId = localRepoId(beta.tempRemote);
    expect(
      (await cli("repo", "tag", id, "--add", "frontend", "--add", "shared")).envelope.data.tags
    ).toEqual(["frontend", "shared"]);
    await cli("repo", "tag", betaId, "--add", "shared");
    const filtered = await cli("repo", "list", "--tag", "shared", "--tag", "frontend");
    expect(filtered.envelope.data.repos.map((repo: { id: string }) => repo.id)).toEqual([id]);
    expect(
      (
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
      ).code
    ).toBe(0);
    const manifestPath = path.join(home, "workspaces", "TAG-1.json");
    const before = readFileSync(manifestPath, "utf8");
    expect(JSON.parse(before).repositories.map((repo: { id: string }) => repo.id)).toEqual([id]);
    await cli("repo", "tag", id, "--remove", "shared");
    await cli("repo", "tag", betaId, "--add", "frontend");
    expect(readFileSync(manifestPath, "utf8")).toBe(before);
    expect(
      (await cli("create", ...createArgs("EXPLICIT-1", id), "--tag", "shared", "--dry-run")).code
    ).toBe(1);
    expect(
      (await cli("create", "--ticket", "EMPTY-1", "--type", "feat", "--tag", "unknown")).code
    ).toBe(1);
    expect((await cli("repo", "fetch", "--all")).code).toBe(0);
    expect((await cli("repo", "add", repo.tempRepo)).code).toBe(0);
    expect(readRegistry(home).repos.find((repo) => repo.id === id)?.tags).toEqual(["frontend"]);
    expect((await cli("repo", "tag", id, "--add", "Bad/Tag")).code).toBe(1);
  });

  it("previews the exact factual guidance without creating files and changes only future workspaces", async () => {
    const { home, id } = await fixture();
    const instructions = path.join(createTempDir(), "instructions.txt");
    writeFileSync(instructions, "Use the team conventions.\nDo not run a release.\n");
    expect((await cli("guidance", "set", instructions)).code).toBe(0);
    const before = readdirSync(home).sort();
    const preview = await cli("guidance", "preview", ...createArgs("GUIDE-1", id));
    expect(preview.code).toBe(0);
    expect(preview.envelope.data.content).toContain(`id: ${JSON.stringify(id)}`);
    expect(preview.envelope.data.content).toContain(
      "## Additional Instructions\n\nUse the team conventions."
    );
    expect(readdirSync(home).sort()).toEqual(before);
    expect(existsSync(path.join(home, "worktrees", "GUIDE-1"))).toBe(false);
    expect((await cli("create", ...createArgs("GUIDE-1", id))).code).toBe(0);
    const agentsPath = path.join(home, "worktrees", "GUIDE-1", "AGENTS.md");
    expect(readFileSync(agentsPath, "utf8")).toBe(preview.envelope.data.content);
    expect(
      (
        await Effect.runPromise(
          classifyAgentsOwnership(agentsPath).pipe(Effect.provide(NodeServices.layer))
        )
      ).ownership
    ).toBe("generated");
    expect((await cli("guidance", "clear")).code).toBe(0);
    expect(readFileSync(agentsPath, "utf8")).toBe(preview.envelope.data.content);
    expect(
      (await cli("guidance", "preview", ...createArgs("GUIDE-2", id))).envelope.data.content
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
      expect((await cli("guidance", "set", file)).code).toBe(1);
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
      expect((await cli("config", "set", "worktreesRoot", target)).code).toBe(1);
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
    expect(
      (await cli("config", "set", "worktreesRoot", path.join(linkPath, "missing", "nested"))).code
    ).toBe(1);
    expect(readFileSync(path.join(home, "config.json"), "utf8")).toBe(before);
  });

  it("refuses future/unknown schemas and untrusted manifest roots without destructive writes", async () => {
    const { home, id } = await fixture();
    await cli("create", ...createArgs("SCHEMA-1", id));
    const configPath = path.join(home, "config.json");
    const registryPath = path.join(home, "repos.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    const registry = readFileSync(registryPath, "utf8");
    for (const changed of [
      { ...config, version: 3 },
      { ...config, version: "2" },
      { ...config, version: null },
      { ...config, futureOption: true },
    ]) {
      const bytes = JSON.stringify(changed);
      writeFileSync(configPath, bytes);
      expect((await cli("repo", "tag", id, "--add", "safe")).code).toBe(1);
      expect(readFileSync(configPath, "utf8")).toBe(bytes);
      expect(readFileSync(registryPath, "utf8")).toBe(registry);
    }
    writeFileSync(configPath, JSON.stringify(config));
    writeFileSync(registryPath, JSON.stringify({ ...JSON.parse(registry), version: 3 }));
    expect((await cli("repo", "tag", id, "--add", "safe")).code).toBe(1);
    writeFileSync(registryPath, registry);
    const manifestPath = path.join(home, "workspaces", "SCHEMA-1.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    for (const changed of [
      { ...manifest, version: 3 },
      { ...manifest, futureOption: true },
      { ...manifest, version: 2, worktreesRoot: createTempDir() },
    ]) {
      const bytes = JSON.stringify(changed);
      writeFileSync(manifestPath, bytes);
      expect((await cli("workspace", "remove", "SCHEMA-1")).code).toBe(1);
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
      expect(result.code).toBe(1);
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
      expect(
        (
          await cli(
            ...(setting === "root"
              ? ["config", "set", "worktreesRoot", createTempDir()]
              : ["guidance", "clear"])
          )
        ).code
      ).toBe(0);
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
      expect(
        (
          await cli(
            ...(setting === "root"
              ? ["config", "set", "worktreesRoot", root]
              : ["guidance", "set", instructionsPath])
          )
        ).code
      ).toBe(0);
      expect(JSON.parse(readFileSync(registryPath, "utf8"))).toMatchObject({
        version: 2,
        repositories: expect.any(Array),
      });
      expect(JSON.parse(readFileSync(configPath, "utf8"))).toMatchObject(
        setting === "root" ? { worktreesRoot: root } : { extraInstructions: "Future instructions" }
      );
    }
  );

  it("refuses init with migrated registry but missing configuration instead of resetting root identity", async () => {
    const { home } = await fixture();
    await cli("config", "set", "worktreesRoot", createTempDir());
    const registryPath = path.join(home, "repos.json");
    const before = readFileSync(registryPath, "utf8");
    rmSync(path.join(home, "config.json"));
    const result = await cli("init");
    expect(result.code).toBe(1);
    expect(result.envelope.error.message).toContain("version 2 registry remains");
    expect(existsSync(path.join(home, "config.json"))).toBe(false);
    expect(readFileSync(registryPath, "utf8")).toBe(before);
  });

  it("rejects new Windows-invalid folder names before branch/worktree mutation", async () => {
    const { home, id } = await fixture();
    for (const ticket of ["CON", "nul.txt", "LPT1", "COM¹", "bad:name", "tail.", "tail "]) {
      expect((await cli("create", ...createArgs(ticket, id))).code).toBe(1);
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
