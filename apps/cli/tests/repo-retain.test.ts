import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync, realpathSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { NodeServices } from "@effect/platform-node";
import { Effect, Fiber } from "effect";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vitest";
import { runRepoRemove } from "../src/commands/repo-remove.ts";
import { runRepoRestore } from "../src/commands/repo-restore.ts";
import { RepoRecordSchema } from "../src/config.ts";
import * as Store from "../src/store.ts";
import {
  createManagedRepoFixture,
  createTempDir,
  existsSync,
  mkdirSync,
  path,
  readFileSync,
  readRegistry,
  runCli,
  setupAfterEach,
  writeFileSync,
} from "./helpers.ts";

setupAfterEach();
function git(args: string[]) {
  return execFileSync(
    "git",
    process.platform === "win32" ? ["-c", "core.longpaths=true", ...args] : args,
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  ).trim();
}
async function cli(...args: string[]) {
  const out = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
  out.mockClear();
  err.mockClear();
  const code = await runCli([...args, "--json"]);
  const stdout = out.mock.calls.map((call) => String(call[0])).join("\n");
  const stderr = err.mock.calls.map((call) => String(call[0])).join("\n");
  const diagnostics = JSON.stringify({ args, code, stdout, stderr }, null, 2);
  let envelope: ReturnType<typeof JSON.parse>;
  try {
    envelope = JSON.parse(stderr || stdout);
  } catch {
    throw new Error(diagnostics);
  }
  return { code, envelope, diagnostics };
}
async function success(...args: string[]) {
  const result = await cli(...args);
  expect(result.code, result.diagnostics).toBe(0);
  expect(result.envelope.ok, result.diagnostics).toBe(true);
  return result.envelope.data;
}
async function failure(...args: string[]) {
  const result = await cli(...args);
  expect(result.code, result.diagnostics).toBe(1);
  return result.envelope.error;
}
function registry(home: string) {
  return JSON.parse(readFileSync(path.join(home, "repos.json"), "utf8"));
}
function refs(managed: string) {
  return git(["--git-dir", managed, "for-each-ref", "--format=%(refname)%09%(objectname)"]);
}
async function fixture(repoName?: string, canonicalHome = false) {
  const createdHome = createTempDir("op-r-");
  const home = canonicalHome ? realpathSync.native(createdHome) : createdHome;
  process.env.OUTPOST_HOME = home;
  await success("init");
  const source = await createManagedRepoFixture({ defaultBranch: "main", repoName });
  // This source-only commit must remain untouched even though mirror import
  // intentionally reads the selected remote instead of copying source objects.
  writeFileSync(path.join(source.tempRepo, "source-only.txt"), "source-only\n");
  git(["-C", source.tempRepo, "add", "."]);
  git(["-C", source.tempRepo, "commit", "-m", "source-only"]);
  const sourceSha = git(["-C", source.tempRepo, "rev-parse", "HEAD"]);
  await success("repo", "add", source.tempRepo);
  const repo = readRegistry(home).repos[0];
  return { home, source, repo, sourceSha };
}
async function branchFixture(repoName?: string, canonicalHome = false) {
  const f = await fixture(repoName, canonicalHome);
  await success("repo", "tag", f.repo.id, "--add", "keep");
  const created = await success(
    "create",
    "--ticket",
    "KEEP-1",
    "--type",
    "feat",
    "--repo",
    f.repo.id
  );
  const checkout = created.worktrees[0].path;
  git(["-C", checkout, "config", "user.name", "Outpost Fixture"]);
  git(["-C", checkout, "config", "user.email", "fixture@example.invalid"]);
  writeFileSync(path.join(checkout, "branch-only.txt"), "unique work\n");
  git(["-C", checkout, "add", "."]);
  git(["-C", checkout, "commit", "-m", "branch-only"]);
  const sha = git(["-C", checkout, "rev-parse", "HEAD"]);
  expect(git(["-C", checkout, "status", "--porcelain"])).toBe("");
  for (const location of [f.source.tempRepo, f.source.tempRemote])
    expect(
      spawnSync("git", ["-C", location, "cat-file", "-e", `${sha}^{commit}`], { encoding: "utf8" })
        .status
    ).not.toBe(0);
  await success("workspace", "remove", "KEEP-1");
  expect(git(["--git-dir", f.repo.managedRepoPath, "rev-parse", "refs/heads/feat/KEEP-1"])).toBe(
    sha
  );
  return { ...f, repo: readRegistry(f.home).repos[0], sha };
}
function expectSha(f: Awaited<ReturnType<typeof branchFixture>>) {
  expect(git(["--git-dir", f.repo.managedRepoPath, "rev-parse", "refs/heads/feat/KEEP-1"])).toBe(
    f.sha
  );
  expect(git(["--git-dir", f.repo.managedRepoPath, "cat-file", "-t", f.sha])).toBe("commit");
  expect(git(["-C", f.source.tempRepo, "rev-parse", "HEAD"])).toBe(f.sourceSha);
}

