import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, realpathSync, renameSync, symlinkSync } from "node:fs";
import { NodeServices } from "@effect/platform-node";
import { Effect, Fiber } from "effect";
import { systemError } from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vitest";
import * as BranchAdapter from "../src/child-process.ts";
import { runCreate } from "../src/commands/create.ts";
import * as Store from "../src/store.ts";
import { ManifestSchema } from "../src/workspace-manifest.ts";
import {
  createManagedRepoFixture,
  createTempDir,
  existsSync,
  localManagedRepoPath,
  path,
  readFileSync,
  readRegistry,
  runCli,
  setupAfterEach,
  writeFileSync,
} from "./helpers.ts";

setupAfterEach();
function git(args: string[], input?: string) {
  return execFileSync(
    "git",
    [
      ...(process.platform === "win32" ? ["-c", "core.longpaths=true"] : []),
      "-c",
      "user.name=Outpost Base Test",
      "-c",
      "user.email=base@example.invalid",
      ...args,
    ],
    { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], input }
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
  const diagnostic = JSON.stringify({ args, code, stdout, stderr }, null, 2);
  let envelope: ReturnType<typeof JSON.parse>;
  try {
    envelope = JSON.parse(stderr || stdout);
  } catch {
    throw new Error(diagnostic);
  }
  return { code, envelope, diagnostic };
}
async function ok(...args: string[]) {
  const r = await cli(...args);
  expect(r.code, r.diagnostic).toBe(0);
  return r.envelope.data;
}
async function fail(...args: string[]) {
  const r = await cli(...args);
  expect(r.code, r.diagnostic).toBe(1);
  return r.envelope.error;
}
function refs(managed: string) {
  return git(["--git-dir", managed, "for-each-ref", "--format=%(refname)%09%(objectname)"]);
}
async function fixture(defaultBranch = "main") {
  const home = createTempDir("op-b-");
  process.env.OUTPOST_HOME = home;
  await ok("init");
  const f = await createManagedRepoFixture({ defaultBranch });
  await ok("repo", "add", f.tempRepo);
  const repo = readRegistry(home).repos[0];
  const cached = git([
    "--git-dir",
    repo.managedRepoPath,
    "rev-parse",
    `refs/remotes/origin/${defaultBranch}`,
  ]);
  const tree = git(["--git-dir", repo.managedRepoPath, "rev-parse", `${cached}^{tree}`]);
  const local = git(
    ["--git-dir", repo.managedRepoPath, "commit-tree", tree, "-p", cached],
    "managed only\n"
  );
  git(["--git-dir", repo.managedRepoPath, "update-ref", `refs/heads/${defaultBranch}`, local]);
  writeFileSync(path.join(f.tempRepo, "remote-next.txt"), "fresh remote commit\n");
  git(["-C", f.tempRepo, "add", "."]);
  git(["-C", f.tempRepo, "commit", "-m", "remote next"]);
  git(["-C", f.tempRepo, "push", "origin", defaultBranch]);
  const fresh = git(["-C", f.tempRepo, "rev-parse", "HEAD"]);
  writeFileSync(path.join(f.tempRepo, "source-only.txt"), "source only\n");
  git(["-C", f.tempRepo, "add", "."]);
  git(["-C", f.tempRepo, "commit", "-m", "source only"]);
  const sourceOnly = git(["-C", f.tempRepo, "rev-parse", "HEAD"]);
  writeFileSync(path.join(f.tempRepo, "dirty.txt"), "leave this source edit\n");
  return { home, f, repo, cached, local, fresh, sourceOnly, defaultBranch };
}
function baseArgs(
  f: Awaited<ReturnType<typeof fixture>>,
  ticket: string,
  source?: string,
  base?: string
) {
  return [
    "--ticket",
    ticket,
    "--type",
    "feat",
    "--repo",
    f.repo.id,
    ...(source ? ["--base-source", source] : []),
    ...(base ? ["--base", base] : []),
  ];
}
function checkSource(f: Awaited<ReturnType<typeof fixture>>) {
  expect(git(["-C", f.f.tempRepo, "rev-parse", "HEAD"])).toBe(f.sourceOnly);
  expect(readFileSync(path.join(f.f.tempRepo, "dirty.txt"), "utf8")).toBe(
    "leave this source edit\n"
  );
  expect(
    git(["--git-dir", f.repo.managedRepoPath, "rev-parse", `refs/heads/${f.defaultBranch}`])
  ).toBe(f.local);
}

