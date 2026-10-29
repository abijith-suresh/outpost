import { execFileSync } from "node:child_process";
import {
  cpSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { describe, expect, it, vi } from "vitest";
import * as Store from "../src/store.ts";
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
function git(...args: string[]) {
  return execFileSync(
    "git",
    [
      "-c",
      "core.longpaths=true",
      "-c",
      "user.name=Object Ownership",
      "-c",
      "user.email=ownership@example.invalid",
      ...args,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  ).trim();
}
async function cli(...args: string[]) {
  const out = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
  out.mockClear();
  err.mockClear();
  const code = await runCli([...args, "--json"]);
  const raw = [...out.mock.calls, ...err.mock.calls].map((c) => String(c[0])).join("\n");
  return { code, envelope: JSON.parse(raw), diagnostic: JSON.stringify({ args, code, raw }) };
}
async function ok(...args: string[]) {
  const r = await cli(...args);
  expect(r.code, r.diagnostic).toBe(0);
  return r.envelope.data;
}
async function fixture() {
  const home = createTempDir("op-obj-");
  process.env.OUTPOST_HOME = home;
  await ok("init");
  const source = await createManagedRepoFixture();
  await ok("repo", "add", source.tempRepo);
  const repo = readRegistry(home).repos[0];
  writeFileSync(path.join(source.tempRepo, "unique.txt"), "source-only object\n");
  git("-C", source.tempRepo, "add", ".");
  git("-C", source.tempRepo, "commit", "-m", "source only");
  const sha = git("-C", source.tempRepo, "rev-parse", "HEAD");
  expect(() => git("--git-dir", repo.managedRepoPath, "cat-file", "-e", sha)).toThrow();
  const tree = git("-C", source.tempRepo, "rev-parse", "HEAD^{tree}");
  const blob = git("-C", source.tempRepo, "rev-parse", "HEAD:unique.txt");
  const sourceObjects = path.join(source.tempRepo, ".git", "objects");
  const objects = path.join(repo.managedRepoPath, "objects");
  // Fixture ownership only: materialize a tiny owned object store, then replace
  // exactly the dependency under test. Product code never copies these objects.
  cpSync(sourceObjects, objects, { recursive: true, force: false });
  git("--git-dir", repo.managedRepoPath, "update-ref", "refs/heads/borrow", sha);
  writeFileSync(path.join(source.tempRepo, "dirty.txt"), "preserve source edits\n");
  const ref = path.join(repo.managedRepoPath, "refs", "heads", "borrow");
  const preserved = [
    path.join(home, "config.json"),
    path.join(home, "repos.json"),
    path.join(repo.managedRepoPath, "config"),
    ref,
  ];
  const bytes = preserved.map((file) => readFileSync(file));
  const args = (ticket = "OBJECTS") => [
    "create",
    "--ticket",
    ticket,
    "--type",
    "feat",
    "--repo",
    repo.id,
    "--reuse-branch",
    "borrow",
  ];
  const recordMigration = () => {
    const initial = JSON.parse(bytes[0].toString());
    const current = JSON.parse(readFileSync(preserved[0], "utf8"));
    expect(current.version).toBe(2);
    expect(current.worktreesRoot).toBe(initial.worktreesRoot);
    expect(current.reposRoot).toBe(initial.reposRoot);
    expect(readRegistry(home).repos.map((entry) => [entry.id, entry.managedRepoPath])).toEqual([
      [repo.id, repo.managedRepoPath],
    ]);
    bytes[0] = readFileSync(preserved[0]);
    bytes[1] = readFileSync(preserved[1]);
  };
  const preserve = () => {
    preserved.forEach((file, index) => {
      expect(readFileSync(file)).toEqual(bytes[index]);
    });
    expect(git("-C", source.tempRepo, "rev-parse", "HEAD")).toBe(sha);
    expect(readFileSync(path.join(source.tempRepo, "dirty.txt"), "utf8")).toBe(
      "preserve source edits\n"
    );
  };
  return {
    home,
    source,
    repo,
    sha,
    tree,
    blob,
    objects,
    sourceObjects,
    args,
    preserve,
    recordMigration,
  };
}
function leaf(objects: string, id: string) {
  return path.join(objects, id.slice(0, 2), id.slice(2));
}
async function refusal(f: Awaited<ReturnType<typeof fixture>>) {
  for (const dry of [true, false]) {
    const r = await cli(...f.args(), ...(dry ? ["--dry-run"] : []));
    expect(r.code, r.diagnostic).toBe(1);
    expect(r.envelope.error.message).toMatch(/object storage|ownership|checkout objects/i);
    expect(existsSync(path.join(f.home, "workspaces", "OBJECTS.json"))).toBe(false);
    expect(existsSync(path.join(f.home, "worktrees", "OBJECTS"))).toBe(false);
    f.preserve();
  }
}

describe("reuse selected object ownership", () => {
  it("refuses a replacement commit dependency omitted by the selected Git inventory", async () => {
    const f = await fixture();
    const replacement = git(
      "--git-dir",
      f.repo.managedRepoPath,
      "commit-tree",
      f.tree,
      "-p",
      f.sha,
      "-m",
      "replacement object"
    );
    const file = leaf(f.objects, replacement);
    const external = path.join(createTempDir("op-replacement-object-"), "data");
    renameSync(file, external);
    symlinkSync(external, file, "file");
    git("--git-dir", f.repo.managedRepoPath, "update-ref", `refs/replace/${f.sha}`, replacement);
    const inventory = git(
      "--git-dir",
      f.repo.managedRepoPath,
      "rev-list",
      "--objects",
      "--no-object-names",
      "--no-walk",
      f.sha
    ).split(/\r?\n/);
    expect(inventory).not.toContain(replacement);
    for (const dry of [true, false]) {
      const r = await cli(...f.args(), ...(dry ? ["--dry-run"] : []));
      expect(r.code, r.diagnostic).toBe(1);
      expect(r.envelope.error.message).toContain("Replacement refs");
      expect(existsSync(path.join(f.home, "workspaces", "OBJECTS.json"))).toBe(false);
      expect(existsSync(path.join(f.home, "worktrees", "OBJECTS"))).toBe(false);
      expect(git("--git-dir", f.repo.managedRepoPath, "rev-parse", `refs/replace/${f.sha}`)).toBe(
        replacement
      );
      f.preserve();
    }
    renameSync(external, `${external}-held`);
    try {
      expect(() => git("--git-dir", f.repo.managedRepoPath, "cat-file", "-t", f.sha)).toThrow();
    } finally {
      renameSync(`${external}-held`, external);
    }
  });
  it("stops at the pack metadata bound without changing entries or admitting a workspace", async () => {
    const f = await fixture();
    const pack = path.join(f.objects, "pack");
    mkdirSync(pack, { recursive: true });
    for (let index = 0; index < 1025; index++)
      writeFileSync(path.join(pack, `sentinel-${index}.keep`), "preserve\n");
    const before = readdirSync(pack).sort();
    expect(before.length).toBeGreaterThan(1024);
    await refusal(f);
    expect(readdirSync(pack).sort()).toEqual(before);
    expect(readFileSync(path.join(pack, "sentinel-1024.keep"), "utf8")).toBe("preserve\n");
  });
  it.each(["sha", "tree", "blob"] as const)(
    "refuses an external loose %s leaf without alternate metadata",
    async (kind) => {
      const f = await fixture();
      const id = f[kind];
      const file = leaf(f.objects, id);
      unlinkSync(file);
      symlinkSync(leaf(f.sourceObjects, id), file, "file");
      await refusal(f);
      expect(lstatSync(file).isSymbolicLink()).toBe(true);
      renameSync(f.sourceObjects, `${f.sourceObjects}-held`);
      try {
        expect(() => git("--git-dir", f.repo.managedRepoPath, "cat-file", "-t", id)).toThrow();
      } finally {
        renameSync(`${f.sourceObjects}-held`, f.sourceObjects);
      }
    }
  );
  it("refuses a selected loose fanout directory alias", async () => {
    const f = await fixture();
    const directory = path.join(f.objects, f.sha.slice(0, 2));
    renameSync(directory, `${directory}-owned`);
    symlinkSync(
      path.join(f.sourceObjects, f.sha.slice(0, 2)),
      directory,
      process.platform === "win32" ? "junction" : "dir"
    );
    await refusal(f);
    expect(lstatSync(directory).isSymbolicLink()).toBe(true);
  });
  it.each(["directory", ".idx", ".pack", "multi-pack-index", "chain"])(
    "refuses aliased pack metadata %s",
    async (kind) => {
      const f = await fixture();
      git("--git-dir", f.repo.managedRepoPath, "repack", "-ad");
      git("--git-dir", f.repo.managedRepoPath, "prune-packed");
      const pack = path.join(f.objects, "pack");
      let file: string;
      if (kind === "directory") file = pack;
      else if (kind === "chain") {
        const chain = path.join(pack, "multi-pack-index.d");
        mkdirSync(chain);
        file = path.join(chain, "chain.midx");
        writeFileSync(file, "metadata sentinel\n");
      } else if (kind === "multi-pack-index") {
        git("--git-dir", f.repo.managedRepoPath, "multi-pack-index", "write");
        file = path.join(pack, kind);
      } else {
        const name = readdirSync(pack).find((entry) => entry.endsWith(kind));
        if (!name) throw new Error(`Missing fixture pack metadata ${kind}`);
        file = path.join(pack, name);
      }
      const external = path.join(createTempDir("op-object-external-"), "data");
      renameSync(file, external);
      symlinkSync(
        external,
        file,
        kind === "directory" ? (process.platform === "win32" ? "junction" : "dir") : "file"
      );
      await refusal(f);
      expect(lstatSync(file).isSymbolicLink()).toBe(true);
      if (["directory", ".idx", ".pack"].includes(kind)) {
        renameSync(external, `${external}-held`);
        try {
          expect(() => git("--git-dir", f.repo.managedRepoPath, "cat-file", "-t", f.sha)).toThrow();
        } finally {
          renameSync(`${external}-held`, external);
        }
      }
    }
  );
  it.each(["regular", "packed", "hardlinked"])(
    "admits self-contained %s objects after original source objects disappear",
    async (kind) => {
      const f = await fixture();
      if (kind === "packed") {
        git("--git-dir", f.repo.managedRepoPath, "repack", "-ad");
        git("--git-dir", f.repo.managedRepoPath, "prune-packed");
        git("--git-dir", f.repo.managedRepoPath, "multi-pack-index", "write");
      }
      if (kind === "hardlinked") {
        for (const id of [f.sha, f.tree, f.blob]) {
          const file = leaf(f.objects, id);
          unlinkSync(file);
          linkSync(leaf(f.sourceObjects, id), file);
        }
      }
      renameSync(f.sourceObjects, `${f.sourceObjects}-held`);
      try {
        await ok(...f.args(), "--dry-run");
        const created = await ok(...f.args());
        expect(git("-C", created.worktrees[0].path, "rev-parse", "HEAD")).toBe(f.sha);
        f.recordMigration();
        await ok("workspace", "remove", "OBJECTS");
      } finally {
        renameSync(`${f.sourceObjects}-held`, f.sourceObjects);
      }
      f.preserve();
    }
  );
  it.each(["verify-existing-branches", "verify-existing-branch", "create-worktree"])(
    "refuses selected leaf replacement around admission at %s",
    async (action) => {
      const f = await fixture();
      const original = Store.writeJsonFileAtomic;
      let raced = false;
      vi.spyOn(Store, "writeJsonFileAtomic").mockImplementation((file, value) => {
        const last = (value as { steps?: Record<string, unknown>[] }).steps?.at(-1);
        if (
          !raced &&
          last?.action === action &&
          (action !== "create-worktree" || last.phase === "confirmed")
        ) {
          raced = true;
          if (action === "create-worktree") f.recordMigration();
          const object = leaf(f.objects, f.blob);
          unlinkSync(object);
          symlinkSync(leaf(f.sourceObjects, f.blob), object, "file");
        }
        return original(file, value);
      });
      const r = await cli(...f.args());
      expect(r.code, r.diagnostic).toBe(1);
      expect(raced).toBe(true);
      expect(existsSync(path.join(f.home, "workspaces", "OBJECTS.json"))).toBe(false);
      f.preserve();
    }
  );
});
