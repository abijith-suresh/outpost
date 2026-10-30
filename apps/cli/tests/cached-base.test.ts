import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync, renameSync, symlinkSync } from "node:fs";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vitest";
import * as Cached from "../src/cached-base.ts";
import { ManifestSchema } from "../src/workspace-manifest.ts";
import {
  createManagedRepoFixture,
  createTempDir,
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
    { env: { ...process.env, GIT_TRACE: "" }, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
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
function cached(id: string, ticket = "CACHE", base = "topic/sub", remote = "team") {
  return [
    "--ticket",
    ticket,
    "--type",
    "feat",
    "--repo",
    id,
    "--base-source",
    "cached-remote",
    "--remote",
    remote,
    "--base",
    base,
  ];
}
async function cachedFixture() {
  const f = await fixture();
  git(
    f.source,
    "remote",
    "add",
    "team",
    "https://fixture-user:FIXTURE_SECRET_42@invalid.example/no-contact"
  );
  git(f.source, "remote", "add", "other", "https://invalid.example/other");
  git(f.source, "update-ref", "refs/remotes/team/topic/sub", f.sha);
  writeFileSync(path.join(f.source, "README"), "local only advanced\n");
  git(f.source, "commit", "-am", "local only");
  const local = git(f.source, "rev-parse", "HEAD");
  const marker = path.join(f.home, "MUST-NOT-RUN");
  git(
    f.source,
    "config",
    "credential.helper",
    `!echo called > "${marker.replaceAll("\\", "/")}"; exit 99`
  );
  git(f.source, "config", "core.askPass", `echo called > "${marker.replaceAll("\\", "/")}"`);
  const trace = path.join(f.home, "trace");
  process.env.GIT_TRACE = trace;
  return { ...f, local, marker, trace };
}
function noSecret(home: string, diagnostic = "") {
  expect(diagnostic).not.toContain("FIXTURE_SECRET_42");
  for (const [file] of Object.entries(snapshot(home))) {
    expect(readFileSync(file, "utf8"), file).not.toContain("FIXTURE_SECRET_42");
  }
}

describe("explicit borrowed cached bases", () => {
  it.each(["topic/sub", "refs/heads/topic/sub"])(
    "pins literal named cache for %s and retains original provenance through lifecycle",
    async (base) => {
      const f = await cachedFixture();
      writeFileSync(path.join(f.source, "dirty"), "source work\n");
      const before = snapshot(f.source);
      const preview = await ok("create", ...cached(f.repo.id, "CACHE", base), "--dry-run");
      expect(preview.worktrees[0]).toMatchObject({
        baseCommit: f.sha,
        baseRemote: "team",
        remoteRef: "refs/heads/topic/sub",
        baseRef: "refs/remotes/team/topic/sub",
        requestedBase: base,
      });
      const made = await ok("create", ...cached(f.repo.id, "CACHE", base));
      expect(git(made.worktrees[0].path, "rev-parse", "HEAD")).toBe(f.sha);
      const mf = path.join(f.home, "workspaces", "CACHE.json");
      const manifest = JSON.parse(readFileSync(mf, "utf8"));
      expect(manifest.version).toBe(6);
      for (const changed of [
        { baseRemote: "team.lock", baseRef: "refs/remotes/team.lock/topic/sub" },
        {
          base: "/topic/sub",
          requestedBase: "/topic/sub",
          remoteRef: "refs/heads//topic/sub",
          baseRef: "refs/remotes/team//topic/sub",
        },
      ])
        expect(() =>
          Schema.decodeUnknownSync(ManifestSchema)(
            {
              ...manifest,
              repositories: manifest.repositories.map((r: object) => ({ ...r, ...changed })),
            },
            { onExcessProperty: "error" }
          )
        ).toThrow();

      Schema.decodeUnknownSync(ManifestSchema)(manifest, { onExcessProperty: "error" });
      for (const update of [
        { version: 5 },
        { version: 7 },
        {
          repositories: manifest.repositories.map((r: object) => ({
            ...r,
            remoteRef: "refs/heads/other",
          })),
        },
      ])
        expect(() =>
          Schema.decodeUnknownSync(ManifestSchema)(
            { ...manifest, ...update },
            { onExcessProperty: "error" }
          )
        ).toThrow();
      expect(manifest.repositories[0]).toMatchObject({
        baseRemote: "team",
        remoteRef: "refs/heads/topic/sub",
        baseCommit: f.sha,
      });
      expect(readFileSync(path.join(f.home, "worktrees", "CACHE", "AGENTS.md"), "utf8")).toContain(
        "unverified cached snapshot"
      );
      git(f.source, "config", "--unset-all", "remote.team.url");
      const resumed = await ok("workspace", "resume", "CACHE");
      expect(resumed.worktrees[0].originalBase).toMatchObject({
        baseRemote: "team",
        remoteRef: "refs/heads/topic/sub",
        baseCommit: f.sha,
      });
      expect((await ok("workspace", "show", "CACHE")).worktrees[0].baseRemote).toBe("team");
      await ok("workspace", "remove", "CACHE");
      delete before[path.join(f.source, ".git", "config")]; // deliberate external configuration edit
      preserved(before);
      expect(readFileSync(f.trace, "utf8")).not.toMatch(
        /run_command:.*(?:fetch|upload-pack|credential|ls-remote)/
      );
      const fs = await import("node:fs");
      expect(fs.existsSync(f.marker)).toBe(false);
      noSecret(f.home);
    }
  );
  it.each(["absent", "custom"])("ignores %s fetch mappings without fallback", async (kind) => {
    const f = await cachedFixture();
    git(f.source, "config", "--unset-all", "remote.team.fetch");
    if (kind === "custom")
      git(f.source, "config", "remote.team.fetch", "+refs/heads/*:refs/cache/custom/*");
    await ok("create", ...cached(f.repo.id, "GOOD"), "--dry-run");
    git(f.source, "update-ref", "refs/cache/custom/missing", f.sha);
    const before = snapshot(f.source);
    const r = await cli("create", ...cached(f.repo.id, "MISSING", "missing"));
    expect(r.code, r.diagnostic).toBe(1);
    expect(r.diagnostic).toContain("refs/remotes/team/missing");
    preserved(before);
    noSecret(f.home, r.diagnostic);
  });
  it.each(["missing-url", "multiple-url", "malformed"])(
    "redacts source %s without helper/transport or mutation",
    async (kind) => {
      const f = await cachedFixture();
      if (kind === "missing-url") git(f.source, "config", "--unset-all", "remote.team.url");
      if (kind === "multiple-url")
        git(
          f.source,
          "config",
          "--add",
          "remote.team.url",
          "https://FIXTURE_SECRET_42@invalid.example/two"
        );
      if (kind === "malformed")
        writeFileSync(
          path.join(f.source, ".git", "config"),
          readFileSync(path.join(f.source, ".git", "config"), "utf8") + '\n["FIXTURE_SECRET_42\n'
        );
      const before = snapshot(f.source);
      for (const dry of [true, false]) {
        const r = await cli("create", ...cached(f.repo.id), ...(dry ? ["--dry-run"] : []));
        expect(r.code, r.diagnostic).toBe(1);
        noSecret(f.home, r.diagnostic);
      }
      preserved(before);
      expect(readdirSync(path.join(f.home, "workspaces"))).toEqual([]);
    }
  );
  it.each([
    "HEAD",
    "default",
    "refs/tags/v1",
    "refs/remotes/team/topic/sub",
    "main~1",
    "a".repeat(40),
  ])("refuses unsupported base %s before effects", async (base) => {
    const f = await cachedFixture();
    const before = snapshot(f.source);
    const r = await cli("create", ...cached(f.repo.id, "BAD", base));
    expect(r.code, r.diagnostic).toBe(1);
    preserved(before);
    noSecret(f.home, r.diagnostic);
  });
  it.each(["symbolic", "dangling", "alias", "missing-object"])(
    "refuses %s cached dependencies",
    async (kind) => {
      const f = await cachedFixture();
      const ref = "refs/remotes/team/topic/sub";
      if (kind === "symbolic" || kind === "dangling")
        git(
          f.source,
          "symbolic-ref",
          ref,
          kind === "symbolic" ? "refs/heads/main" : "refs/heads/absent"
        );
      if (kind === "alias") {
        const target = path.join(f.source, ".git", ...ref.split("/"));
        const held = path.join(createTempDir("outpost-cache-alias-"), "held");
        renameSync(target, held);
        symlinkSync(held, target, "file");
      }
      if (kind === "missing-object") {
        const object = path.join(f.source, ".git", "objects", f.sha.slice(0, 2), f.sha.slice(2));
        renameSync(object, `${object}-held`);
      }
      const before = snapshot(f.source);
      const r = await cli("create", ...cached(f.repo.id));
      expect(r.code, r.diagnostic).toBe(1);
      preserved(before);
      noSecret(f.home, r.diagnostic);
    }
  );
  it.each(["group/team", "-team", "team..name", "x".repeat(65)])(
    "refuses unsupported remote spelling %s",
    async (remote) => {
      const f = await cachedFixture();
      const before = snapshot(f.source);
      const r = await cli("create", ...cached(f.repo.id, "BAD", "topic/sub", remote));
      expect(r.code, r.diagnostic).toBe(1);
      preserved(before);
      noSecret(f.home, r.diagnostic);
    }
  );
  it("bounds effective metadata and refuses missing cached promisor objects without helpers", async () => {
    const f = await cachedFixture();
    git(f.source, "config", "remote.team.url", "https://invalid.example/" + "x".repeat(5000));
    expect((await cli("create", ...cached(f.repo.id))).code).toBe(1);
    git(f.source, "config", "remote.team.url", "https://FIXTURE_SECRET_42@invalid.example/missing");
    git(f.source, "config", "remote.team.promisor", "true");
    const blob = git(f.source, "rev-parse", `${f.sha}:README`);
    const object = path.join(f.source, ".git", "objects", blob.slice(0, 2), blob.slice(2));
    renameSync(object, `${object}-held`);
    const before = snapshot(f.source);
    const r = await cli("create", ...cached(f.repo.id));
    expect(r.code, r.diagnostic).toBe(1);
    preserved(before);
    noSecret(f.home, r.diagnostic);
    const fs = await import("node:fs");
    expect(fs.existsSync(f.marker)).toBe(false);
    expect(readFileSync(f.trace, "utf8")).not.toMatch(
      /run_command:.*(?:fetch|credential|upload-pack)/
    );
  });
  it("redacts configuration corruption after preflight and preserves recovery state", async () => {
    const f = await cachedFixture();
    const original = Cached.resolveBorrowedCache;
    const spy = vi
      .spyOn(Cached, "resolveBorrowedCache")
      .mockImplementation((...input) =>
        original(...input).pipe(
          Effect.tap(() =>
            Effect.sync(() =>
              writeFileSync(path.join(f.source, ".git", "config"), '["FIXTURE_SECRET_42\n')
            )
          )
        )
      );
    const r = await cli("create", ...cached(f.repo.id));
    spy.mockRestore();
    expect(r.code, r.diagnostic).toBe(1);
    noSecret(f.home, r.diagnostic);
  });
  it("pins the actual selected SHA if cache moves after resolution", async () => {
    const f = await cachedFixture();
    const original = Cached.resolveBorrowedCache;
    const spy = vi
      .spyOn(Cached, "resolveBorrowedCache")
      .mockImplementation((...input) =>
        original(...input).pipe(
          Effect.tap(() =>
            Effect.sync(() => git(f.source, "update-ref", "refs/remotes/team/topic/sub", f.local))
          )
        )
      );
    const made = await ok("create", ...cached(f.repo.id));
    spy.mockRestore();
    expect(made.worktrees[0].baseCommit).toBe(f.sha);
    expect(git(made.worktrees[0].path, "rev-parse", "HEAD")).toBe(f.sha);
  });
  it("uses saved linked anchor includes/rewrites rather than common-only configuration", async () => {
    const f = await cachedFixture();
    const anchor = path.join(createTempDir("outpost-cache-anchor-"), "linked");
    git(f.source, "worktree", "add", "--detach", anchor, "HEAD");
    git(f.source, "config", "extensions.worktreeConfig", "true");
    const privateDir = git(anchor, "rev-parse", "--absolute-git-dir").replaceAll("\\", "/");
    const inc = path.join(f.home, "anchor.inc");
    writeFileSync(inc, '[remote "anchor"]\n url = synthetic:alias\n');
    git(
      anchor,
      "config",
      "--worktree",
      `includeIf.gitdir:${privateDir}.path`,
      inc.replaceAll("\\", "/")
    );
    git(
      anchor,
      "config",
      "--worktree",
      "url.https://FIXTURE_SECRET_42@invalid.example/.insteadOf",
      "synthetic:"
    );
    expect(git(anchor, "config", "--get-all", "remote.anchor.url")).toBe("synthetic:alias");
    expect(git(anchor, "remote", "get-url", "--all", "anchor")).toBe(
      "https://FIXTURE_SECRET_42@invalid.example/alias"
    );
    const commonDir = git(anchor, "rev-parse", "--path-format=absolute", "--git-common-dir");
    expect(() =>
      git(f.source, "--git-dir", commonDir, "config", "--get-all", "remote.anchor.url")
    ).toThrow();
    git(f.source, "update-ref", "refs/remotes/anchor/topic/sub", f.sha);
    process.env.OUTPOST_HOME = createTempDir("outpost-cache-linked-home-");
    await ok("init");
    const record = (await ok("repo", "register", anchor, "--name", "linked")).repository;
    const before = snapshot(f.source);
    await ok("create", ...cached(record.id, "LINK", "topic/sub", "anchor"));
    preserved(before);
    renameSync(anchor, `${anchor}-held`);
    expect((await ok("workspace", "resume", "LINK")).resumable).toBe(true);
    await ok("workspace", "remove", "LINK");
    noSecret(process.env.OUTPOST_HOME!);
  });
  it("refuses borrowed local with remote and incompatible managed member before mutation", async () => {
    const f = await cachedFixture();
    const before = snapshot(f.source);
    for (const source of ["local"]) {
      const a = cached(f.repo.id);
      a[a.indexOf("cached-remote")] = source;
      expect((await cli("create", ...a)).code).toBe(1);
    }
    const managed = await createManagedRepoFixture();
    await ok("repo", "add", managed.tempRepo);
    const m = (await ok("repo", "list")).repos.find(
      (r: { kind?: string }) => r.kind !== "borrowed"
    );
    const r = await cli("create", ...cached(f.repo.id), "--repo", m.id);
    expect(r.code, r.diagnostic).toBe(1);
    preserved(before);
  });
  it("supports explicit actual managed origin without changing omitted behavior", async () => {
    const managed = await createManagedRepoFixture({ repoName: "app" });
    process.env.OUTPOST_HOME = createTempDir("outpost-cache-managed-home-");
    await ok("init");
    await ok("repo", "add", managed.tempRepo);
    const m = (await ok("repo", "list")).repos.find(
      (r: { kind?: string }) => r.kind !== "borrowed"
    );
    await ok("create", ...cached(m.id, "MANAGED", "main", "origin"));
    await ok("workspace", "remove", "MANAGED");
  });
});