function args(f: Awaited<ReturnType<typeof fixture>>, ticket: string) {
  return [...baseArgs(f, ticket), "--reuse-branch", "borrowed/work"];
}
function borrow(f: Awaited<ReturnType<typeof fixture>>) {
  git(["--git-dir", f.repo.managedRepoPath, "update-ref", "refs/heads/borrowed/work", f.local]);
  return f.local;
}
function branch(f: Awaited<ReturnType<typeof fixture>>) {
  return git(["--git-dir", f.repo.managedRepoPath, "rev-parse", "refs/heads/borrowed/work"]);
}
function journal(home: string) {
  return readdirSync(path.join(home, "operations"))
    .map((file) => readFileSync(path.join(home, "operations", file), "utf8"))
    .join("\n");
}
function hook(
  action: string,
  run: (step: Record<string, unknown>) => undefined | Effect.Effect<never, Store.StoreError>,
  phase?: string
) {
  const original = Store.writeJsonFileAtomic;
  let called = false;
  vi.spyOn(Store, "writeJsonFileAtomic").mockImplementation((file, value) => {
    const last = (value as { steps?: Record<string, unknown>[] }).steps?.at(-1);
    if (!called && last?.action === action && (!phase || last.phase === phase)) {
      called = true;
      const result = run(last);
      if (result) return result;
    }
    return original(file, value);
  });
  return () => expect(called).toBe(true);
}

