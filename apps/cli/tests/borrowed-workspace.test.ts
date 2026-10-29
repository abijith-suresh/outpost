import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync, readdirSync, realpathSync, renameSync, symlinkSync } from "node:fs";
import { NodeServices } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { describe, expect, it, vi } from "vitest";
import { withAttributeIndex } from "../src/attribute-inspection.ts";
import * as Adapter from "../src/child-process.ts";
import { runCreate } from "../src/commands/create.ts";
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
      "-C",
      cwd,
      ...args,
    ],
    { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
  ).trim();
}
async function cli(...args: string[]) {
  const out = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
  out.mockClear();
  err.mockClear();
  const code = await runCli([...args, "--json"]);
  const stdout = out.mock.calls.map((c) => String(c[0])).join("\n");
  const stderr = err.mock.calls.map((c) => String(c[0])).join("\n");
  return {
    code,
    diagnostic: JSON.stringify({ args, code, stdout, stderr }),
    envelope: JSON.parse(stderr || stdout),
  };
}
async function ok(...args: string[]) {
  const r = await cli(...args);
  expect(r.code, r.diagnostic).toBe(0);
  return r.envelope.data;
}
function snapshot(root: string) {
  const result: Record<string, string> = {};
  const visit = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const f = path.join(dir, name);
      const s = lstatSync(f, { bigint: true });
      if (s.isDirectory()) visit(f);
      else if (s.isFile()) result[f] = `${s.mtimeNs}:${readFileSync(f).toString("base64")}`;
    }
  };
  visit(root);
  return result;
}
function preserved(before: Record<string, string>) {
  for (const [file, value] of Object.entries(before)) {
    expect(
      `${lstatSync(file, { bigint: true }).mtimeNs}:${readFileSync(file).toString("base64")}`,
      file
    ).toBe(value);
  }
}
async function fixture() {
  const home = createTempDir("outpost-local-home-");
  const source = createTempDir("outpost-local-src-");
  process.env.OUTPOST_HOME = home;
  await ok("init");
  git(source, "init", "-b", "main");
  git(source, "config", "core.autocrlf", "false");
  writeFileSync(path.join(source, "README"), "source-only commit\n");
  git(source, "add", ".");
  git(source, "commit", "-m", "local-only");
  const sha = git(source, "rev-parse", "HEAD");
  const repo = (await ok("repo", "register", source, "--name", "app")).repository;
  return { home, source, sha, repo };
}
function args(id: string, ticket = "LOCAL", base = "refs/heads/main") {
  return [
    "--ticket",
    ticket,
    "--type",
    "feat",
    "--repo",
    id,
    "--base-source",
    "local",
    "--base",
    base,
  ];
}