describe("retained repository registration lifecycle", () => {
  it("preserves exact branch-only and source-only SHAs through unregister, inspect and offline restore", async () => {
    const f = await branchFixture();
    const before = refs(f.repo.managedRepoPath);
    const gitConfig = readFileSync(path.join(f.repo.managedRepoPath, "config"), "utf8");
    const preview = await success("repo", "remove", f.repo.id, "--dry-run");
    expect(preview.action).toBe("unregistered");
    expect(preview.storage).toBe("retained");
    expect(registry(f.home).repositories).toHaveLength(1);
    const removed = await success("repo", "remove", f.repo.id);
    expect(removed.action).toBe("unregistered");
    expect(removed.storage).toBe("retained");
    expect(removed.recoveryCommand).toContain("repo restore");
    expectSha(f);
    const stored = registry(f.home);
    expect(stored.version).toBe(3);
    expect(stored.repositories).toEqual([]);
    expect(stored.retainedRepositories).toEqual([{ ...f.repo, retainedAt: removed.retainedAt }]);
    expect((await success("repo", "list")).repos).toEqual([]);
    expect((await success("repo", "list", "--retained", "--tag", "keep")).repos).toEqual([
      { ...f.repo, retainedAt: removed.retainedAt, status: "ok" },
    ]);
    await failure("repo", "show", f.repo.id);
    const shown = await success("repo", "show", f.repo.id, "--retained");
    expect(shown.inspection.status).toBe("ok");
    expect(shown.inspection.refs).toContainEqual({
      name: "refs/heads/feat/KEEP-1",
      objectId: f.sha,
    });
    expect((await failure("repo", "add", f.source.tempRepo)).message).toContain("repo restore");
    expect(refs(f.repo.managedRepoPath)).toBe(before);
    expect(readFileSync(path.join(f.repo.managedRepoPath, "config"), "utf8")).toBe(gitConfig);
    expect((await success("repo", "fetch", "--all")).repoCount).toBe(0);
    await failure("create", "--ticket", "EXCLUDED", "--type", "feat", "--repo", f.repo.id);
    expect(existsSync(path.join(f.home, "worktrees", "EXCLUDED"))).toBe(false);
    renameSync(f.source.tempRepo, `${f.source.tempRepo}-offline`);
    renameSync(f.source.tempRemote, `${f.source.tempRemote}-offline`);
    try {
      const bytes = readFileSync(path.join(f.home, "repos.json"), "utf8");
      expect((await success("repo", "restore", f.repo.id, "--dry-run")).dryRun).toBe(true);
      expect(readFileSync(path.join(f.home, "repos.json"), "utf8")).toBe(bytes);
      await success("repo", "restore", f.repo.id);
      expect(readRegistry(f.home).repos).toEqual([f.repo]);
      expect(registry(f.home).retainedRepositories).toEqual([]);
      expect(refs(f.repo.managedRepoPath)).toBe(before);
      expect(readFileSync(path.join(f.repo.managedRepoPath, "config"), "utf8")).toBe(gitConfig);
      expect(
        git(["--git-dir", f.repo.managedRepoPath, "rev-parse", "refs/heads/feat/KEEP-1"])
      ).toBe(f.sha);
    } finally {
      renameSync(`${f.source.tempRepo}-offline`, f.source.tempRepo);
      renameSync(`${f.source.tempRemote}-offline`, f.source.tempRemote);
    }
    expectSha(f);
  });

  it("keeps recovery hints literal when a repository identity contains shell metacharacters", async () => {
    const f = await branchFixture("$(literal)");
    expect(f.repo.id).toContain("$(literal)");
    const before = refs(f.repo.managedRepoPath);
    const removed = await success("repo", "remove", f.repo.id);
    expect(removed.id).toBe(f.repo.id);
    expect(removed.recoveryCommand).toBe("outpost repo restore <id>");
    const error = await failure("repo", "add", f.source.tempRepo);
    expect(error.message).toBe(
      `Repository ${f.repo.id} has retained storage. Inspect it with outpost repo show <id> --retained and use outpost repo restore <id>. Import will not adopt or overwrite it.`
    );
    expect(refs(f.repo.managedRepoPath)).toBe(before);
    expectSha(f);
    await success("repo", "restore", f.repo.id);
    expect(refs(f.repo.managedRepoPath)).toBe(before);
    expectSha(f);
  });

  it("preserves v3 retained records through root, guidance, tag and subsequent import mutations", async () => {
    const f = await branchFixture();
    await success("repo", "remove", f.repo.id);
    const retained = registry(f.home).retainedRepositories;
    const other = await createManagedRepoFixture({ defaultBranch: "main" });
    await success("repo", "add", other.tempRepo);
    const active = readRegistry(f.home).repos[0];
    await success("repo", "tag", active.id, "--add", "active");
    await success("guidance", "clear");
    await success("config", "set", "worktreesRoot", path.join(createTempDir(), "future"));
    expect(registry(f.home).version).toBe(3);
    expect(registry(f.home).retainedRepositories).toEqual(retained);
    expectSha(f);
  });

  it("keeps missing retained storage inspectable and refuses restoration without changing metadata", async () => {
    const f = await fixture();
    await success("repo", "remove", f.repo.id);
    renameSync(f.repo.managedRepoPath, `${f.repo.managedRepoPath}-held`);
    const bytes = readFileSync(path.join(f.home, "repos.json"), "utf8");
    const shown = await success("repo", "show", f.repo.id, "--retained");
    expect(shown.status).toBe("missing");
    expect(shown.inspection.status).toBe("unavailable");
    expect((await success("repo", "list", "--retained")).missingRepoCount).toBe(1);
    await failure("repo", "restore", f.repo.id);
    expect(readFileSync(path.join(f.home, "repos.json"), "utf8")).toBe(bytes);
  });

  it.each(["marker", "origin", "identity", "foreign"])(
    "refuses %s ownership changes without adopting or touching storage",
    async (tamper) => {
      const f = await branchFixture();
      await success("repo", "remove", f.repo.id);
      if (tamper === "marker")
        git(["--git-dir", f.repo.managedRepoPath, "config", "outpost.repository-id", "foreign/id"]);
      if (tamper === "origin")
        git([
          "--git-dir",
          f.repo.managedRepoPath,
          "config",
          "remote.origin.url",
          "https://example.invalid/other.git",
        ]);
      if (tamper === "identity") {
        const state = registry(f.home);
        state.retainedRepositories[0].name = "wrong-name";
        writeFileSync(path.join(f.home, "repos.json"), JSON.stringify(state));
      }
      if (tamper === "foreign") {
        renameSync(f.repo.managedRepoPath, `${f.repo.managedRepoPath}-owned`);
        mkdirSync(f.repo.managedRepoPath);
        writeFileSync(path.join(f.repo.managedRepoPath, "sentinel"), "foreign");
      }
      const bytes = readFileSync(path.join(f.home, "repos.json"), "utf8");
      const shown = await success("repo", "show", f.repo.id, "--retained");
      expect(shown.inspection.status).toBe("unavailable");
      await failure("repo", "restore", f.repo.id);
      expect(readFileSync(path.join(f.home, "repos.json"), "utf8")).toBe(bytes);
      if (tamper === "foreign")
        expect(readFileSync(path.join(f.repo.managedRepoPath, "sentinel"), "utf8")).toBe("foreign");
      else expectSha(f);
    }
  );

  it("reserves active and retained identities and portable canonical paths across both lists", async () => {
    const f = await fixture();
    await success("repo", "remove", f.repo.id);
    const original = registry(f.home);
    for (const duplicate of [f.repo, { ...f.repo, id: "other/id", name: "other" }]) {
      const state = { ...original, repositories: [duplicate] };
      const bytes = JSON.stringify(state);
      writeFileSync(path.join(f.home, "repos.json"), bytes);
      await failure("repo", "restore", f.repo.id);
      await failure("repo", "add", f.source.tempRepo);
      expect(readFileSync(path.join(f.home, "repos.json"), "utf8")).toBe(bytes);
    }
  });

  it("rejects a retained path escaping reposRoot through a junction and preserves the external sentinel", async () => {
    const f = await fixture();
    await success("repo", "remove", f.repo.id);
    const external = createTempDir();
    writeFileSync(path.join(external, "sentinel"), "external");
    const alias = path.join(f.home, "repos", "escape");
    symlinkSync(external, alias, process.platform === "win32" ? "junction" : "dir");
    const state = registry(f.home);
    state.retainedRepositories[0].managedRepoPath = path.join(alias, "arbitrary.git");
    const bytes = JSON.stringify(state);
    writeFileSync(path.join(f.home, "repos.json"), bytes);
    const shown = await success("repo", "show", f.repo.id, "--retained");
    expect(shown.inspection.status).toBe("unavailable");
    await failure("repo", "restore", f.repo.id);
    expect(readFileSync(path.join(external, "sentinel"), "utf8")).toBe("external");
    expect(readFileSync(path.join(f.home, "repos.json"), "utf8")).toBe(bytes);
  });

  it("rejects arbitrary unregistered directories and does not conflate equal names across identities", async () => {
    const f = await fixture();
    await success("repo", "remove", f.repo.id);
    const other = await createManagedRepoFixture({ defaultBranch: "main", repoName: f.repo.name });
    await success("repo", "add", other.tempRepo);
    const active = readRegistry(f.home).repos[0];
    expect(active.id).not.toBe(f.repo.id);
    expect(active.name).toBe(f.repo.name);
    await success("repo", "restore", f.repo.id);
    expect(readRegistry(f.home).repos.map((repo) => repo.id)).toEqual([active.id, f.repo.id]);
    await failure(
      "create",
      "--ticket",
      "COLLISION",
      "--type",
      "feat",
      "--repo",
      active.id,
      "--repo",
      f.repo.id
    );
    expect(existsSync(path.join(f.home, "worktrees", "COLLISION"))).toBe(false);
    const arbitrary = path.join(f.home, "repos", "arbitrary.git");
    mkdirSync(arbitrary);
    writeFileSync(path.join(arbitrary, "sentinel"), "foreign");
    await failure("repo", "restore", "arbitrary");
    expect(readFileSync(path.join(arbitrary, "sentinel"), "utf8")).toBe("foreign");
  });

  it("retains existing linked-worktree and manifest guards before unregistering", async () => {
    const f = await fixture();
    await success("create", "--ticket", "ACTIVE", "--type", "feat", "--repo", f.repo.id);
    const bytes = readFileSync(path.join(f.home, "repos.json"), "utf8");
    expect((await failure("repo", "remove", f.repo.id)).reason).toBe("repo-in-use");
    rmSync(path.join(f.home, "workspaces", "ACTIVE.json"));
    expect((await failure("repo", "remove", f.repo.id)).reason).toBe("repo-in-use");
    expect(readFileSync(path.join(f.home, "repos.json"), "utf8")).toBe(bytes);
  });

  it("uses an incompatible registry barrier that the previous-v2 strict registry shape refuses", async () => {
    const f = await fixture();
    await success("repo", "remove", f.repo.id);
    const oldDecoder = Schema.Union([
      Schema.Struct({ repos: Schema.Array(RepoRecordSchema) }),
      Schema.Struct({ version: Schema.Literal(2), repositories: Schema.Array(RepoRecordSchema) }),
    ]);
    expect(() =>
      Schema.decodeUnknownSync(oldDecoder)(registry(f.home), { onExcessProperty: "error" })
    ).toThrow();
    expect(JSON.parse(readFileSync(path.join(f.home, "config.json"), "utf8")).version).toBe(2);
    const bytes = JSON.stringify({ ...registry(f.home), version: 4 });
    writeFileSync(path.join(f.home, "repos.json"), bytes);
    await failure("repo", "restore", f.repo.id);
    await failure("repo", "list", "--retained");
    expect(readFileSync(path.join(f.home, "repos.json"), "utf8")).toBe(bytes);
  });

  it.each([220, 221])(
    "preserves retained refs at the native %i-byte Git-directory boundary, including Unicode/spaces and junction resolution",
    async (bytes) => {
      // The target below uses native canonical paths. Establish that same root
      // spelling before init; Windows temp homes can use a RUNNER~1 ancestor.
      // Mixing those spellings would exercise lexical containment instead of
      // the actual 220/221-byte Git-directory boundary.
      const f = await branchFixture(undefined, true);
      const config = JSON.parse(readFileSync(path.join(f.home, "config.json"), "utf8"));
      expect(config.reposRoot).toBe(path.join(realpathSync.native(f.home), "repos"));
      await success("repo", "remove", f.repo.id);
      const parent = path.join(f.home, "repos", "owned café");
      mkdirSync(parent);
      const canonicalParent = realpathSync.native(parent);
      const stem = path.join(canonicalParent, ".git");
      const target = path.join(
        canonicalParent,
        `${"x".repeat(bytes - Buffer.byteLength(stem, "utf8"))}.git`
      );
      expect(Buffer.byteLength(target, "utf8")).toBe(bytes);
      renameSync(f.repo.managedRepoPath, target);
      const state = registry(f.home);
      state.retainedRepositories[0].managedRepoPath = target;
      writeFileSync(path.join(f.home, "repos.json"), JSON.stringify(state));
      const before = readFileSync(path.join(f.home, "repos.json"), "utf8");
      const gitConfig = readFileSync(path.join(target, "config"), "utf8");
      const looseBranch = path.join(target, "refs", "heads", "feat", "KEEP-1");
      expect(readFileSync(looseBranch, "utf8").trim()).toBe(f.sha);
      const shown = await success("repo", "show", f.repo.id, "--retained");
      expect(shown.managedRepoPath).toBe(target);
      if (process.platform === "win32" && bytes === 221) {
        expect(shown.inspection.status).toBe("unavailable");
        expect(shown.inspection.diagnostics.join(" ")).toContain("221 UTF-8 bytes; maximum 220");
        const error = await failure("repo", "restore", f.repo.id);
        expect(error.reason).toBe("invalid-arguments");
        expect(error.message).toContain(target);
        expect(readFileSync(path.join(f.home, "repos.json"), "utf8")).toBe(before);
        // Canonical resolution must refuse the same unsupported target even when
        // the registered spelling is a short disposable fixture junction.
        const alias = path.join(f.home, "repos", "alias");
        symlinkSync(target, alias, "junction");
        state.retainedRepositories[0].managedRepoPath = alias;
        const aliasBytes = JSON.stringify(state);
        writeFileSync(path.join(f.home, "repos.json"), aliasBytes);
        expect((await success("repo", "show", f.repo.id, "--retained")).inspection.status).toBe(
          "unavailable"
        );
        expect((await failure("repo", "restore", f.repo.id)).message).toContain(target);
        expect(readFileSync(path.join(f.home, "repos.json"), "utf8")).toBe(aliasBytes);
      } else {
        expect(
          shown.inspection.status,
          JSON.stringify({ bytes, target, inspection: shown.inspection }, null, 2)
        ).toBe("ok");
        expect(shown.inspection.refs).toContainEqual({
          name: "refs/heads/feat/KEEP-1",
          objectId: f.sha,
        });
        await success("repo", "restore", f.repo.id);
        await success("repo", "remove", f.repo.id);
        expect(registry(f.home).retainedRepositories[0].managedRepoPath).toBe(target);
      }
      expect(readFileSync(looseBranch, "utf8").trim()).toBe(f.sha);
      expect(readFileSync(path.join(target, "config"), "utf8")).toBe(gitConfig);
      expect(git(["-C", f.source.tempRepo, "rev-parse", "HEAD"])).toBe(f.sourceSha);
    }
  );

  it.each([1, 2, 3, 4])(
    "preserves the complete record and exact SHA when unregister metadata write %i fails",
    async (failAt) => {
      const f = await branchFixture();
      // branchFixture uses tags, so reset to valid legacy state to exercise the
      // config2/registry2/registry3/transfer sequence from its first boundary.
      const configPath = path.join(f.home, "config.json");
      const savedConfig = JSON.parse(readFileSync(configPath, "utf8"));
      const {
        legacyWorktreesRoot: _,
        trustedWorktreesRoots: __,
        extraInstructions: ___,
        ...legacy
      } = savedConfig;
      writeFileSync(configPath, JSON.stringify({ ...legacy, version: 1 }));
      const { tags: ____, ...untagged } = f.repo;
      writeFileSync(path.join(f.home, "repos.json"), JSON.stringify({ repos: [untagged] }));
      const original = Store.writeJsonFileAtomic;
      let count = 0;
      const mock = vi.spyOn(Store, "writeJsonFileAtomic").mockImplementation((file, value) => {
        if (file === configPath || file === path.join(f.home, "repos.json")) {
          count++;
          if (count === failAt)
            return Effect.fail(
              new Store.StoreError({ message: `injected metadata write ${failAt}` })
            );
        }
        return original(file, value);
      });
      await failure("repo", "remove", f.repo.id);
      mock.mockRestore();
      const state = registry(f.home);
      expect(state.repos ?? state.repositories).toEqual([untagged]);
      expect(state.retainedRepositories ?? []).toEqual([]);
      expectSha(f);
      expect(existsSync(path.join(f.home, ".mutation.lock"))).toBe(false);
      expect(readdirSync(path.join(f.home, "operations")).length).toBeGreaterThan(0);
      await success("repo", "remove", f.repo.id);
      await success("repo", "restore", f.repo.id);
      expectSha(f);
    }
  );

  it.each(["journal", "registry"])(
    "preserves retained recovery data and exact SHA when restore %s write fails",
    async (target) => {
      const f = await branchFixture();
      await success("repo", "remove", f.repo.id);
      const before = readFileSync(path.join(f.home, "repos.json"), "utf8");
      const original = Store.writeJsonFileAtomic;
      const mock = vi.spyOn(Store, "writeJsonFileAtomic").mockImplementation((file, value) => {
        const hit =
          target === "registry"
            ? file === path.join(f.home, "repos.json")
            : file.startsWith(path.join(f.home, "operations") + path.sep);
        return hit
          ? Effect.fail(
              new Store.StoreError({ message: `injected restore ${target} write failure` })
            )
          : original(file, value);
      });
      await failure("repo", "restore", f.repo.id);
      mock.mockRestore();
      expect(readFileSync(path.join(f.home, "repos.json"), "utf8")).toBe(before);
      expectSha(f);
      expect(existsSync(path.join(f.home, ".mutation.lock"))).toBe(false);
      await success("repo", "restore", f.repo.id);
      expect(readRegistry(f.home).repos).toEqual([f.repo]);
      expectSha(f);
    }
  );

  it.each(["barrier", "unregistered", "restored"])(
    "preserves discoverable exact SHA when interrupted after %s metadata commits",
    async (point) => {
      const f = await branchFixture();
      if (point === "restored") await success("repo", "remove", f.repo.id);
      let markReached!: () => void;
      const reached = new Promise<void>((resolve) => {
        markReached = resolve;
      });
      const original = Store.writeJsonFileAtomic;
      const mock = vi.spyOn(Store, "writeJsonFileAtomic").mockImplementation((file, value) => {
        const v = value as {
          version?: number;
          repositories?: unknown[];
          retainedRepositories?: unknown[];
        };
        const hit =
          file === path.join(f.home, "repos.json") &&
          v.version === 3 &&
          (point === "barrier"
            ? v.retainedRepositories?.length === 0
            : point === "unregistered"
              ? v.retainedRepositories?.length === 1
              : v.repositories?.length === 1);
        return hit
          ? original(file, value).pipe(
              Effect.andThen(Effect.sync(() => markReached())),
              Effect.andThen(Effect.never)
            )
          : original(file, value);
      });
      const operation =
        point === "restored"
          ? runRepoRestore(f.repo.id, []).pipe(
              Effect.asVoid,
              Effect.mapError((error) => new Error(error.message))
            )
          : runRepoRemove(f.repo.id, []).pipe(
              Effect.asVoid,
              Effect.mapError((error) => new Error(error.message))
            );
      const fiber = Effect.runFork(operation.pipe(Effect.provide(NodeServices.layer)));
      await reached;
      await Effect.runPromise(Fiber.interrupt(fiber));
      mock.mockRestore();
      const state = registry(f.home);
      expect(state.repositories.length + state.retainedRepositories.length).toBe(1);
      expectSha(f);
      expect(existsSync(path.join(f.home, ".mutation.lock"))).toBe(false);
      if (state.retainedRepositories.length) await success("repo", "restore", f.repo.id);
      else if (point === "barrier") {
        await success("repo", "remove", f.repo.id);
        await success("repo", "restore", f.repo.id);
      }
      expectSha(f);
    }
  );
});
