import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, renameSync } from "node:fs";
import { NodeServices } from "@effect/platform-node";
import { Effect, Fiber } from "effect";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vitest";
import { runCreate } from "../src/commands/create.ts";
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
function args(
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

describe("explicit workspace base selection", () => {
  it.each(["local", "cached-remote", "fresh-remote"])(
    "uses distinct actual %s SHAs and records immutable provenance",
    async (source) => {
      const f = await fixture();
      const expected =
        source === "local" ? f.local : source === "cached-remote" ? f.cached : f.fresh;
      const created = await ok("create", ...args(f, "BASE", source));
      const member = created.worktrees[0];
      expect(member).toMatchObject({
        baseSource: source,
        requestedBase: null,
        baseRef: source === "local" ? "refs/heads/main" : "refs/remotes/origin/main",
        baseCommit: expected,
        baseResolution: "resolved",
      });
      expect(git(["-C", member.path, "rev-parse", "HEAD"])).toBe(expected);
      const manifest = JSON.parse(
        readFileSync(path.join(f.home, "workspaces", "BASE.json"), "utf8")
      );
      expect(manifest.version).toBe(3);
      expect(manifest.repositories[0]).toMatchObject({
        baseSource: source,
        requestedBase: null,
        baseCommit: expected,
      });
      expect((await ok("workspace", "show", "BASE")).worktrees[0].baseCommit).toBe(expected);
      const guidance = readFileSync(path.join(created.ticketDirectory, "AGENTS.md"), "utf8");
      expect(guidance).toContain(expected);
      expect(guidance).toContain(source);
      expect(
        git(["--git-dir", f.repo.managedRepoPath, "for-each-ref", "refs/outpost/base-fetch"])
      ).toBe("");
      checkSource(f);
    }
  );
  it("defaults to cached only and does not fetch when the remote is unavailable", async () => {
    const f = await fixture();
    renameSync(f.f.tempRemote, `${f.f.tempRemote}.offline`);
    const a = await ok("create", ...args(f, "CACHED"));
    expect(a.worktrees[0].baseCommit).toBe(f.cached);
    const b = await ok("create", ...args(f, "LOCAL", "local"));
    expect(b.worktrees[0].baseCommit).toBe(f.local);
    checkSource(f);
  });
  it("does not fall back from missing cached refs to local branches", async () => {
    const f = await fixture();
    git(["--git-dir", f.repo.managedRepoPath, "update-ref", "refs/heads/local-only", f.local]);
    await fail("create", ...args(f, "MISSING", "cached-remote", "local-only"));
    expect(existsSync(path.join(f.home, "worktrees", "MISSING"))).toBe(false);
    checkSource(f);
  });
  it("selects a full local SHA and explicitly refuses source-only objects absent from managed storage", async () => {
    const f = await fixture();
    const r = await ok("create", ...args(f, "OID", "local", f.local));
    expect(r.worktrees[0]).toMatchObject({
      baseCommit: f.local,
      baseRef: f.local,
      requestedBase: f.local,
    });
    const error = await fail("create", ...args(f, "SOURCE", "local", f.sourceOnly));
    expect(error.message).toContain("No fallback or source import");
    checkSource(f);
  });
  it("fresh dry-run and guidance preview do not fetch, mutate refs or imply a fresh SHA", async () => {
    const f = await fixture();
    renameSync(f.f.tempRemote, `${f.f.tempRemote}.offline`);
    const before = refs(f.repo.managedRepoPath);
    const config = readFileSync(path.join(f.home, "config.json"));
    const registry = readFileSync(path.join(f.home, "repos.json"));
    const r = await ok("create", ...args(f, "PREVIEW", "fresh-remote"), "--dry-run");
    expect(r.worktrees[0]).toMatchObject({
      baseSource: "fresh-remote",
      baseCommit: null,
      baseResolution: "fetch-required",
    });
    const guidance = await ok("guidance", "preview", ...args(f, "PREVIEW", "fresh-remote"));
    expect(guidance.content).toContain("fetch-required");
    expect(guidance.content).not.toContain(f.fresh);
    expect(refs(f.repo.managedRepoPath)).toBe(before);
    expect(readFileSync(path.join(f.home, "config.json"))).toEqual(config);
    expect(readFileSync(path.join(f.home, "repos.json"))).toEqual(registry);
    expect(existsSync(path.join(f.home, ".mutation.lock"))).toBe(false);
    expect(existsSync(path.join(f.home, "worktrees", "PREVIEW"))).toBe(false);
  });
  it.each(["offline", "missing-ref"])(
    "fails a fresh %s request honestly without cached/local fallback",
    async (kind) => {
      const f = await fixture();
      if (kind === "offline") renameSync(f.f.tempRemote, `${f.f.tempRemote}.offline`);
      else git(["--git-dir", f.f.tempRemote, "update-ref", "-d", "refs/heads/main"]);
      const before = refs(f.repo.managedRepoPath);
      const error = await fail("create", ...args(f, "FRESHFAIL", "fresh-remote"));
      expect(error.message).toContain("No cached/local fallback");
      expect(refs(f.repo.managedRepoPath)).toBe(before);
      expect(existsSync(path.join(f.home, "worktrees", "FRESHFAIL"))).toBe(false);
      checkSource(f);
    }
  );
  it("ignores legacy mirror/prune/tag configuration and never rewrites owned local branches", async () => {
    const f = await fixture();
    git(["--git-dir", f.repo.managedRepoPath, "config", "remote.origin.fetch", "+refs/*:refs/*"]);
    git(["--git-dir", f.repo.managedRepoPath, "config", "remote.origin.mirror", "true"]);
    git(["--git-dir", f.repo.managedRepoPath, "config", "fetch.prune", "true"]);
    git(["--git-dir", f.repo.managedRepoPath, "config", "fetch.pruneTags", "true"]);
    git(["--git-dir", f.repo.managedRepoPath, "tag", "local-tag", f.local]);
    const config = readFileSync(path.join(f.repo.managedRepoPath, "config"));
    const r = await ok("create", ...args(f, "SAFE", "fresh-remote"));
    expect(r.worktrees[0].baseCommit).toBe(f.fresh);
    expect(git(["--git-dir", f.repo.managedRepoPath, "rev-parse", "refs/tags/local-tag"])).toBe(
      f.local
    );
    expect(readFileSync(path.join(f.repo.managedRepoPath, "config"))).toEqual(config);
    checkSource(f);
  });
  it("refuses symbolic tracking refs that could target a user branch before fetching", async () => {
    const f = await fixture();
    git([
      "--git-dir",
      f.repo.managedRepoPath,
      "symbolic-ref",
      "refs/remotes/origin/main",
      "refs/heads/main",
    ]);
    const before = refs(f.repo.managedRepoPath);
    await fail("create", ...args(f, "SYM", "fresh-remote"));
    expect(refs(f.repo.managedRepoPath)).toBe(before);
    checkSource(f);
  });
  it("pins a resolved SHA when the requested base ref changes before branch creation", async () => {
    const f = await fixture();
    const original = Store.writeJsonFileAtomic;
    let moved = false;
    vi.spyOn(Store, "writeJsonFileAtomic").mockImplementation((file, value) => {
      const v = value as { steps?: Array<{ action?: string }> };
      if (!moved && v.steps?.at(-1)?.action === "create-workspace") {
        moved = true;
        git([
          "--git-dir",
          f.repo.managedRepoPath,
          "update-ref",
          "refs/remotes/origin/main",
          f.local,
        ]);
      }
      return original(file, value);
    });
    const r = await ok("create", ...args(f, "RACE"));
    expect(moved).toBe(true);
    expect(r.worktrees[0].baseCommit).toBe(f.cached);
    expect(git(["-C", r.worktrees[0].path, "rev-parse", "HEAD"])).toBe(f.cached);
    checkSource(f);
  });
  it("refuses false provenance and preserves an advanced target branch/worktree", async () => {
    const f = await fixture();
    const original = Store.writeJsonFileAtomic;
    let moved = false;
    vi.spyOn(Store, "writeJsonFileAtomic").mockImplementation((file, value) => {
      const v = value as { steps?: Array<{ action?: string; phase?: string }> };
      const step = v.steps?.at(-1);
      if (!moved && step?.action === "create-branch" && step.phase === "confirmed") {
        moved = true;
        git(["--git-dir", f.repo.managedRepoPath, "update-ref", "refs/heads/feat/TARGET", f.local]);
      }
      return original(file, value);
    });
    const error = await fail("create", ...args(f, "TARGET"));
    expect(error.message).toContain("false base provenance");
    expect(git(["--git-dir", f.repo.managedRepoPath, "rev-parse", "refs/heads/feat/TARGET"])).toBe(
      f.local
    );
    expect(existsSync(path.join(f.home, "workspaces", "TARGET.json"))).toBe(false);
    expect(existsSync(path.join(f.home, "worktrees", "TARGET", f.repo.name))).toBe(true);
    checkSource(f);
  });
  it("preflights a branch conflict before any fresh mutation", async () => {
    const f = await fixture();
    git(["--git-dir", f.repo.managedRepoPath, "branch", "feat/CONFLICT", f.local]);
    const before = refs(f.repo.managedRepoPath);
    await fail("create", ...args(f, "CONFLICT", "fresh-remote"));
    expect(refs(f.repo.managedRepoPath)).toBe(before);
    checkSource(f);
  });
  it("never deletes a user branch reached through a target symref during rollback", async () => {
    const f = await fixture();
    git(["--git-dir", f.repo.managedRepoPath, "branch", "user-owned", f.cached]);
    const original = Store.writeJsonFileAtomic;
    let raced = false;
    vi.spyOn(Store, "writeJsonFileAtomic").mockImplementation((file, value) => {
      const last = (value as { steps?: Array<{ action?: string; phase?: string }> }).steps?.at(-1);
      if (!raced && last?.action === "create-branch" && last.phase === "confirmed") {
        raced = true;
        git([
          "--git-dir",
          f.repo.managedRepoPath,
          "symbolic-ref",
          "refs/heads/feat/ROLLBACKSYM",
          "refs/heads/user-owned",
        ]);
        return Effect.fail(
          new Store.StoreError({ message: "injected journal failure after target symref race" })
        );
      }
      return original(file, value);
    });
    await fail("create", ...args(f, "ROLLBACKSYM"));
    expect(raced).toBe(true);
    expect(git(["--git-dir", f.repo.managedRepoPath, "rev-parse", "refs/heads/user-owned"])).toBe(
      f.cached
    );
    expect(
      git(["--git-dir", f.repo.managedRepoPath, "symbolic-ref", "refs/heads/feat/ROLLBACKSYM"])
    ).toBe("refs/heads/user-owned");
    expect(existsSync(path.join(f.home, "workspaces", "ROLLBACKSYM.json"))).toBe(false);
    checkSource(f);
  });
  it("keeps legacy root interpretation and refuses incomplete v3 provenance", async () => {
    const f = await fixture();
    await ok("create", ...args(f, "LEGACY"));
    const manifestPath = path.join(f.home, "workspaces", "LEGACY.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const oldRoot = manifest.worktreesRoot;
    delete manifest.version;
    delete manifest.worktreesRoot;
    for (const repo of manifest.repositories)
      for (const key of ["baseSource", "requestedBase", "baseRef", "baseCommit"]) delete repo[key];
    const bytes = JSON.stringify(manifest);
    writeFileSync(manifestPath, bytes);
    await ok("config", "set", "worktreesRoot", path.join(createTempDir(), "future"));
    expect((await ok("workspace", "show", "LEGACY")).ticketDirectory).toBe(
      path.join(oldRoot, "LEGACY")
    );
    expect(readFileSync(manifestPath, "utf8")).toBe(bytes);
    await ok("workspace", "remove", "LEGACY");
    await ok("create", ...args(f, "SCHEMA"));
    const nextPath = path.join(f.home, "workspaces", "SCHEMA.json");
    const next = JSON.parse(readFileSync(nextPath, "utf8"));
    delete next.repositories[0].baseCommit;
    writeFileSync(nextPath, JSON.stringify(next));
    expect((await ok("workspace", "show", "SCHEMA")).status).toBe("invalid");
    await fail("workspace", "remove", "SCHEMA");
  });
  it("preserves earlier confirmed fresh receipts when a later repository fails", async () => {
    const f = await fixture();
    const second = await createManagedRepoFixture({ defaultBranch: "other" });
    await ok("repo", "add", second.tempRepo);
    const secondRepo = readRegistry(f.home).repos.find((r) => r.id !== f.repo.id);
    expect(secondRepo).toBeDefined();
    renameSync(second.tempRemote, `${second.tempRemote}.offline`);
    const error = await fail(
      "create",
      ...args(f, "PARTIAL", "fresh-remote"),
      "--repo",
      secondRepo?.id as string
    );
    expect(error.message).toContain("earlier tracking/receipt refs");
    expect(
      git(["--git-dir", f.repo.managedRepoPath, "rev-parse", "refs/remotes/origin/main"])
    ).toBe(f.fresh);
    expect(
      git(["--git-dir", f.repo.managedRepoPath, "for-each-ref", "refs/outpost/base-fetch"])
    ).not.toBe("");
    expect(existsSync(path.join(f.home, "worktrees", "PARTIAL"))).toBe(false);
    const journals = readdirSync(path.join(f.home, "operations"))
      .map((file) => readFileSync(path.join(f.home, "operations", file), "utf8"))
      .join("\n");
    expect(journals).toContain(f.fresh);
    expect(journals).toContain("confirmed");
    checkSource(f);
  });
  it("resolves each selected repository's recorded default independently", async () => {
    const f = await fixture();
    const second = await createManagedRepoFixture({ defaultBranch: "develop" });
    await ok("repo", "add", second.tempRepo);
    const other = readRegistry(f.home).repos.find((repo) => repo.id !== f.repo.id);
    expect(other).toBeDefined();
    const r = await ok("create", ...args(f, "DEFAULTS"), "--repo", other?.id as string);
    expect(r.worktrees.map((w: { base: string }) => w.base)).toEqual(["main", "develop"]);
    for (const w of r.worktrees)
      expect(git(["-C", w.path, "rev-parse", "HEAD"])).toBe(w.baseCommit);
    checkSource(f);
  });
  it("requires an explicit base if the managed default is detached", async () => {
    const f = await fixture();
    writeFileSync(path.join(f.repo.managedRepoPath, "HEAD"), `${f.local}\n`);
    await fail("create", ...args(f, "DETACHED"));
    const r = await ok("create", ...args(f, "EXPLICIT", "cached-remote", "main"));
    expect(r.worktrees[0].baseCommit).toBe(f.cached);
    checkSource(f);
  });
  it("captures the fetched receipt honestly if the tracking ref races before CAS", async () => {
    const f = await fixture();
    const original = Store.writeJsonFileAtomic;
    let raced = false;
    vi.spyOn(Store, "writeJsonFileAtomic").mockImplementation((file, value) => {
      const last = (value as { steps?: Array<{ action?: string; phase?: string }> }).steps?.at(-1);
      if (!raced && last?.action === "fetch-workspace-base" && last.phase === "confirmed") {
        raced = true;
        git([
          "--git-dir",
          f.repo.managedRepoPath,
          "update-ref",
          "refs/remotes/origin/main",
          f.local,
        ]);
      }
      return original(file, value);
    });
    const error = await fail("create", ...args(f, "TRACKINGRACE", "fresh-remote"));
    expect(error.message).toContain("changed during fresh selection");
    expect(raced).toBe(true);
    expect(
      git([
        "--git-dir",
        f.repo.managedRepoPath,
        "for-each-ref",
        "--format=%(objectname)",
        "refs/outpost/base-fetch",
      ])
    ).toBe(f.fresh);
    expect(existsSync(path.join(f.home, "workspaces", "TRACKINGRACE.json"))).toBe(false);
    checkSource(f);
  });
  it("never dereferences a tracking symref installed concurrently into a user branch", async () => {
    const f = await fixture();
    git(["--git-dir", f.repo.managedRepoPath, "branch", "user-owned", f.cached]);
    const original = Store.writeJsonFileAtomic;
    let raced = false;
    vi.spyOn(Store, "writeJsonFileAtomic").mockImplementation((file, value) => {
      const last = (value as { steps?: Array<{ action?: string; phase?: string }> }).steps?.at(-1);
      if (!raced && last?.action === "fetch-workspace-base" && last.phase === "confirmed") {
        raced = true;
        git([
          "--git-dir",
          f.repo.managedRepoPath,
          "symbolic-ref",
          "refs/remotes/origin/main",
          "refs/heads/user-owned",
        ]);
      }
      return original(file, value);
    });
    const r = await ok("create", ...args(f, "SYMRACE", "fresh-remote"));
    expect(r.worktrees[0].baseCommit).toBe(f.fresh);
    expect(git(["--git-dir", f.repo.managedRepoPath, "rev-parse", "refs/heads/user-owned"])).toBe(
      f.cached
    );
    expect(raced).toBe(true);
    checkSource(f);
  });
  it("keeps confirmed fresh receipts and source work on cancellation before workspace mutation", async () => {
    const f = await fixture();
    const original = Store.writeJsonFileAtomic;
    let gated = false;
    let markReached = () => {};
    const reached = new Promise<void>((resolve) => {
      markReached = resolve;
    });
    vi.spyOn(Store, "writeJsonFileAtomic").mockImplementation((file, value) => {
      const last = (value as { steps?: Array<{ action?: string; phase?: string }> }).steps?.at(-1);
      if (!gated && last?.action === "fetch-workspace-base" && last.phase === "confirmed") {
        gated = true;
        return original(file, value).pipe(
          Effect.andThen(Effect.sync(markReached)),
          Effect.andThen(Effect.never)
        );
      }
      return original(file, value);
    });
    const fiber = Effect.runFork(
      runCreate(args(f, "CANCEL", "fresh-remote"), { interactive: false }).pipe(
        Effect.provide(NodeServices.layer)
      )
    );
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        reached,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("fresh receipt gate was not reached")),
            10000
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
      await Effect.runPromise(Fiber.interrupt(fiber));
    }
    expect(
      git([
        "--git-dir",
        f.repo.managedRepoPath,
        "for-each-ref",
        "--format=%(objectname)",
        "refs/outpost/base-fetch",
      ])
    ).toBe(f.fresh);
    expect(existsSync(path.join(f.home, "worktrees", "CANCEL"))).toBe(false);
    expect(existsSync(path.join(f.home, ".mutation.lock"))).toBe(false);
    const journal = readdirSync(path.join(f.home, "operations"))
      .map((file) => readFileSync(path.join(f.home, "operations", file), "utf8"))
      .join("\n");
    expect(journal).toContain(f.fresh);
    expect(journal).toContain("confirmed");
    checkSource(f);
  });
  it("uses a v3 manifest that the previous strict version contract rejects", async () => {
    const f = await fixture();
    await ok("create", ...args(f, "VERSION"));
    const state = JSON.parse(readFileSync(path.join(f.home, "workspaces", "VERSION.json"), "utf8"));
    const old = Schema.Struct({
      version: Schema.optional(Schema.Literal(2)),
      worktreesRoot: Schema.optional(Schema.String),
      ticket: Schema.String,
      type: Schema.String,
      branch: Schema.String,
      createdAt: Schema.String,
      workspacePath: Schema.String,
      repositories: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          name: Schema.String,
          base: Schema.String,
          managedPath: Schema.String,
          worktreePath: Schema.String,
        })
      ),
    });
    expect(() => Schema.decodeUnknownSync(old)(state, { onExcessProperty: "error" })).toThrow();
    const file = path.join(f.home, "workspaces", "VERSION.json");
    for (const change of [
      { ...state, version: 4 },
      {
        ...state,
        repositories: state.repositories.map((repo: Record<string, unknown>) => ({
          ...repo,
          baseCommit: "not-an-oid",
        })),
      },
    ]) {
      const bytes = JSON.stringify(change);
      writeFileSync(file, bytes);
      await fail("workspace", "remove", "VERSION");
      expect(readFileSync(file, "utf8")).toBe(bytes);
    }
  });

  it("refuses provenance when checkout contents race even though HEAD returns to the pinned commit", async () => {
    const f = await fixture();
    const original = Store.writeJsonFileAtomic;
    let raced = false;
    vi.spyOn(Store, "writeJsonFileAtomic").mockImplementation((file, value) => {
      const step = (
        value as { steps?: Array<{ action?: string; phase?: string; worktreePath?: string }> }
      ).steps?.at(-1);
      if (!raced && step?.action === "create-worktree" && step.phase === "confirmed") {
        raced = true;
        git(["-C", step.worktreePath as string, "read-tree", "--reset", "-u", f.local]);
      }
      return original(file, value);
    });
    await fail("create", ...args(f, "CONTENTRACE", "fresh-remote"));
    const checkout = path.join(f.home, "worktrees", "CONTENTRACE", f.repo.name);
    expect(raced).toBe(true);
    expect(git(["-C", checkout, "rev-parse", "HEAD"])).toBe(f.fresh);
    expect(git(["-C", checkout, "status", "--porcelain"])).not.toBe("");
    expect(existsSync(path.join(f.home, "workspaces", "CONTENTRACE.json"))).toBe(false);
    expect(
      git(["--git-dir", f.repo.managedRepoPath, "rev-parse", "refs/heads/feat/CONTENTRACE"])
    ).toBe(f.fresh);
    checkSource(f);
  });
  it.each([
    ["local", true],
    ["local", false],
    ["cached-remote", true],
    ["cached-remote", false],
  ] as const)(
    "%s dry-run=%s never lazily fetches a missing promised commit",
    async (source, dryRun) => {
      const f = await fixture();
      let requested = f.fresh;
      if (source === "cached-remote") {
        requested = "promised";
        const dir = path.join(f.repo.managedRepoPath, "refs", "remotes", "origin");
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, "promised"), `${f.fresh}\n`);
      }
      for (const [key, value] of [
        ["remote.origin.promisor", "true"],
        ["remote.origin.partialclonefilter", "blob:none"],
        ["extensions.partialClone", "origin"],
      ])
        git(["--git-dir", f.repo.managedRepoPath, "config", key, value]);
      const trace = path.join(f.home, "no-lazy-commit.trace");
      process.env.GIT_TRACE = trace;
      const before = readFileSync(path.join(f.home, "repos.json"));
      await fail(
        "create",
        ...args(f, "PROMISOR", source, requested),
        ...(dryRun ? ["--dry-run"] : [])
      );
      delete process.env.GIT_TRACE;
      expect(readFileSync(trace, "utf8")).not.toMatch(/\bfetch\b/);
      expect(readFileSync(path.join(f.home, "repos.json"))).toEqual(before);
      expect(existsSync(path.join(f.home, "worktrees", "PROMISOR"))).toBe(false);
      checkSource(f);
    }
  );
  it.each([
    ["local", true],
    ["local", false],
    ["cached-remote", true],
    ["cached-remote", false],
  ] as const)(
    "%s dry-run=%s refuses an owned commit with missing promised checkout blobs without network",
    async (source, dryRun) => {
      const f = await fixture();
      const tree = git(["-C", f.f.tempRepo, "rev-parse", `${f.fresh}^{tree}`]);
      for (const [type, oid] of [
        ["tree", tree],
        ["commit", f.fresh],
      ]) {
        const raw = execFileSync("git", ["-C", f.f.tempRepo, "cat-file", type, oid]);
        const copied = execFileSync(
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
        ).trim();
        expect(copied).toBe(oid);
      }
      git(["--git-dir", f.repo.managedRepoPath, "update-ref", "refs/heads/blob-base", f.fresh]);
      git([
        "--git-dir",
        f.repo.managedRepoPath,
        "update-ref",
        "refs/remotes/origin/blob-base",
        f.fresh,
      ]);
      for (const [key, value] of [
        ["remote.origin.promisor", "true"],
        ["remote.origin.partialclonefilter", "blob:none"],
        ["extensions.partialClone", "origin"],
      ])
        git(["--git-dir", f.repo.managedRepoPath, "config", key, value]);
      const trace = path.join(f.home, "no-lazy-blob.trace");
      process.env.GIT_TRACE = trace;
      const before = readFileSync(path.join(f.home, "repos.json"));
      const error = await fail(
        "create",
        ...args(f, "BLOB", source, "blob-base"),
        ...(dryRun ? ["--dry-run"] : [])
      );
      delete process.env.GIT_TRACE;
      expect(error.message).toContain("Required checkout objects");
      expect(readFileSync(trace, "utf8")).not.toMatch(/\bfetch\b/);
      expect(readFileSync(path.join(f.home, "repos.json"))).toEqual(before);
      expect(existsSync(path.join(f.home, "worktrees", "BLOB"))).toBe(false);
      checkSource(f);
    }
  );

  it("does not lazily fill missing checkout blobs after an explicit filtered fresh fetch", async () => {
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
    git(["--git-dir", f.repo.managedRepoPath, "update-ref", "refs/heads/promised", f.fresh]);
    git(["--git-dir", f.f.tempRemote, "config", "uploadpack.allowFilter", "true"]);
    for (const [key, value] of [
      ["remote.origin.promisor", "true"],
      ["remote.origin.partialclonefilter", "blob:none"],
      ["extensions.partialClone", "origin"],
    ])
      git(["--git-dir", f.repo.managedRepoPath, "config", key, value]);
    const error = await fail("create", ...args(f, "FILTERED", "fresh-remote"));
    expect(error.message).toContain("Required checkout objects");
    expect(error.message).toContain("not rolled back");
    expect(existsSync(path.join(f.home, "workspaces", "FILTERED.json"))).toBe(false);
    expect(
      git([
        "--git-dir",
        f.repo.managedRepoPath,
        "for-each-ref",
        "--format=%(objectname)",
        "refs/outpost/base-fetch",
      ])
    ).toBe(f.fresh);
    checkSource(f);
  });
});