describe("borrowed local NEW workspaces", () => {
  it.each(["index", "alias"])(
    "preserves unexpected private inspection %s residue without deleting raced paths",
    async (kind) => {
      const f = await fixture();
      const before = snapshot(f.source);
      let index = "";
      let held = "";
      const outcome = await Effect.runPromise(
        Effect.exit(
          withAttributeIndex(f.repo, (inspection) =>
            Effect.sync(() => {
              index = inspection.index;
              if (kind === "index") writeFileSync(index, "unexpected index");
              else {
                const directory = path.dirname(index);
                held = `${directory}-held`;
                renameSync(directory, held);
                symlinkSync(held, directory, process.platform === "win32" ? "junction" : "dir");
              }
            })
          )
        )
      );
      expect(outcome._tag).toBe("Failure");
      if (kind === "index") expect(readFileSync(index, "utf8")).toBe("unexpected index");
      else {
        expect(lstatSync(path.dirname(index)).isSymbolicLink()).toBe(true);
        expect(lstatSync(held).isDirectory()).toBe(true);
      }
      preserved(before);
    }
  );
  it.each([205, 206])(
    "checks borrowed common %ibyte and derived admin Windows boundary without source mutation",
    async (bytes) => {
      const outer = realpathSync.native(createTempDir("op-b-"));
      const source = path.join(outer, "s".repeat(bytes - Buffer.byteLength(outer, "utf8") - 6));
      mkdirSync(source);
      git(source, "init", "-b", "main");
      writeFileSync(path.join(source, "README"), "boundary\n");
      git(source, "add", ".");
      git(source, "commit", "-m", "boundary");
      expect(Buffer.byteLength(path.join(source, ".git"), "utf8")).toBe(bytes);
      process.env.OUTPOST_HOME = createTempDir("op-bh-");
      await ok("init");
      const name = "outpost-create-repo-fixed0";
      const record = (await ok("repo", "register", source, "--name", name)).repository;
      mkdirSync(path.join(source, ".git", "worktrees"));
      writeFileSync(path.join(source, ".git", "worktrees", name), "foreign admin sentinel\n");
      const before = snapshot(source);
      const command = args(record.id, "BOUNDARY");
      if (process.platform === "win32" && bytes === 206) {
        const result = await cli("create", ...command);
        expect(result.code, result.diagnostic).toBe(1);
        expect(result.diagnostic).toContain("maximum 243");
        expect(git(source, "branch", "--list", "feat/BOUNDARY")).toBe("");
      } else {
        const made = await ok("create", ...command);
        const checkout = made.worktrees[0].path;
        if (bytes === 205)
          expect(git(checkout, "rev-parse", "--absolute-git-dir").length).toBe(243);
        await ok("workspace", "resume", "BOUNDARY");
        await ok("workspace", "remove", "BOUNDARY");
        expect(git(source, "rev-parse", "feat/BOUNDARY")).toBe(git(source, "rev-parse", "main"));
      }
      preserved(before);
    }
  );
  it.each(["commands", "process"])(
    "uses trusted %s conversion for population, resume and removal",
    async (mode) => {
      const f = await fixture();
      writeFileSync(path.join(f.source, ".gitattributes"), "README filter=trusted\n");
      git(f.source, "add", ".gitattributes");
      git(f.source, "commit", "-m", "conversion attributes");
      const marker = path.join(f.home, "driver-log");
      const driver = path.resolve("scripts/fixtures/trusted-filter.mjs").replaceAll("\\", "/");
      const command = (kind: string) =>
        `node "${driver}" ${kind} "${marker.replaceAll("\\", "/")}"`;
      if (mode === "process") git(f.source, "config", "filter.trusted.process", command("process"));
      else
        for (const kind of ["clean", "smudge"])
          git(f.source, "config", `filter.trusted.${kind}`, command(kind));
      git(f.source, "config", "filter.trusted.required", "true");
      const before = snapshot(f.source);
      await ok("create", ...args(f.repo.id, "CONVERT"), "--dry-run");
      const created = await ok("create", ...args(f.repo.id, "CONVERT"));
      const checkout = created.worktrees[0].path;
      expect(readFileSync(path.join(checkout, "README"), "utf8")).toBe("WORK:source-only commit\n");
      expect((await ok("workspace", "resume", "CONVERT")).resumable).toBe(true);
      writeFileSync(path.join(checkout, "README"), "WORK:changed\n");
      const dirty = await ok("workspace", "resume", "CONVERT");
      expect(dirty.worktrees[0].workingState.status).toBe("dirty");
      expect((await cli("workspace", "remove", "CONVERT")).code).toBe(1);
      writeFileSync(path.join(checkout, "README"), "WORK:source-only commit\n");
      await ok("workspace", "remove", "CONVERT");
      expect(readFileSync(marker, "utf8")).toContain("smudge");
      expect(readFileSync(marker, "utf8")).toContain("clean");
      preserved(before);
      expect(git(f.source, "cat-file", "-t", "feat/CONVERT")).toBe("commit");
    }
  );
  it("pins source-only SHA, preserves dirty source/config/hooks/refs, resumes advanced dirty work, and removes only owned checkout", async () => {
    const f = await fixture();
    writeFileSync(path.join(f.source, "README"), "dirty source\n");
    writeFileSync(path.join(f.source, "untracked"), "keep\n");
    git(f.source, "config", "branch.autoSetupMerge", "always");
    git(f.source, "config", "credential.helper", "!exit 97");
    git(f.source, "remote", "add", "team", "https://invalid.example/no-contact");
    const hook = path.join(f.source, ".git", "hooks", "reference-transaction");
    writeFileSync(hook, `#!/bin/sh\nexit 99\n`);
    chmodSync(hook, 0o755);
    const before = snapshot(f.source);
    const preview = await ok("create", ...args(f.repo.id), "--dry-run");
    expect(preview.worktrees[0].baseCommit).toBe(f.sha);
    preserved(before);
    const created = await ok("create", ...args(f.repo.id));
    const checkout = created.worktrees[0].path;
    expect(git(checkout, "rev-parse", "HEAD")).toBe(f.sha);
    expect(readFileSync(path.join(checkout, "README"), "utf8")).toBe("source-only commit\n");
    preserved(before);
    const manifest = JSON.parse(
      readFileSync(path.join(f.home, "workspaces", "LOCAL.json"), "utf8")
    );
    expect(manifest.version).toBe(5);
    expect(manifest.repositories[0].storage.common).toEqual(f.repo.common);
    expect(manifest.repositories[0].managedPath).toBeUndefined();
    expect((await cli("repo", "remove", f.repo.id)).code).toBe(1);
    expect((await ok("workspace", "show", "LOCAL")).status).toBe("ready");
    git(checkout, "-c", "core.hooksPath=", "commit", "--allow-empty", "-m", "advanced");
    const advanced = git(checkout, "rev-parse", "HEAD");
    writeFileSync(path.join(checkout, "dirty"), "owned work\n");
    const resumed = await ok("workspace", "resume", "LOCAL");
    expect(resumed.worktrees[0].currentHead).toBe(advanced);
    expect(resumed.worktrees[0].workingState.status).toBe("dirty");
    expect(resumed.worktrees[0].originalBase.baseCommit).toBe(f.sha);
    expect((await cli("workspace", "remove", "LOCAL")).code).toBe(1);
    const fs = await import("node:fs");
    fs.unlinkSync(path.join(checkout, "dirty"));
    await ok("workspace", "remove", "LOCAL");
    expect(git(f.source, "rev-parse", "feat/LOCAL")).toBe(advanced);
    preserved(before);
    // Source hook deliberately refuses ref updates; lifecycle must never invoke it.
    await ok("repo", "remove", f.repo.id);
    await ok("repo", "restore", f.repo.id);
    preserved(before);
  });
  it.each(["refs/heads/main", "refs/tags/annotated", "sha"])(
    "uses explicit %s without DWIM or changed base provenance",
    async (base) => {
      const f = await fixture();
      git(f.source, "tag", "-a", "annotated", "-m", "tag");
      const selected = base === "sha" ? f.sha : base;
      const result = await ok("create", ...args(f.repo.id, "BASE", selected));
      expect(result.worktrees[0].baseCommit).toBe(f.sha);
    }
  );
  it("requires explicit local/full base, refuses borrowed reuse/remotes and repeat create before effects", async () => {
    const f = await fixture();
    const before = snapshot(f.source);
    for (const input of [
      ["--ticket", "X", "--type", "feat", "--repo", f.repo.id],
      args(f.repo.id, "X", "main"),
      ["--ticket", "X", "--type", "feat", "--repo", f.repo.id, "--reuse-branch", "main"],
      [...args(f.repo.id), "--base-source", "fresh-remote"],
    ])
      expect((await cli("create", ...input)).code).toBe(1);
    preserved(before);
    await ok("create", ...args(f.repo.id));
    const repeat = await cli("create", ...args(f.repo.id));
    expect(repeat.code).toBe(1);
    expect(repeat.diagnostic).toContain("resume");
    preserved(before);
  });
  it("keeps a pinned SHA when the requested base moves after resolution", async () => {
    const f = await fixture();
    const original = Store.writeJsonFileAtomic;
    let moved = false;
    const spy = vi.spyOn(Store, "writeJsonFileAtomic").mockImplementation((file, value) => {
      if (!moved && JSON.stringify(value).includes('"action":"create-branch"')) {
        moved = true;
        git(f.source, "commit", "--allow-empty", "-m", "source moved");
      }
      return original(file, value);
    });
    const result = await ok("create", ...args(f.repo.id));
    spy.mockRestore();
    expect(moved).toBe(true);
    expect(result.worktrees[0].baseCommit).toBe(f.sha);
    expect(git(result.worktrees[0].path, "rev-parse", "HEAD")).toBe(f.sha);
    expect(git(f.source, "rev-parse", "main")).not.toBe(f.sha);
  });
  it("refuses a raced dangling symbolic target under the prepared create lock", async () => {
    const f = await fixture();
    const original = Adapter.acquireBranchCreation;
    let injected = false;
    const spy = vi.spyOn(Adapter, "acquireBranchCreation").mockImplementation((...input) => {
      if (!injected) {
        injected = true;
        git(f.source, "symbolic-ref", "refs/heads/feat/LOCAL", "refs/heads/user-missing");
      }
      return original(...input);
    });
    const result = await cli("create", ...args(f.repo.id));
    spy.mockRestore();
    expect(result.code, result.diagnostic).toBe(1);
    expect(injected).toBe(true);
    expect(git(f.source, "symbolic-ref", "refs/heads/feat/LOCAL")).toBe("refs/heads/user-missing");
    expect(git(f.source, "rev-parse", "main")).toBe(f.sha);
  });
  it("preflights every mixed member before touching any target", async () => {
    const f = await fixture();
    const other = await createManagedRepoFixture({ repoName: "managed" });
    await ok("repo", "add", other.tempRepo);
    const managed = (await ok("repo", "list")).repos.find(
      (r: { kind?: string }) => r.kind !== "borrowed"
    );
    git(f.source, "branch", "feat/LOCAL");
    const before = snapshot(managed.managedRepoPath);
    const result = await cli("create", ...args(f.repo.id), "--repo", managed.id);
    expect(result.code, result.diagnostic).toBe(1);
    preserved(before);
  });
  it("preserves source and refuses a selected commit leaf alias", async () => {
    const f = await fixture();
    const object = path.join(f.source, ".git", "objects", f.sha.slice(0, 2), f.sha.slice(2));
    const held = path.join(createTempDir("outpost-external-"), "object");
    renameSync(object, held);
    symlinkSync(held, object, "file");
    const result = await cli("create", ...args(f.repo.id));
    expect(result.code, result.diagnostic).toBe(1);
    expect(readFileSync(held).length).toBeGreaterThan(0);
  });
  it("refuses replacement of the owned checkout without adopting foreign paths", async () => {
    const f = await fixture();
    const link = path.join(createTempDir("outpost-anchor-"), "anchor");
    git(f.source, "worktree", "add", "--detach", link, "HEAD");
    await ok("repo", "remove", f.repo.id); // old retained common identity reserves registration
    await ok("repo", "restore", f.repo.id); // original main registration remains authoritative
    const result = await ok("create", ...args(f.repo.id));
    const checkout = result.worktrees[0].path;
    const replacement = checkout + "-saved";
    renameSync(checkout, replacement);
    mkdirSync(checkout);
    expect((await cli("workspace", "resume", "LOCAL")).code).toBe(1);
    expect((await cli("workspace", "remove", "LOCAL")).code).toBe(1);
  });
  it("resumes and removes using frozen storage after the registered linked launch anchor is gone", async () => {
    const f = await fixture();
    const link = path.join(createTempDir("outpost-launch-"), "anchor");
    git(f.source, "worktree", "add", "--detach", link, "HEAD");
    process.env.OUTPOST_HOME = createTempDir("outpost-second-home-");
    await ok("init");
    const borrowed = (await ok("repo", "register", link, "--name", "app")).repository;
    await ok("create", ...args(borrowed.id, "ANCHOR"));
    git(f.source, "worktree", "remove", link);
    expect((await ok("repo", "show", borrowed.id)).status).toBe("unavailable");
    expect((await ok("workspace", "resume", "ANCHOR")).resumable).toBe(true);
    await ok("workspace", "remove", "ANCHOR");
    expect(git(f.source, "rev-parse", "feat/ANCHOR")).toBe(f.sha);
  });
  it("trusts a newly configured driver after preflight and preserves failed admission", async () => {
    const f = await fixture();
    const marker = path.join(f.home, "FILTER-RAN");
    const before = snapshot(f.source);
    const original = Adapter.commandString;
    let injected = false;
    const spy = vi.spyOn(Adapter, "commandString").mockImplementation((command, ...other) =>
      original(command, ...other).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            if (
              !injected &&
              command._tag === "StandardCommand" &&
              command.args.includes("read-tree")
            ) {
              injected = true;
              git(f.source, "config", "filter.probe.clean", `echo called >> "${marker}"; cat`);
              const checkout = command.args[command.args.indexOf("-C") + 1];
              writeFileSync(path.join(checkout, ".gitattributes"), "README filter=probe\n");
            }
          })
        )
      )
    );
    const result = await cli("create", ...args(f.repo.id));
    spy.mockRestore();
    expect(injected).toBe(true);
    expect(result.code, result.diagnostic).toBe(1);
    expect(result.diagnostic).toContain("was not rolled back");
    const fs = await import("node:fs");
    expect(fs.existsSync(marker)).toBe(true);
    // The driver configuration was deliberately changed by the external race.
    delete before[path.join(f.source, ".git", "config")];
    preserved(before);
  });
  it.each(["tree", "blob", "fanout"])(
    "refuses selected %s aliases without branch mutation",
    async (kind) => {
      const f = await fixture();
      const oid =
        kind === "tree"
          ? git(f.source, "rev-parse", "HEAD^{tree}")
          : kind === "blob"
            ? git(f.source, "rev-parse", "HEAD:README")
            : f.sha;
      const object = path.join(f.source, ".git", "objects", oid.slice(0, 2), oid.slice(2));
      const target = kind === "fanout" ? path.dirname(object) : object;
      const held = path.join(createTempDir("outpost-leaf-external-"), "held");
      renameSync(target, held);
      symlinkSync(
        held,
        target,
        kind === "fanout" ? (process.platform === "win32" ? "junction" : "dir") : "file"
      );
      const result = await cli("create", ...args(f.repo.id));
      expect(result.code, result.diagnostic).toBe(1);
      expect(git(f.source, "branch", "--list", "feat/LOCAL")).toBe("");
    }
  );
  it.each(["gitlink"])(
    "refuses selected tracked %s before creating refs/worktrees",
    async (kind) => {
      const f = await fixture();
      if (kind === "filter") {
        writeFileSync(path.join(f.source, ".gitattributes"), "README filter=blocked\n");
        git(f.source, "add", ".gitattributes");
      } else git(f.source, "update-index", "--add", "--cacheinfo", `160000,${f.sha},nested`);
      git(f.source, "commit", "-m", "unsupported tracked feature");
      if (kind === "filter") git(f.source, "config", "filter.blocked.clean", "exit 99");
      const before = snapshot(f.source);
      const result = await cli("create", ...args(f.repo.id));
      expect(result.code, result.diagnostic).toBe(1);
      preserved(before);
      expect(git(f.source, "branch", "--list", "feat/LOCAL")).toBe("");
    }
  );
  it("preserves confirmed/advanced work and a journal on cancellation before manifest admission", async () => {
    const f = await fixture();
    let ready!: () => void;
    const reached = new Promise<void>((r) => {
      ready = r;
    });
    const original = Store.writeJsonFileAtomic;
    let paused = false;
    const spy = vi.spyOn(Store, "writeJsonFileAtomic").mockImplementation((file, value) => {
      if (
        !paused &&
        file.startsWith(path.join(f.home, "operations") + path.sep) &&
        JSON.stringify(value).includes('"action":"write-workspace-manifest"')
      ) {
        paused = true;
        return original(file, value).pipe(
          Effect.andThen(Effect.sync(ready)),
          Effect.andThen(Effect.never)
        );
      }
      return original(file, value);
    });
    const fiber = Effect.runFork(
      runCreate(args(f.repo.id), { interactive: false }).pipe(Effect.provide(NodeServices.layer))
    );
    await reached;
    const checkout = path.join(f.home, "worktrees", "LOCAL", "app");
    git(checkout, "commit", "--allow-empty", "-m", "user advanced");
    const advanced = git(checkout, "rev-parse", "HEAD");
    await Effect.runPromise(Fiber.interrupt(fiber));
    spy.mockRestore();
    expect(git(f.source, "rev-parse", "feat/LOCAL")).toBe(advanced);
    expect(readFileSync(path.join(checkout, "README"), "utf8")).toBe("source-only commit\n");
    expect(readdirSync(path.join(f.home, "operations")).length).toBeGreaterThan(0);
  });
  it("creates mixed v5 members with explicit backends while preserving legacy managed semantics", async () => {
    const f = await fixture();
    const other = await createManagedRepoFixture({ repoName: "managed" });
    await ok("repo", "add", other.tempRepo);
    const managed = (await ok("repo", "list")).repos.find(
      (r: { kind?: string }) => r.kind !== "borrowed"
    );
    const result = await ok("create", ...args(f.repo.id, "MIXED"), "--repo", managed.id);
    expect(result.worktrees).toHaveLength(2);
    const manifest = JSON.parse(
      readFileSync(path.join(f.home, "workspaces", "MIXED.json"), "utf8")
    );
    expect(
      manifest.repositories.map((r: { storage: { kind: string } }) => r.storage.kind).sort()
    ).toEqual(["borrowed", "managed"]);
    expect((await ok("workspace", "resume", "MIXED")).resumable).toBe(true);
    await ok("workspace", "remove", "MIXED");
  });
  it.each(["main", "linked"])(
    "preserves split %s source/common/private/shared indexes through actual preview/create/resume/remove/failure",
    async (kind) => {
      const f = await fixture();
      git(f.source, "update-index", "--split-index");
      let record = f.repo;
      let anchor = f.source;
      if (kind === "linked") {
        anchor = path.join(createTempDir("outpost-split-anchor-"), "anchor");
        git(f.source, "worktree", "add", "--detach", anchor, "HEAD");
        git(anchor, "update-index", "--split-index");
        process.env.OUTPOST_HOME = createTempDir("outpost-split-home-");
        await ok("init");
        record = (await ok("repo", "register", anchor, "--name", "app")).repository;
      }
      writeFileSync(path.join(anchor, ".gitattributes"), "README filter=blocked\n");
      git(f.source, "config", "filter.blocked.clean", "exit 99");
      git(f.source, "config", "filter.blocked.smudge", "exit 99");
      const before = snapshot(f.source);
      const anchorBefore = snapshot(anchor);
      await ok("create", ...args(record.id, "SPLIT"), "--dry-run");
      preserved(before);
      preserved(anchorBefore);
      await ok("create", ...args(record.id, "SPLIT"));
      preserved(before);
      preserved(anchorBefore);
      await ok("workspace", "resume", "SPLIT");
      await ok("workspace", "remove", "SPLIT");
      preserved(before);
      preserved(anchorBefore);
      expect((await cli("create", ...args(record.id, "FAIL", "refs/heads/missing"))).code).toBe(1);
      preserved(before);
      preserved(anchorBefore);
    }
  );
  it.each(["failure", "cancel"])(
    "retains exact A-B-A branch and private HEAD history after late %s",
    async (mode) => {
      const f = await fixture();
      writeFileSync(path.join(f.source, ".gitattributes"), "README filter=inert\n");
      git(f.source, "add", ".gitattributes");
      git(f.source, "commit", "-m", "trusted failure fixture");
      f.sha = git(f.source, "rev-parse", "HEAD");
      const filterLog = path.join(f.home, "failure-filter.log");
      const driver = path.resolve("scripts/fixtures/trusted-filter.mjs").replaceAll("\\", "/");
      git(
        f.source,
        "config",
        "filter.inert.process",
        `node "${driver}" process "${filterLog.replaceAll("\\", "/")}"`
      );
      const sourceBefore = snapshot(f.source);
      let ready!: () => void;
      const reached = new Promise<void>((r) => {
        ready = r;
      });
      const original = Store.writeJsonFileAtomic;
      let paused = false;
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const spy = vi.spyOn(Store, "writeJsonFileAtomic").mockImplementation((file, value) => {
        if (mode === "failure" && file === path.join(f.home, "workspaces", "ABA.json"))
          return Effect.fail(new Store.StoreError({ message: "late manifest failure" }));
        if (
          !paused &&
          file.startsWith(path.join(f.home, "operations") + path.sep) &&
          JSON.stringify(value).includes('"action":"write-workspace-manifest"')
        ) {
          paused = true;
          return original(file, value).pipe(
            Effect.andThen(Effect.sync(ready)),
            Effect.andThen(Effect.promise(() => gate))
          );
        }
        return original(file, value);
      });
      const fiber = Effect.runFork(
        runCreate(args(f.repo.id, "ABA"), { interactive: false }).pipe(
          Effect.provide(NodeServices.layer)
        )
      );
      await reached;
      const checkout = path.join(f.home, "worktrees", "ABA", "app");
      git(checkout, "commit", "--allow-empty", "-m", "unique B");
      const b = git(checkout, "rev-parse", "HEAD");
      git(f.source, "update-ref", "refs/heads/feat/ABA", f.sha, b);
      const reflog = path.join(f.source, ".git", "logs", "refs", "heads", "feat", "ABA");
      const expected = readFileSync(reflog);
      const expectedTime = lstatSync(reflog, { bigint: true }).mtimeNs;
      const privateHead = path.join(
        git(checkout, "rev-parse", "--absolute-git-dir"),
        "logs",
        "HEAD"
      );
      const expectedHead = readFileSync(privateHead);
      const expectedHeadTime = lstatSync(privateHead, { bigint: true }).mtimeNs;
      // Stop only the injected interruptible pause; do not cross publication's commit mask.
      if (mode === "cancel") {
        await Effect.runPromise(Fiber.interrupt(fiber));
        release();
      } else {
        release();
        const exit = await Effect.runPromise(Fiber.await(fiber));
        expect(exit._tag).toBe("Failure");
      }
      spy.mockRestore();
      expect(git(f.source, "rev-parse", "feat/ABA")).toBe(f.sha);
      expect(readFileSync(filterLog, "utf8")).toContain("smudge");
      expect(readFileSync(filterLog, "utf8")).toContain("clean");
      expect(readFileSync(reflog)).toEqual(expected);
      expect(expected.toString()).toContain(b);
      expect(readFileSync(privateHead)).toEqual(expectedHead);
      expect(lstatSync(reflog, { bigint: true }).mtimeNs).toBe(expectedTime);
      expect(lstatSync(privateHead, { bigint: true }).mtimeNs).toBe(expectedHeadTime);
      preserved(sourceBefore);
      expect(git(f.source, "cat-file", "-t", b)).toBe("commit");
      expect(readFileSync(path.join(checkout, "README"), "utf8")).toBe("WORK:source-only commit\n");
      const repeat = await cli("create", ...args(f.repo.id, "ABA"));
      expect(repeat.code, repeat.diagnostic).toBe(1);
      expect(repeat.diagnostic).toContain("doctor");
    }
  );
});
