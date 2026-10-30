import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync, realpathSync, renameSync, symlinkSync } from "node:fs";
import { NodeServices } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { describe, expect, it, vi } from "vitest";
import { runRepoRegister } from "../src/commands/repo-register.ts";
import * as Store from "../src/store.ts";
import {
  createManagedRepoFixture,
  createTempDir,
  mkdirSync,
  path,
  readFileSync,
  runCli,
  setupAfterEach,
  writeFileSync,
} from "./helpers.ts";

setupAfterEach();
function git(cwd: string, ...args: string[]) {
  return execFileSync(
    "git",
    [
      "-c",
      "core.longpaths=true",
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      ...args,
    ],
    { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
  ).trim();
}
async function cli(...args: string[]) {
  const out = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
  out.mockClear();
  err.mockClear();
  const code = await runCli([...args, "--json"]);
  const text = [...out.mock.calls, ...err.mock.calls].map((c) => String(c[0])).join("\n");
  return { code, text, data: JSON.parse(text).data };
}
async function ok(...args: string[]) {
  const result = await cli(...args);
  expect(result.code, result.text).toBe(0);
  return result.data;
}
function snapshot(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  function visit(dir: string) {
    for (const name of readdirSync(dir)) {
      const file = path.join(dir, name);
      const stat = lstatSync(file, { bigint: true });
      if (stat.isDirectory()) visit(file);
      else if (stat.isFile())
        result[path.relative(root, file)] =
          `${stat.mtimeNs}:${readFileSync(file).toString("base64")}`;
    }
  }
  visit(root);
  return result;
}
async function fixture(unborn = false) {
  const home = createTempDir("outpost-reg-home-");
  const source = createTempDir("outpost-reg-src-");
  process.env.OUTPOST_HOME = home;
  await ok("init");
  git(source, "init", "-b", "main");
  if (!unborn) {
    writeFileSync(path.join(source, "README"), "source\n");
    git(source, "add", ".");
    git(source, "commit", "-m", "source");
  }
  return { home, source };
}

describe("offline borrowed registration", () => {
  it("preserves dirty/untracked/config/hooks/refs/objects bytes and mtimes through lifecycle and all refusals", async () => {
    const { home, source } = await fixture();
    writeFileSync(path.join(source, "README"), "dirty\n");
    writeFileSync(path.join(source, "untracked"), "keep\n");
    git(source, "config", "credential.helper", "!exit 97");
    git(source, "remote", "add", "team", "https://invalid.example/repo");
    git(source, "remote", "add", "backup", "https://invalid.example/other");
    writeFileSync(path.join(source, ".git", "hooks", "post-checkout"), "must not run");
    const before = snapshot(source);
    const preview = await ok("repo", "register", source, "--name", "api", "--dry-run");
    expect(preview.dryRun).toBe(true);
    expect(JSON.parse(readFileSync(path.join(home, "config.json"), "utf8")).version).toBe(1);
    const registered = await ok("repo", "register", source, "--name", "api");
    const id = registered.repository.id;
    expect(registered.repository.common.device).toBe(
      lstatSync(path.join(source, ".git"), { bigint: true }).dev.toString()
    );
    expect(registered.repository.common.inode).toBe(
      lstatSync(path.join(source, ".git"), { bigint: true }).ino.toString()
    );
    expect((await ok("repo", "register", source, "--name", "api")).action).toBe(
      "already-registered"
    );
    expect((await ok("repo", "show", id)).status).toBe("ok");
    expect((await ok("repo", "list")).repos).toHaveLength(1);
    for (const mode of ["local", "cached-remote", "fresh-remote"]) {
      const r = await cli(
        "create",
        "--ticket",
        "TASK",
        "--type",
        "feat",
        "--repo",
        id,
        "--base-source",
        mode,
        "--base",
        "main"
      );
      expect(r.code, r.text).toBe(1);
      expect(r.text).toContain(mode === "local" ? "unsupported" : "--remote");
    }
    const fetch = await cli("repo", "fetch", "--all");
    expect(fetch.code, fetch.text).toBe(1);
    expect((await ok("repo", "remove", id)).storage).toBe("external-unchanged");
    expect((await ok("repo", "show", id, "--retained")).status).toBe("ok");
    expect((await ok("repo", "restore", id)).storage).toBe("external-unchanged");
    expect(snapshot(source)).toEqual(before);
    expect(JSON.parse(readFileSync(path.join(home, "config.json"), "utf8")).version).toBe(3);
    expect(JSON.parse(readFileSync(path.join(home, "repos.json"), "utf8")).version).toBe(4);
  });
  it("supports unborn local-only clones and independent clones remain distinct", async () => {
    const { source } = await fixture(true);
    const a = await ok("repo", "register", source, "--name", "empty");
    const other = createTempDir("outpost-reg-other-");
    git(other, "init", "-b", "main");
    const b = await ok("repo", "register", other, "--name", "other");
    expect(a.repository.id).not.toBe(b.repository.id);
  });
  it("validates linked backpointers; aliases are idempotent; benign source evolution preserves identity", async () => {
    const { source } = await fixture();
    const link = path.join(createTempDir("outpost-reg-links-"), "linked");
    git(source, "worktree", "add", "--detach", link, "HEAD");
    const a = await ok("repo", "register", link, "--name", "linked");
    expect(a.repository.checkoutKind).toBe("linked");
    const alias = path.join(createTempDir("outpost-reg-alias-"), "alias");
    symlinkSync(link, alias, process.platform === "win32" ? "junction" : "dir");
    expect((await ok("repo", "register", alias, "--name", "alias")).repository.id).toBe(
      a.repository.id
    );
    git(source, "config", "fixture.changed", "yes");
    git(source, "branch", "later");
    const added = path.join(createTempDir("outpost-reg-more-"), "later");
    git(source, "worktree", "add", added, "later");
    expect((await ok("repo", "show", a.repository.id)).status).toBe("ok");
    const foreign = path.join(source, ".git", "worktrees", "linked", "gitdir");
    const fd = await import("node:fs");
    const handle = fd.openSync(foreign, "r+");
    fd.ftruncateSync(handle);
    fd.writeSync(handle, "foreign\n");
    fd.closeSync(handle);
    expect((await ok("repo", "show", a.repository.id)).status).toBe("unavailable");
  });
  it("refuses directory replacement without adopting matching copied metadata", async () => {
    const { source } = await fixture();
    const a = await ok("repo", "register", source, "--name", "api");
    renameSync(path.join(source, ".git"), path.join(source, ".git.saved"));
    git(source, "init", "-b", "main");
    const view = await ok("repo", "show", a.repository.id);
    expect(view.status).toBe("unavailable");
    expect(view.diagnostics.join(" ")).toContain("replaced");
    const r = await cli("repo", "register", source, "--name", "api");
    expect(r.code, r.text).toBe(1);
  });
  it.each([1, 2, 3])(
    "repairs forward after migration write %i fails without touching source",
    async (failAt) => {
      const { home, source } = await fixture();
      const before = snapshot(source);
      const original = Store.writeJsonFileAtomic;
      let count = 0;
      const mock = vi.spyOn(Store, "writeJsonFileAtomic").mockImplementation((file, value) => {
        if (
          (file === path.join(home, "config.json") || file === path.join(home, "repos.json")) &&
          ++count === failAt
        )
          return Effect.fail(new Store.StoreError({ message: "injected migration failure" }));
        return original(file, value);
      });
      const r = await cli("repo", "register", source, "--name", "api");
      expect(r.code, r.text).toBe(1);
      mock.mockRestore();
      expect(snapshot(source)).toEqual(before);
      await ok("repo", "register", source, "--name", "api");
      expect((await ok("repo", "list")).repos).toHaveLength(1);
      expect(snapshot(source)).toEqual(before);
    }
  );
  it("preserves committed registration on fiber interruption and releases only its own lock", async () => {
    const { home, source } = await fixture();
    const before = snapshot(source);
    const original = Store.writeJsonFileAtomic;
    let ready!: () => void;
    const reached = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const mock = vi.spyOn(Store, "writeJsonFileAtomic").mockImplementation((file, value) => {
      const v = value as { version?: number; repositories?: unknown[] };
      if (file === path.join(home, "repos.json") && v.version === 4 && v.repositories?.length === 1)
        return original(file, value).pipe(
          Effect.andThen(Effect.sync(ready)),
          Effect.andThen(Effect.never)
        );
      return original(file, value);
    });
    const fiber = Effect.runFork(
      runRepoRegister([source, "--name", "api"]).pipe(Effect.provide(NodeServices.layer))
    );
    await reached;
    await Effect.runPromise(Fiber.interrupt(fiber));
    mock.mockRestore();
    expect((await ok("repo", "register", source, "--name", "api")).action).toBe(
      "already-registered"
    );
    expect(snapshot(source)).toEqual(before);
  });
  it("refuses held locks and identity swaps during migration before admitting a record", async () => {
    const { home, source } = await fixture();
    writeFileSync(path.join(home, ".mutation.lock"), "held");
    expect((await cli("repo", "register", source, "--name", "api")).code).toBe(1);
    const fs = await import("node:fs");
    fs.unlinkSync(path.join(home, ".mutation.lock"));
    const original = Store.writeJsonFileAtomic;
    let swapped = false;
    const mock = vi.spyOn(Store, "writeJsonFileAtomic").mockImplementation((file, value) =>
      original(file, value).pipe(
        Effect.andThen(
          Effect.sync(() => {
            if (
              !swapped &&
              file === path.join(home, "repos.json") &&
              (value as { version?: number }).version === 4
            ) {
              swapped = true;
              renameSync(path.join(source, ".git"), path.join(source, ".git.saved"));
              git(source, "init", "-b", "main");
            }
          })
        )
      )
    );
    const r = await cli("repo", "register", source, "--name", "api");
    mock.mockRestore();
    expect(r.code, r.text).toBe(1);
    expect((await ok("repo", "list")).repos).toHaveLength(0);
  });

  it.each([220, 221])(
    "checks actual common directory at %i UTF-8 bytes before metadata migration",
    async (bytes) => {
      if (process.platform !== "win32") return;
      const { home } = await fixture(true);
      const base = realpathSync.native(createTempDir("outpost-reg-bound-"));
      const source = path.join(base, "a".repeat(bytes - Buffer.byteLength(base) - 6));
      mkdirSync(source);
      git(source, "init", "-b", "main");
      expect(Buffer.byteLength(path.join(source, ".git"))).toBe(bytes);
      const before = snapshot(source);
      const metadata = readFileSync(path.join(home, "config.json"), "utf8");
      const result = await cli("repo", "register", source, "--name", "boundary");
      expect(result.code, result.text).toBe(bytes === 220 ? 0 : 1);
      if (bytes === 221) {
        expect(result.text).toContain("220");
        expect(readFileSync(path.join(home, "config.json"), "utf8")).toBe(metadata);
      }
      expect(snapshot(source)).toEqual(before);
    }
  );
  it("refuses mixed selections before managed mutation and preserves managed-only writers after upgrade", async () => {
    const { home, source } = await fixture();
    const managedSource = await createManagedRepoFixture({ repoName: "managed" });
    const imported = await ok("repo", "add", managedSource.tempRepo);
    const managed = (await ok("repo", "list")).repos[0];
    const borrowed = (await ok("repo", "register", source, "--name", "borrowed")).repository;
    const before = snapshot(imported.repoPath);
    const result = await cli(
      "create",
      "--ticket",
      "MIXED",
      "--type",
      "feat",
      "--repo",
      managed.id,
      "--repo",
      borrowed.id,
      "--base-source",
      "fresh-remote"
    );
    expect(result.code, result.text).toBe(1);
    expect((await cli("repo", "fetch", "--all")).code).toBe(1);
    expect(snapshot(imported.repoPath)).toEqual(before);
    await ok("repo", "tag", managed.id, "--add", "safe");
    await ok("create", "--ticket", "OWNED", "--type", "feat", "--repo", managed.id);
    await ok("workspace", "remove", "OWNED");
    await ok("repo", "remove", managed.id);
    await ok("repo", "restore", managed.id);
    expect((await ok("repo", "show", borrowed.id)).status).toBe("ok");
    expect(JSON.parse(readFileSync(path.join(home, "repos.json"), "utf8")).version).toBe(4);
  });
  it("refuses an Outpost home inside source before creating locks or journals", async () => {
    const { source } = await fixture();
    process.env.OUTPOST_HOME = path.join(source, "metadata");
    await ok("init");
    const before = snapshot(source);
    const result = await cli("repo", "register", source, "--name", "api");
    expect(result.code, result.text).toBe(1);
    expect(result.text).toContain("inside borrowed");
    expect(snapshot(source)).toEqual(before);
  });
});