describe("explicit existing managed branch reuse", () => {
  it.each([true, false])(
    "refuses a selected ref namespace aliased to an unregistered directory dry-run=%s",
    async (dryRun) => {
      const f = await fixture();
      borrow(f);
      const refParent = path.join(f.repo.managedRepoPath, "refs", "heads", "borrowed");
      const external = createTempDir("op-external-ref-");
      writeFileSync(path.join(external, "work"), `${f.local}\n`);
      renameSync(refParent, `${refParent}-owned`);
      symlinkSync(external, refParent, process.platform === "win32" ? "junction" : "dir");
      expect(
        git(["--git-dir", f.repo.managedRepoPath, "rev-parse", "refs/heads/borrowed/work"])
      ).toBe(f.local);
      expect(
        (await fail("create", ...args(f, "REF-ALIAS"), ...(dryRun ? ["--dry-run"] : []))).message
      ).toContain("escapes or aliases");
      expect(readFileSync(path.join(external, "work"), "utf8")).toBe(`${f.local}\n`);
      expect(readFileSync(path.join(`${refParent}-owned`, "work"), "utf8")).toBe(`${f.local}\n`);
      expect(realpathSync(refParent)).toBe(realpathSync(external));
      expect(existsSync(path.join(f.home, "worktrees", "REF-ALIAS"))).toBe(false);
      expect(existsSync(path.join(f.home, "workspaces", "REF-ALIAS.json"))).toBe(false);
      checkSource(f);
    }
  );
  it("refuses a lock-bypassing ref namespace alias introduced after attachment without changing its target", async () => {
    const f = await fixture();
    borrow(f);
    const external = createTempDir("op-raced-ref-");
    writeFileSync(path.join(external, "work"), `${f.local}\n`);
    const refParent = path.join(f.repo.managedRepoPath, "refs", "heads", "borrowed");
    const checked = hook(
      "create-worktree",
      () => {
        renameSync(refParent, `${refParent}-owned`);
        symlinkSync(external, refParent, process.platform === "win32" ? "junction" : "dir");
      },
      "confirmed"
    );
    expect((await fail("create", ...args(f, "RACED-REF-ALIAS"))).message).toContain(
      "escapes or aliases"
    );
    checked();
    expect(readFileSync(path.join(external, "work"), "utf8")).toBe(`${f.local}\n`);
    expect(readFileSync(path.join(`${refParent}-owned`, "work"), "utf8")).toBe(`${f.local}\n`);
    expect(existsSync(path.join(f.home, "workspaces", "RACED-REF-ALIAS.json"))).toBe(false);
    checkSource(f);
  });
  it.each([true, false])(
    "refuses source-only objects reached through an alternate pool dry-run=%s",
    async (dryRun) => {
      const f = await fixture();
      borrow(f);
      expect(() =>
        git(["--git-dir", f.repo.managedRepoPath, "cat-file", "-e", f.sourceOnly])
      ).toThrow();
      const alternate = path.join(f.repo.managedRepoPath, "objects", "info", "alternates");
      const alternateBytes = `${path.join(f.f.tempRepo, ".git", "objects").replaceAll("\\", "/")}\n`;
      writeFileSync(alternate, alternateBytes);
      git([
        "--git-dir",
        f.repo.managedRepoPath,
        "update-ref",
        "refs/heads/borrowed/work",
        f.sourceOnly,
      ]);
      const before = refs(f.repo.managedRepoPath);
      const config = readFileSync(path.join(f.home, "config.json"));
      const registry = readFileSync(path.join(f.home, "repos.json"));
      const error = await fail("create", ...args(f, "ALTERNATE"), ...(dryRun ? ["--dry-run"] : []));
      expect(error.message).toContain("object-pool metadata");
      expect(readFileSync(alternate, "utf8")).toBe(alternateBytes);
      expect(refs(f.repo.managedRepoPath)).toBe(before);
      expect(readFileSync(path.join(f.home, "config.json"))).toEqual(config);
      expect(readFileSync(path.join(f.home, "repos.json"))).toEqual(registry);
      expect(existsSync(path.join(f.home, "worktrees", "ALTERNATE"))).toBe(false);
      expect(existsSync(path.join(f.home, "workspaces", "ALTERNATE.json"))).toBe(false);
      expect(git(["-C", f.f.tempRepo, "rev-parse", "HEAD"])).toBe(f.sourceOnly);
      expect(readFileSync(path.join(f.f.tempRepo, "dirty.txt"), "utf8")).toBe(
        "leave this source edit\n"
      );
    }
  );
  it("refuses HTTP alternate metadata without changing it or consulting a remote", async () => {
    const f = await fixture();
    borrow(f);
    const alternate = path.join(f.repo.managedRepoPath, "objects", "info", "http-alternates");
    writeFileSync(alternate, "http://127.0.0.1:1/unavailable\n");
    expect((await fail("create", ...args(f, "HTTP-ALTERNATE"))).message).toContain(
      "object-pool metadata"
    );
    expect(readFileSync(alternate, "utf8")).toBe("http://127.0.0.1:1/unavailable\n");
    expect(branch(f)).toBe(f.local);
    expect(existsSync(path.join(f.home, "worktrees", "HTTP-ALTERNATE"))).toBe(false);
  });
  it.each([true, false])(
    "refuses an object-directory alias to unregistered source storage dry-run=%s",
    async (dryRun) => {
      const f = await fixture();
      borrow(f);
      const objects = path.join(f.repo.managedRepoPath, "objects");
      renameSync(objects, `${objects}-owned`);
      symlinkSync(
        path.join(f.f.tempRepo, ".git", "objects"),
        objects,
        process.platform === "win32" ? "junction" : "dir"
      );
      git([
        "--git-dir",
        f.repo.managedRepoPath,
        "update-ref",
        "refs/heads/borrowed/work",
        f.sourceOnly,
      ]);
      const before = refs(f.repo.managedRepoPath);
      const config = readFileSync(path.join(f.home, "config.json"));
      const registry = readFileSync(path.join(f.home, "repos.json"));
      expect(
        (await fail("create", ...args(f, "OBJECT-ALIAS"), ...(dryRun ? ["--dry-run"] : []))).message
      ).toContain("escapes or aliases");
      expect(refs(f.repo.managedRepoPath)).toBe(before);
      expect(readFileSync(path.join(f.home, "config.json"))).toEqual(config);
      expect(readFileSync(path.join(f.home, "repos.json"))).toEqual(registry);
      expect(existsSync(path.join(f.home, "worktrees", "OBJECT-ALIAS"))).toBe(false);
      expect(existsSync(path.join(f.home, "workspaces", "OBJECT-ALIAS.json"))).toBe(false);
      expect(realpathSync(objects)).toBe(realpathSync(path.join(f.f.tempRepo, ".git", "objects")));
      expect(git(["-C", f.f.tempRepo, "rev-parse", "HEAD"])).toBe(f.sourceOnly);
      expect(readFileSync(path.join(f.f.tempRepo, "dirty.txt"), "utf8")).toBe(
        "leave this source edit\n"
      );
    }
  );
  it("attaches exact branch-only work offline, records admission separately, resumes advanced work and preserves refs on removal", async () => {
    const f = await fixture();
    const initial = borrow(f);
    const originalSource = readFileSync(path.join(f.f.tempRepo, "README.md"));
    // Synthetic repo contract: a Git-created checkout must use LF regardless
    // of inherited Windows checkout settings. Product configuration is untouched.
    git(["--git-dir", f.repo.managedRepoPath, "config", "--local", "core.autocrlf", "false"]);
    git(["--git-dir", f.repo.managedRepoPath, "config", "--local", "core.eol", "lf"]);
    renameSync(f.f.tempRemote, `${f.f.tempRemote}.offline`);
    const created = await ok("create", ...args(f, "REUSE"));
    const member = created.worktrees[0];
    expect(member).toMatchObject({
      branch: "borrowed/work",
      branchDisposition: "existing",
      baseSource: "local",
      requestedBase: "borrowed/work",
      baseRef: "refs/heads/borrowed/work",
      baseCommit: initial,
      baseResolution: "resolved",
    });
    expect(git(["-C", member.path, "rev-parse", "HEAD"])).toBe(initial);
    expect(git(["-C", member.path, "symbolic-ref", "HEAD"])).toBe("refs/heads/borrowed/work");
    expect(readFileSync(path.join(member.path, "README.md"))).toEqual(originalSource);
    expect(readFileSync(path.join(f.f.tempRepo, "README.md"))).toEqual(originalSource);
    expect(git(["hash-object", "--no-filters", path.join(member.path, "README.md")])).toBe(
      git(["--git-dir", f.repo.managedRepoPath, "rev-parse", `${initial}:README.md`])
    );
    const manifestPath = path.join(f.home, "workspaces", "REUSE.json");
    const raw = readFileSync(manifestPath, "utf8");
    expect(JSON.parse(raw)).toMatchObject({
      version: 4,
      branch: "borrowed/work",
      repositories: [{ branchDisposition: "existing", baseCommit: initial }],
    });
    expect((await ok("workspace", "show", "REUSE")).worktrees[0].branchDisposition).toBe(
      "existing"
    );
    expect(readFileSync(path.join(created.ticketDirectory, "AGENTS.md"), "utf8")).toContain(
      "borrowed user-owned branch"
    );
    writeFileSync(path.join(member.path, "advanced.txt"), "advanced user commit\n");
    git(["-C", member.path, "add", "."]);
    git(["-C", member.path, "commit", "-m", "advance reused branch"]);
    const advanced = git(["-C", member.path, "rev-parse", "HEAD"]);
    const resumed = await ok("workspace", "resume", "REUSE");
    expect(resumed.worktrees[0]).toMatchObject({
      currentHead: advanced,
      originalBase: { branchDisposition: "existing", baseCommit: initial },
    });
    expect(readFileSync(manifestPath, "utf8")).toBe(raw);
    await ok("workspace", "remove", "REUSE");
    expect(branch(f)).toBe(advanced);
    expect((await ok("create", ...args(f, "AGAIN"))).worktrees[0].baseCommit).toBe(advanced);
    checkSource(f);
  });
  it("dry runs inspect exactly the existing ref without any mutation or fetch", async () => {
    const f = await fixture();
    borrow(f);
    renameSync(f.f.tempRemote, `${f.f.tempRemote}.offline`);
    const before = refs(f.repo.managedRepoPath);
    const config = readFileSync(path.join(f.home, "config.json"), "utf8");
    const r = await ok("create", ...args(f, "PREVIEW"), "--dry-run");
    expect(r.worktrees[0]).toMatchObject({ branchDisposition: "existing", baseCommit: f.local });
    expect(refs(f.repo.managedRepoPath)).toBe(before);
    expect(readFileSync(path.join(f.home, "config.json"), "utf8")).toBe(config);
    expect(existsSync(path.join(f.home, "worktrees", "PREVIEW"))).toBe(false);
    expect(readdirSync(path.join(f.home, "operations"))).toEqual([]);
  });
  it.each([
    ["--base", "main"],
    ["--base-source", "local"],
    ["--base-source", "fresh-remote"],
  ])("rejects incompatible new-base options %s before mutation", async (...extra) => {
    const f = await fixture();
    borrow(f);
    const before = refs(f.repo.managedRepoPath);
    expect((await fail("create", ...args(f, "INVALID"), ...extra)).message).toContain(
      "cannot be combined"
    );
    expect(refs(f.repo.managedRepoPath)).toBe(before);
    expect(existsSync(path.join(f.home, ".mutation.lock"))).toBe(false);
  });
  it("preflights every member before creating any worktree or migrating configuration", async () => {
    const f = await fixture();
    borrow(f);
    const other = await createManagedRepoFixture();
    await ok("repo", "add", other.tempRepo);
    const second = readRegistry(f.home).repos.find((r) => r.id !== f.repo.id);
    if (!second) throw new Error("Second actual Git fixture was not registered.");
    const before = refs(f.repo.managedRepoPath);
    const error = await fail("create", ...args(f, "ALL"), "--repo", second.id);
    expect(error.message).toContain(second.id);
    expect(refs(f.repo.managedRepoPath)).toBe(before);
    expect(existsSync(path.join(f.home, "worktrees", "ALL"))).toBe(false);
    expect(
      existsSync(path.join(f.repo.managedRepoPath, "refs", "heads", "borrowed", "work.lock"))
    ).toBe(false);
  }, 20000);
  it("refuses already checked-out branches and directs an existing ticket to explicit resume", async () => {
    const f = await fixture();
    borrow(f);
    const r = await ok("create", ...args(f, "OWNED"));
    expect((await fail("create", ...args(f, "OTHER"))).message).toContain("already checked out");
    expect((await fail("create", ...baseArgs(f, "OWNED", "fresh-remote"))).message).toContain(
      "workspace resume"
    );
    expect(git(["-C", r.worktrees[0].path, "rev-parse", "HEAD"])).toBe(f.local);
    expect(existsSync(path.join(f.home, "worktrees", "OTHER"))).toBe(false);
  });
  it("refuses symbolic local branches even when the target has the same commit", async () => {
    const f = await fixture();
    git([
      "--git-dir",
      f.repo.managedRepoPath,
      "symbolic-ref",
      "refs/heads/borrowed/work",
      "refs/heads/main",
    ]);
    expect((await fail("create", ...args(f, "SYMBOLIC"))).message).toContain("symbolic");
    expect(
      git(["--git-dir", f.repo.managedRepoPath, "symbolic-ref", "refs/heads/borrowed/work"])
    ).toBe("refs/heads/main");
  });
  it("rejects a same-SHA symbolic ref installed between resolution and prepared admission", async () => {
    const f = await fixture();
    borrow(f);
    const original = BranchAdapter.acquireBranchVerification;
    vi.spyOn(BranchAdapter, "acquireBranchVerification").mockImplementation((...input) =>
      Effect.gen(function* () {
        git([
          "--git-dir",
          f.repo.managedRepoPath,
          "symbolic-ref",
          "refs/heads/borrowed/work",
          "refs/heads/main",
        ]);
        return yield* original(...input);
      })
    );
    expect((await fail("create", ...args(f, "SYMRACE"))).message).toContain("symbolic");
    expect(existsSync(path.join(f.home, "worktrees", "SYMRACE"))).toBe(false);
    expect(
      git(["--git-dir", f.repo.managedRepoPath, "symbolic-ref", "refs/heads/borrowed/work"])
    ).toBe("refs/heads/main");
  });
  it("rejects a changed commit before lock acquisition without changing either ref", async () => {
    const f = await fixture();
    borrow(f);
    const original = BranchAdapter.acquireBranchVerification;
    vi.spyOn(BranchAdapter, "acquireBranchVerification").mockImplementation((...input) =>
      Effect.gen(function* () {
        git([
          "--git-dir",
          f.repo.managedRepoPath,
          "update-ref",
          "refs/heads/borrowed/work",
          f.cached,
        ]);
        return yield* original(...input);
      })
    );
    await fail("create", ...args(f, "RACE"));
    expect(branch(f)).toBe(f.cached);
    expect(existsSync(path.join(f.home, "worktrees", "RACE"))).toBe(false);
  });
  it("holds a real Git branch lock during attachment and releases it without writing the branch", async () => {
    const f = await fixture();
    borrow(f);
    const checked = hook("borrow-existing-branch", () => {
      expect(() =>
        git([
          "--git-dir",
          f.repo.managedRepoPath,
          "update-ref",
          "refs/heads/borrowed/work",
          f.cached,
        ])
      ).toThrow();
      expect(branch(f)).toBe(f.local);
    });
    await ok("create", ...args(f, "LOCKED"));
    checked();
    expect(
      existsSync(path.join(f.repo.managedRepoPath, "refs", "heads", "borrowed", "work.lock"))
    ).toBe(false);
    expect(branch(f)).toBe(f.local);
  });
  it("fails closed on a pre-existing branch lock without deleting or rewriting it", async () => {
    const f = await fixture();
    borrow(f);
    const lock = path.join(f.repo.managedRepoPath, "refs", "heads", "borrowed", "work.lock");
    writeFileSync(lock, "foreign lock sentinel\n");
    await fail("create", ...args(f, "HELD"));
    expect(readFileSync(lock, "utf8")).toBe("foreign lock sentinel\n");
    expect(branch(f)).toBe(f.local);
    expect(existsSync(path.join(f.home, "worktrees", "HELD"))).toBe(false);
  });
  it("rolls back only its newly created worktree after a later failure and never deletes the borrowed ref", async () => {
    const f = await fixture();
    borrow(f);
    const checked = hook("generate-guidance", () =>
      Effect.fail(new Store.StoreError({ message: "injected later failure" }))
    );
    expect((await fail("create", ...args(f, "FAIL"))).message).toContain("injected later failure");
    checked();
    expect(branch(f)).toBe(f.local);
    expect(existsSync(path.join(f.home, "worktrees", "FAIL"))).toBe(false);
    expect(journal(f.home)).toContain("borrow-existing-branch");
    expect(journal(f.home)).not.toContain('"action": "create-branch"');
    expect(JSON.stringify(await ok("doctor"))).toContain("borrow-existing-branch");
    expect(branch(f)).toBe(f.local);
  });
  it("preserves a raced user file instead of overwriting it while populating a new checkout", async () => {
    const f = await fixture();
    borrow(f);
    const checked = hook(
      "create-worktree",
      (step) => {
        writeFileSync(path.join(step.worktreePath as string, "README.md"), "raced user work\n");
      },
      "confirmed"
    );
    await fail("create", ...args(f, "CONTENTS"));
    checked();
    expect(
      readFileSync(path.join(f.home, "worktrees", "CONTENTS", f.repo.name, "README.md"), "utf8")
    ).toBe("raced user work\n");
    expect(branch(f)).toBe(f.local);
    expect(existsSync(path.join(f.home, "workspaces", "CONTENTS.json"))).toBe(false);
  });
  it("preserves advanced branch and dirty work on failed provenance verification", async () => {
    const f = await fixture();
    borrow(f);
    let advanced = "";
    const checked = hook("generate-guidance", (step) => {
      // An uncooperative external writer can bypass a Git lock; never reset or delete its work.
      const tree = git(["--git-dir", f.repo.managedRepoPath, "rev-parse", `${f.local}^{tree}`]);
      advanced = git(
        ["--git-dir", f.repo.managedRepoPath, "commit-tree", tree, "-p", f.local],
        "advanced after admission\n"
      );
      writeFileSync(
        path.join(f.repo.managedRepoPath, "refs", "heads", "borrowed", "work"),
        `${advanced}\n`
      );
      writeFileSync(
        path.join(path.dirname(step.filePath as string), f.repo.name, "dirty.txt"),
        "preserve dirty\n"
      );
    });
    await fail("create", ...args(f, "ADVANCED"));
    checked();
    expect(branch(f)).toBe(advanced);
    expect(
      readFileSync(path.join(f.home, "worktrees", "ADVANCED", f.repo.name, "dirty.txt"), "utf8")
    ).toBe("preserve dirty\n");
    expect(existsSync(path.join(f.home, "workspaces", "ADVANCED.json"))).toBe(false);
  });
  it("preserves borrowed branches and journals on fiber interruption", async () => {
    const f = await fixture();
    borrow(f);
    const original = Store.writeJsonFileAtomic;
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let gated = false;
    vi.spyOn(Store, "writeJsonFileAtomic").mockImplementation((file, value) => {
      const last = (value as { steps?: Record<string, unknown>[] }).steps?.at(-1);
      if (!gated && last?.action === "create-worktree" && last.phase === "confirmed") {
        gated = true;
        return original(file, value).pipe(
          Effect.andThen(Effect.sync(reached)),
          Effect.andThen(Effect.never)
        );
      }
      return original(file, value);
    });
    const fiber = Effect.runFork(
      runCreate(args(f, "INTERRUPT"), { interactive: false }).pipe(
        Effect.provide(NodeServices.layer)
      )
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        gate,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("interruption gate not reached")), 10000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      await Effect.runPromise(Fiber.interrupt(fiber));
    }
    expect(branch(f)).toBe(f.local);
    expect(
      existsSync(path.join(f.repo.managedRepoPath, "refs", "heads", "borrowed", "work.lock"))
    ).toBe(false);
    expect(journal(f.home)).toContain("borrow-existing-branch");
    expect(existsSync(path.join(f.home, "workspaces", "INTERRUPT.json"))).toBe(false);
  }, 20000);
  it("uses v4 to reject older strict manifest writers and refuses inconsistent provenance", async () => {
    const f = await fixture();
    borrow(f);
    await ok("create", ...args(f, "VERSION"));
    const file = path.join(f.home, "workspaces", "VERSION.json");
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    const previous = Schema.Struct({
      ...ManifestSchema.fields,
      version: Schema.optional(Schema.Literals([2, 3])),
    });
    expect(() =>
      Schema.decodeUnknownSync(previous)(manifest, { onExcessProperty: "error" })
    ).toThrow();
    manifest.repositories[0].branchDisposition = "created";
    writeFileSync(file, JSON.stringify(manifest));
    expect((await ok("workspace", "show", "VERSION")).status).toBe("invalid");
    await fail("workspace", "remove", "VERSION");
    expect(branch(f)).toBe(f.local);
  });
  it.each([true, false])(
    "refuses a missing promised branch commit without fetching dry-run=%s",
    async (dryRun) => {
      const f = await fixture();
      const ref = path.join(f.repo.managedRepoPath, "refs", "heads", "borrowed");
      mkdirSync(ref, { recursive: true });
      writeFileSync(path.join(ref, "work"), `${f.fresh}\n`);
      for (const [key, value] of [
        ["remote.origin.promisor", "true"],
        ["extensions.partialClone", "origin"],
      ])
        git(["--git-dir", f.repo.managedRepoPath, "config", key, value]);
      const trace = path.join(f.home, "offline.trace");
      process.env.GIT_TRACE = trace;
      const before = readFileSync(path.join(f.home, "repos.json"));
      await fail("create", ...args(f, "PROMISED"), ...(dryRun ? ["--dry-run"] : []));
      delete process.env.GIT_TRACE;
      expect(readFileSync(trace, "utf8")).not.toMatch(/\bfetch\b/);
      expect(readFileSync(path.join(ref, "work"), "utf8")).toBe(`${f.fresh}\n`);
      expect(readFileSync(path.join(f.home, "repos.json"))).toEqual(before);
      expect(existsSync(path.join(f.home, "worktrees", "PROMISED"))).toBe(false);
    }
  );
  it("refuses missing promised checkout blobs before any checkout or configuration mutation", async () => {
    const f = await fixture();
    const tree = git(["-C", f.f.tempRepo, "rev-parse", `${f.fresh}^{tree}`]);
    for (const [type, oid] of [
      ["tree", tree],
      ["commit", f.fresh],
    ]) {
      const raw = execFileSync("git", ["-C", f.f.tempRepo, "cat-file", type, oid]);
      expect(
        execFileSync(
          "git",
          [
            "-c",
            "core.longpaths=true",
            "--git-dir",
            f.repo.managedRepoPath,
            "hash-object",
            "-w",
            "-t",
            type,
            "--stdin",
          ],
          { input: raw, encoding: "utf8" }
        ).trim()
      ).toBe(oid);
    }
    git(["--git-dir", f.repo.managedRepoPath, "update-ref", "refs/heads/borrowed/work", f.fresh]);
    for (const [key, value] of [
      ["remote.origin.promisor", "true"],
      ["extensions.partialClone", "origin"],
    ])
      git(["--git-dir", f.repo.managedRepoPath, "config", key, value]);
    const trace = path.join(f.home, "offline-blob.trace");
    process.env.GIT_TRACE = trace;
    expect((await fail("create", ...args(f, "BLOB"))).message).toContain(
      "Required checkout objects"
    );
    delete process.env.GIT_TRACE;
    expect(readFileSync(trace, "utf8")).not.toMatch(/\bfetch\b/);
    expect(branch(f)).toBe(f.fresh);
    expect(existsSync(path.join(f.home, "worktrees", "BLOB"))).toBe(false);
  });
  it.each(["filter", "submodule"])(
    "refuses unsupported %s trees before creating a checkout or running configured programs",
    async (kind) => {
      const f = await fixture();
      const marker = path.join(f.home, "configured-program-ran");
      const readme = git([
        "--git-dir",
        f.repo.managedRepoPath,
        "rev-parse",
        `${f.local}:README.md`,
      ]);
      let entries = `100644 blob ${readme}\tREADME.md\n`;
      if (kind === "filter") {
        const attr = git(
          ["--git-dir", f.repo.managedRepoPath, "hash-object", "-w", "--stdin"],
          "*.md filter=outpost-test\n"
        );
        entries += `100644 blob ${attr}\t.gitattributes\n`;
        git([
          "--git-dir",
          f.repo.managedRepoPath,
          "config",
          "filter.outpost-test.clean",
          `node -e "require('fs').writeFileSync(${JSON.stringify(marker)},'executed')"`,
        ]);
      } else entries += `160000 commit ${f.local}\tnested\n`;
      const tree = git(["--git-dir", f.repo.managedRepoPath, "mktree"], entries);
      const commit = git(
        ["--git-dir", f.repo.managedRepoPath, "commit-tree", tree, "-p", f.local],
        "unsupported tree\n"
      );
      git(["--git-dir", f.repo.managedRepoPath, "update-ref", "refs/heads/borrowed/work", commit]);
      const error = await fail("create", ...args(f, "UNSUPPORTED"));
      expect(error.message).toContain(kind === "filter" ? "filter" : "submodule");
      expect(existsSync(marker)).toBe(false);
      expect(branch(f)).toBe(commit);
      expect(existsSync(path.join(f.home, "worktrees", "UNSUPPORTED"))).toBe(false);
    }
  );
  it("refuses inherited index redirection before any mutation", async () => {
    const f = await fixture();
    borrow(f);
    const alternate = path.join(f.home, "alternate-index");
    writeFileSync(alternate, "user bytes\n");
    process.env.GIT_INDEX_FILE = alternate;
    expect((await fail("create", ...args(f, "REDIRECT"))).message).toContain("GIT_INDEX_FILE");
    delete process.env.GIT_INDEX_FILE;
    expect(readFileSync(alternate, "utf8")).toBe("user bytes\n");
    expect(branch(f)).toBe(f.local);
    expect(existsSync(path.join(f.home, ".mutation.lock"))).toBe(false);
  });
  it("refuses foreign owned-storage identity without touching branch-only work", async () => {
    const f = await fixture();
    borrow(f);
    git(["--git-dir", f.repo.managedRepoPath, "config", "outpost.repository-id", "foreign"]);
    await fail("create", ...args(f, "FOREIGN"));
    expect(branch(f)).toBe(f.local);
    expect(git(["--git-dir", f.repo.managedRepoPath, "config", "outpost.repository-id"])).toBe(
      "foreign"
    );
    expect(existsSync(path.join(f.home, "worktrees", "FOREIGN"))).toBe(false);
  });
  it("preserves a same-commit symbolic ref installed by a lock-bypassing writer after attachment", async () => {
    const f = await fixture();
    borrow(f);
    const checked = hook(
      "create-worktree",
      () => {
        writeFileSync(
          path.join(f.repo.managedRepoPath, "refs", "heads", "borrowed", "work"),
          "ref: refs/heads/main\n"
        );
      },
      "confirmed"
    );
    expect((await fail("create", ...args(f, "LATESYM"))).message).toContain("symbolic");
    checked();
    expect(
      git(["--git-dir", f.repo.managedRepoPath, "symbolic-ref", "refs/heads/borrowed/work"])
    ).toBe("refs/heads/main");
    expect(git(["--git-dir", f.repo.managedRepoPath, "rev-parse", "refs/heads/main"])).toBe(
      f.local
    );
    expect(existsSync(path.join(f.home, "workspaces", "LATESYM.json"))).toBe(false);
  });
  it.each([205, 206, 220])(
    "reuses at the supported full-plan Windows boundary or refuses before mutation at %ibyte managed root",
    async (managedBytes) => {
      const f = await createManagedRepoFixture({ repoName: "outpost-create-repo-fixed0" });
      const outer = realpathSync.native(createTempDir("op-r-"));
      const baseline = localManagedRepoPath(path.join(outer, "h"), f.tempRemote);
      const pad = managedBytes - Buffer.byteLength(baseline, "utf8");
      expect(pad).toBeGreaterThanOrEqual(0);
      const home = path.join(outer, `h${"x".repeat(pad)}`);
      mkdirSync(home);
      process.env.OUTPOST_HOME = home;
      await ok("init");
      await ok("repo", "add", f.tempRepo);
      const repo = readRegistry(home).repos[0];
      expect(Buffer.byteLength(repo.managedRepoPath, "utf8")).toBe(managedBytes);
      const sha = git(["--git-dir", repo.managedRepoPath, "rev-parse", "refs/heads/main"]);
      git(["--git-dir", repo.managedRepoPath, "update-ref", "refs/heads/borrowed/work", sha]);
      if (managedBytes === 205 || managedBytes === 206) {
        const sentinel = path.join(repo.managedRepoPath, "worktrees", repo.name);
        mkdirSync(path.dirname(sentinel), { recursive: true });
        writeFileSync(sentinel, "foreign admin sentinel\n");
      }
      const before = refs(repo.managedRepoPath);
      const config = readFileSync(path.join(home, "config.json"));
      const registry = readFileSync(path.join(home, "repos.json"));
      const command = [
        "--ticket",
        "BOUNDARY",
        "--type",
        "feat",
        "--repo",
        repo.id,
        "--reuse-branch",
        "borrowed/work",
      ];
      if (managedBytes > 205 && process.platform === "win32") {
        expect((await fail("create", ...command)).message).toContain("maximum 243");
        expect(readFileSync(path.join(home, "config.json"))).toEqual(config);
        expect(readFileSync(path.join(home, "repos.json"))).toEqual(registry);
        expect(existsSync(path.join(home, "worktrees", "BOUNDARY"))).toBe(false);
      } else {
        const created = await ok("create", ...command);
        const checkout = created.worktrees[0].path;
        expect(git(["-C", checkout, "rev-parse", "HEAD"])).toBe(sha);
        const admin = readFileSync(path.join(checkout, ".git"), "utf8")
          .replace(/^gitdir: /, "")
          .trim();
        if (managedBytes === 205) expect(admin.length).toBe(243);
        await ok("workspace", "resume", "BOUNDARY");
        await ok("workspace", "remove", "BOUNDARY");
      }
      expect(refs(repo.managedRepoPath)).toBe(before);
      expect(git(["-C", f.tempRepo, "rev-parse", "HEAD"])).toBe(sha);
    }
  );

  it("returns structured failure instead of admitting metadata when branch-lock release is unconfirmed", async () => {
    const f = await fixture();
    borrow(f);
    const original = BranchAdapter.acquireBranchVerification;
    vi.spyOn(BranchAdapter, "acquireBranchVerification").mockImplementation((...input) =>
      original(...input).pipe(
        Effect.map((lock) => ({
          ...lock,
          release: Effect.fail(
            systemError({
              _tag: "Unknown",
              module: "ChildProcess",
              method: "execute",
              description: "injected unconfirmed-branch-lock-release; inspect operation journal",
            })
          ),
        }))
      )
    );
    const error = await fail("create", ...args(f, "RELEASE"));
    expect(error.message).toContain("unconfirmed-branch-lock-release");
    expect(branch(f)).toBe(f.local);
    expect(existsSync(path.join(f.home, "workspaces", "RELEASE.json"))).toBe(false);
    expect(journal(f.home)).toContain("release-existing-branch-lock");
    expect(
      existsSync(path.join(f.repo.managedRepoPath, "refs", "heads", "borrowed", "work.lock"))
    ).toBe(false);
  });
});
