import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
} from "node:fs";
import { NodeServices } from "@effect/platform-node";
import { Effect, FileSystem } from "effect";
import { describe, expect, it, vi } from "vitest";
import * as Process from "../src/child-process.ts";
import { RESUME_LIMITS, runWorkspaceResume } from "../src/commands/workspace-resume.ts";
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
function git(args: string[], input?: string | Buffer) {
  return execFileSync(
    "git",
    [
      ...(process.platform === "win32" ? ["-c", "core.longpaths=true"] : []),
      "-c",
      "user.name=Outpost Resume Test",
      "-c",
      "user.email=resume@example.invalid",
      ...args,
    ],
    { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], input }
  ).trim();
}
async function cli(args: string[], expected = 0) {
  const out = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
  out.mockClear();
  err.mockClear();
  const code = await runCli([...args, "--json"]);
  const stdout = out.mock.calls.map((value) => String(value[0])).join("\n");
  const stderr = err.mock.calls.map((value) => String(value[0])).join("\n");
  expect(code, JSON.stringify({ args, code, stdout, stderr }, null, 2)).toBe(expected);
  const result = JSON.parse(stdout || stderr);
  expect(result.ok).toBe(expected === 0);
  return result;
}
function setRegistry(
  home: string,
  registry: {
    version?: number;
    repos: readonly unknown[];
    retainedRepositories?: readonly unknown[];
  }
) {
  writeFileSync(
    path.join(home, "repos.json"),
    JSON.stringify({
      version: registry.version ?? 2,
      repositories: registry.repos,
      ...(registry.retainedRepositories === undefined
        ? {}
        : { retainedRepositories: registry.retainedRepositories }),
    })
  );
}
async function fixture(count = 1) {
  const home = createTempDir("op-r-");
  process.env.OUTPOST_HOME = home;
  await cli(["init"]);
  const sources = [];
  for (let index = 0; index < count; index++) {
    const source = await createManagedRepoFixture();
    sources.push(source);
    await cli(["repo", "add", source.tempRepo]);
  }
  const repos = readRegistry(home).repos;
  const created = (
    await cli([
      "create",
      "--ticket",
      "RESUME",
      "--type",
      "feat",
      ...repos.flatMap((repo) => ["--repo", repo.id]),
    ])
  ).data;
  return { home, repos, sources, created, manifest: path.join(home, "workspaces", "RESUME.json") };
}
function snapshot(root: string) {
  const rows: string[][] = [];
  function visit(file: string) {
    const stat = lstatSync(file, { bigint: true });
    const row = [path.relative(root, file), stat.mtimeNs.toString()];
    if (stat.isSymbolicLink()) row.push("link", readlinkSync(file));
    else if (stat.isDirectory()) {
      row.push("directory");
      rows.push(row);
      for (const entry of readdirSync(file).sort()) visit(path.join(file, entry));
      return;
    } else row.push("file", createHash("sha256").update(readFileSync(file)).digest("hex"));
    rows.push(row);
  }
  visit(root);
  return rows;
}
async function resume(f: Awaited<ReturnType<typeof fixture>>, expected = 0) {
  const roots = [f.home, ...f.sources.flatMap((source) => [source.tempRepo, source.tempRemote])];
  const before = roots.map(snapshot);
  const result = await cli(["workspace", "resume", "RESUME"], expected);
  expect(roots.map(snapshot)).toEqual(before);
  if (expected === 1) expect(result.data, JSON.stringify(result)).toBeDefined();
  return result.data;
}

function conversionFilter(checkout: string, type: "clean" | "process", driver = "proof") {
  const root = createTempDir("op-filter-");
  const marker = path.join(root, "executed");
  const script = path.join(root, "filter.cjs");
  writeFileSync(
    script,
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'must not execute'); process.stdin.pipe(process.stdout);\n`
  );
  const command = `${JSON.stringify(process.execPath.replaceAll("\\", "/"))} ${JSON.stringify(script.replaceAll("\\", "/"))}`;
  git(["-C", checkout, "config", `filter.${driver}.${type}`, command]);
  return marker;
}

describe("safe existing workspace resume", () => {
  it.each(["clean", "process"] as const)(
    "never executes configured %s conversion on tracked filter attributes",
    async (type) => {
      const f = await fixture();
      const checkout = f.created.worktrees[0].path;
      const marker = conversionFilter(checkout, type);
      writeFileSync(path.join(checkout, ".gitattributes"), "README.md filter=proof\n");
      const later = new Date(Date.now() + 5000);
      utimesSync(path.join(checkout, "README.md"), later, later);
      const result = await resume(f, 1);
      expect(result.worktrees[0].workingState.status).toBe("unknown");
      expect(result.worktrees[0].diagnostics[0].code).toBe("filter-status-unavailable");
      expect(existsSync(marker)).toBe(false);
    }
  );

  it("keeps unused configured filters resumable without executing them", async () => {
    const f = await fixture();
    const marker = conversionFilter(f.created.worktrees[0].path, "process", "unused");
    const result = await resume(f);
    expect(result.worktrees[0].workingState.status).toBe("clean");
    expect(existsSync(marker)).toBe(false);
  });

  it.each([2, 4])(
    "preserves Git index v%i bytes and refuses split-index timestamp renewal before Git reads it",
    async (version) => {
      const f = await fixture();
      const checkout = f.created.worktrees[0].path;
      git(["-C", checkout, "update-index", `--index-version=${version}`]);
      expect((await resume(f)).worktrees[0].workingState.status).toBe("clean");
      git(["-C", checkout, "update-index", "--split-index"]);
      const admin = readFileSync(path.join(checkout, ".git"), "utf8")
        .replace(/^gitdir: /, "")
        .trim();
      const shared = readdirSync(admin).filter((name) => name.startsWith("sharedindex."));
      expect(shared.length).toBeGreaterThan(0);
      for (const name of shared)
        utimesSync(path.join(admin, name), new Date(1000000000000), new Date(1000000000000));
      const result = await resume(f, 1);
      expect(result.worktrees[0].workingState.status).toBe("unknown");
      expect(result.worktrees[0].diagnostics[0].code).toBe("split-index-status-unavailable");
    }
  );

  it("does not recurse into tracked submodules or execute their local filters", async () => {
    const f = await fixture();
    const checkout = f.created.worktrees[0].path;
    git([
      "-C",
      checkout,
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      f.sources[0].tempRemote,
      "nested",
    ]);
    git(["-C", checkout, "add", ".gitmodules", "nested"]);
    git(["-C", checkout, "commit", "-m", "local submodule"]);
    const nested = path.join(checkout, "nested");
    const marker = conversionFilter(nested, "clean");
    writeFileSync(path.join(nested, ".gitattributes"), "README.md filter=proof\n");
    const later = new Date(Date.now() + 5000);
    utimesSync(path.join(nested, "README.md"), later, later);
    const result = await resume(f, 1);
    expect(result.worktrees[0].workingState.status).toBe("unknown");
    expect(result.worktrees[0].diagnostics[0].code).toBe("submodule-status-unavailable");
    expect(existsSync(marker)).toBe(false);
  });

  it("suppresses a known filter when attributes race after preflight and reports unknown", async () => {
    const f = await fixture();
    const checkout = f.created.worktrees[0].path;
    const marker = conversionFilter(checkout, "clean");
    const later = new Date(Date.now() + 5000);
    utimesSync(path.join(checkout, "README.md"), later, later);
    const original = Process.commandResult;
    let changed = false;
    vi.spyOn(Process, "commandResult").mockImplementation((command, options) =>
      original(command, options).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            if (
              !changed &&
              command._tag === "StandardCommand" &&
              command.args.includes("check-attr")
            ) {
              changed = true;
              writeFileSync(path.join(checkout, ".gitattributes"), "README.md filter=proof\n");
            }
          })
        )
      )
    );
    const result = (await cli(["workspace", "resume", "RESUME"], 1)).data;
    expect(changed).toBe(true);
    expect(result.worktrees[0].workingState.status).toBe("unknown");
    expect(result.worktrees[0].diagnostics[0].code).toBe("filter-status-unavailable");
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(path.join(checkout, ".gitattributes"), "utf8")).toBe(
      "README.md filter=proof\n"
    );
  });

  it("refuses an alternate inherited index instead of reporting its false clean state", async () => {
    const f = await fixture();
    const checkout = f.created.worktrees[0].path;
    const original = readFileSync(path.join(checkout, "README.md"), "utf8");
    writeFileSync(path.join(checkout, "README.md"), "staged user work\n");
    git(["-C", checkout, "add", "README.md"]);
    writeFileSync(path.join(checkout, "README.md"), original);
    expect(git(["-C", checkout, "--no-optional-locks", "status", "--porcelain"])).toContain(
      "MM README.md"
    );
    const alternate = path.join(createTempDir("op-alt-index-"), "index");
    execFileSync("git", ["-C", checkout, "read-tree", "HEAD"], {
      env: { ...process.env, GIT_INDEX_FILE: alternate },
      stdio: "pipe",
    });
    expect(
      execFileSync("git", ["-C", checkout, "--no-optional-locks", "status", "--porcelain"], {
        env: { ...process.env, GIT_INDEX_FILE: alternate },
        encoding: "utf8",
        stdio: "pipe",
      }).trim()
    ).toBe("");
    const alternateBefore = readFileSync(alternate);
    const alternateStat = lstatSync(alternate, { bigint: true }).mtimeNs;
    process.env.GIT_INDEX_FILE = alternate;
    const result = await resume(f, 1);
    delete process.env.GIT_INDEX_FILE;
    expect(result.status).toBe("not-ready");
    expect(result.diagnostics[0].code).toBe("repository-environment");
    expect(result.diagnostics[0].message).toContain("GIT_INDEX_FILE");
    expect(result.diagnostics[0].message).not.toContain(alternate);
    expect(readFileSync(alternate)).toEqual(alternateBefore);
    expect(lstatSync(alternate, { bigint: true }).mtimeNs).toBe(alternateStat);
  });

  it.each([
    "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY",
    "GIT_NAMESPACE",
    "GIT_SHALLOW_FILE",
    "GIT_ATTR_SOURCE",
  ])(
    "refuses inherited %s without exposing its value or reading redirected storage",
    async (name) => {
      const f = await fixture();
      const secretValue = "do-not-read-or-expose-this-redirect";
      process.env[name] = secretValue;
      const result = await resume(f, 1);
      delete process.env[name];
      expect(result.diagnostics[0].code).toBe("repository-environment");
      expect(result.diagnostics[0].message).toContain(name);
      expect(JSON.stringify(result)).not.toContain(secretValue);
    }
  );
  it("preserves advanced/dirty/untracked and source-only work, original base and frozen root/members", async () => {
    const f = await fixture(2);
    const member = f.created.worktrees[0];
    writeFileSync(path.join(member.path, "owned.txt"), "workspace-only commit\n");
    git(["-C", member.path, "add", "owned.txt"]);
    git(["-C", member.path, "commit", "-m", "owned work"]);
    const advanced = git(["-C", member.path, "rev-parse", "HEAD"]);
    writeFileSync(path.join(member.path, "README.md"), "dirty tracked work\n");
    mkdirSync(path.join(member.path, "untracked café"));
    writeFileSync(path.join(member.path, "untracked café", "one"), "preserve\n");
    writeFileSync(path.join(member.path, "untracked café", "two"), "preserve\n");
    const later = new Date(Date.now() + 5000);
    utimesSync(path.join(member.path, "owned.txt"), later, later);
    const source = f.sources[0].tempRepo;
    writeFileSync(path.join(source, "source-only"), "source only\n");
    git(["-C", source, "add", "source-only"]);
    git(["-C", source, "commit", "-m", "source only"]);
    writeFileSync(path.join(source, "dirty"), "source edit\n");
    await cli(["config", "set", "worktreesRoot", path.join(f.home, "future café")]);
    await cli(["repo", "tag", f.repos[0].id, "--add", "changed"]);
    const agents = path.join(f.created.ticketDirectory, "AGENTS.md");
    writeFileSync(agents, `${readFileSync(agents, "utf8")}\nKeep user notes.\n`);
    const result = await resume(f);
    expect(result).toMatchObject({
      status: "ready",
      resumable: true,
      ticketDirectory: f.created.ticketDirectory,
      expectedBranch: "feat/RESUME",
    });
    expect(result.worktrees.map((value: { id: string }) => value.id)).toEqual(
      f.repos.map((value) => value.id)
    );
    expect(result.worktrees[0]).toMatchObject({
      currentHead: advanced,
      currentBranch: "feat/RESUME",
      path: member.path,
      originalBase: { baseCommit: member.baseCommit },
      workingState: { status: "dirty", trackedEntries: 1, untrackedEntries: 1, truncated: false },
    });
    expect(result.worktrees[1].workingState.status).toBe("clean");
  });

  it("accepts diverged owned history without resolving or replacing the original base", async () => {
    const f = await fixture();
    const member = f.created.worktrees[0];
    const tree = git([
      "--git-dir",
      f.repos[0].managedRepoPath,
      "rev-parse",
      `${member.baseCommit}^{tree}`,
    ]);
    const diverged = git(
      ["--git-dir", f.repos[0].managedRepoPath, "commit-tree", tree],
      "independent history\n"
    );
    git([
      "--git-dir",
      f.repos[0].managedRepoPath,
      "update-ref",
      "refs/heads/feat/RESUME",
      diverged,
    ]);
    const result = await resume(f);
    expect(result.worktrees[0]).toMatchObject({
      currentHead: diverged,
      originalBase: { baseCommit: member.baseCommit },
      workingState: { status: "clean" },
    });
  });

  it.each(["unversioned", "v2"])(
    "keeps %s legacy root and recorded base facts without inventing provenance",
    async (version) => {
      const f = await fixture();
      const manifest = JSON.parse(readFileSync(f.manifest, "utf8"));
      for (const member of manifest.repositories)
        for (const key of ["baseSource", "requestedBase", "baseRef", "baseCommit"])
          delete member[key];
      if (version === "v2") manifest.version = 2;
      else {
        delete manifest.version;
        delete manifest.worktreesRoot;
      }
      writeFileSync(f.manifest, JSON.stringify(manifest));
      await cli(["config", "set", "worktreesRoot", path.join(f.home, "later")]);
      const result = await resume(f);
      expect(result.ticketDirectory).toBe(f.created.ticketDirectory);
      expect(result.worktrees[0].originalBase).toEqual({ base: "main" });
    }
  );

  it.each(["wrong-branch", "detached"])(
    "reports %s precisely while preserving partial healthy members",
    async (kind) => {
      const f = await fixture(2);
      const checkout = f.created.worktrees[0].path;
      git([
        "-C",
        checkout,
        "switch",
        ...(kind === "detached" ? ["--detach", "HEAD"] : ["-c", "manual-work"]),
      ]);
      const result = await resume(f, 1);
      expect(result.status).toBe("partial");
      expect(result.worktrees[0]).toMatchObject({
        resumable: false,
        currentBranch: kind === "detached" ? null : "manual-work",
      });
      expect(result.worktrees[0].diagnostics[0].code).toBe(
        kind === "detached" ? "detached-head" : "wrong-branch"
      );
      expect(result.worktrees[1].resumable).toBe(true);
    }
  );

  it.each(["missing", "foreign-gitfile", "back-pointer", "symlink"])(
    "diagnoses %s member without adopting or hiding a healthy member",
    async (kind) => {
      const f = await fixture(2);
      const checkout = f.created.worktrees[0].path;
      if (kind === "missing") renameSync(checkout, `${checkout}.held`);
      else if (kind === "foreign-gitfile")
        writeFileSync(path.join(checkout, ".git"), "foreign repository\n");
      else if (kind === "back-pointer") {
        const admin = readFileSync(path.join(checkout, ".git"), "utf8")
          .replace(/^gitdir: /, "")
          .trim();
        writeFileSync(path.join(admin, "gitdir"), `${path.join(f.home, "foreign", ".git")}\n`);
      } else {
        const foreign = createTempDir("op-foreign-");
        writeFileSync(path.join(foreign, "sentinel"), "foreign\n");
        renameSync(checkout, `${checkout}.held`);
        symlinkSync(foreign, checkout, process.platform === "win32" ? "junction" : "dir");
      }
      const result = await resume(f, 1);
      expect(result.status).toBe("partial");
      expect(result.worktrees[0].resumable).toBe(false);
      expect(result.worktrees[1].resumable).toBe(true);
      expect(result.worktrees[0].diagnostics[0].message).not.toBe("");
      expect(result.worktrees[0].path).toBeUndefined();
    }
  );

  it("refuses an oversized gitfile before any Windows full-text inspection and preserves healthy members", async () => {
    const f = await fixture(2);
    writeFileSync(
      path.join(f.created.worktrees[0].path, ".git"),
      "x".repeat(RESUME_LIMITS.metadataBytes + 1)
    );
    const result = await resume(f, 1);
    expect(result.status).toBe("partial");
    expect(result.worktrees[0].diagnostics[0].code).toBe("inspection-limit");
    expect(result.worktrees[1].resumable).toBe(true);
  });

  it("reports bounded status overflow as unknown rather than claiming clean", async () => {
    const f = await fixture();
    for (let index = 0; index < 2400; index++)
      writeFileSync(
        path.join(f.created.worktrees[0].path, `untracked-${index}-${"x".repeat(110)}`),
        "preserve\n"
      );
    const result = await resume(f, 1);
    expect(result.worktrees[0].workingState).toMatchObject({ status: "unknown", truncated: true });
    expect(result.worktrees[0].diagnostics[0].code).toBe("inspection-limit");
  });

  it.each(["retained", "unregistered", "missing-storage", "identity"])(
    "reports %s registration/storage rather than restoring or importing it",
    async (kind) => {
      const f = await fixture(2);
      const registry = readRegistry(f.home);
      if (kind === "retained") {
        const [record, ...rest] = registry.repos;
        setRegistry(f.home, {
          version: 3,
          repos: rest,
          retainedRepositories: [{ ...record, retainedAt: "2026-10-28T00:00:00Z" }],
        });
      } else if (kind === "unregistered")
        setRegistry(f.home, { ...registry, repos: registry.repos.slice(1) });
      else if (kind === "missing-storage")
        renameSync(f.repos[0].managedRepoPath, `${f.repos[0].managedRepoPath}.held`);
      else {
        const changed = { ...registry.repos[0], remoteUrl: registry.repos[1].remoteUrl };
        setRegistry(f.home, { ...registry, repos: [changed, registry.repos[1]] });
        git([
          "--git-dir",
          changed.managedRepoPath,
          "config",
          "remote.origin.url",
          changed.remoteUrl,
        ]);
      }
      const result = await resume(f, 1);
      expect(result.status).toBe("partial");
      expect(result.worktrees[0].resumable).toBe(false);
      expect(result.worktrees[1].resumable).toBe(true);
      expect(result.worktrees[0].diagnostics[0].code).toBe(
        kind === "retained"
          ? "repository-retained"
          : kind === "unregistered"
            ? "repository-unregistered"
            : kind === "identity"
              ? "registration-mismatch"
              : "member-unavailable"
      );
    }
  );

  it.each(["home", "ticket"])(
    "preserves a held %s lock and refuses readiness without creating journal state",
    async (kind) => {
      const f = await fixture();
      const file =
        kind === "home"
          ? path.join(f.home, ".mutation.lock")
          : path.join(f.home, "workspaces", ".resume.lock");
      writeFileSync(file, "preserve even malformed lock bytes\n");
      const result = await resume(f, 1);
      expect(result.status).toBe("not-ready");
      expect(result.diagnostics[0].code).toBe("lock-held");
      expect(readFileSync(file, "utf8")).toBe("preserve even malformed lock bytes\n");
    }
  );

  it.each(["missing", "invalid", "oversized", "too-many-members"])(
    "does not adopt residual paths for %s manifests",
    async (kind) => {
      const f = await fixture();
      if (kind === "missing") rmSync(f.manifest);
      else if (kind === "invalid") writeFileSync(f.manifest, "{ incomplete");
      else if (kind === "oversized")
        writeFileSync(f.manifest, " ".repeat(RESUME_LIMITS.manifestBytes + 1));
      else {
        const value = JSON.parse(readFileSync(f.manifest, "utf8"));
        value.repositories = Array.from(
          { length: RESUME_LIMITS.members + 1 },
          () => value.repositories[0]
        );
        writeFileSync(f.manifest, JSON.stringify(value));
      }
      const result = await resume(f, 1);
      expect(result.status).toBe("not-ready");
      expect(result.worktrees).toEqual([]);
      expect(result.diagnostics[0].action).toContain("doctor");
      expect(existsSync(f.created.worktrees[0].path)).toBe(true);
    }
  );

  it("refuses missing promised current HEAD without implicit fetch, including shared workspace reads", async () => {
    const f = await fixture();
    const source = f.sources[0].tempRepo;
    writeFileSync(path.join(source, "new"), "not imported\n");
    git(["-C", source, "add", "new"]);
    git(["-C", source, "commit", "-m", "new promised commit"]);
    git(["-C", source, "push", "origin", "main"]);
    const unavailable = git(["-C", source, "rev-parse", "HEAD"]);
    const managed = f.repos[0].managedRepoPath;
    for (const [key, value] of [
      ["remote.origin.promisor", "true"],
      ["remote.origin.partialclonefilter", "blob:none"],
      ["extensions.partialClone", "origin"],
    ])
      git(["--git-dir", managed, "config", key, value]);
    writeFileSync(path.join(managed, "refs", "heads", "feat", "RESUME"), `${unavailable}\n`);
    const trace = path.join(createTempDir("op-trace-"), "git.log");
    writeFileSync(trace, "");
    process.env.GIT_TRACE = trace;
    const result = await resume(f, 1);
    expect(result.worktrees[0].diagnostics[0].code).toBe("head-unavailable");
    await cli(["workspace", "show", "RESUME"]);
    await cli(["workspace", "list"]);
    await cli(["doctor"]);
    delete process.env.GIT_TRACE;
    expect(readFileSync(trace, "utf8")).not.toMatch(/\bfetch\b/);
  });

  it("refuses missing promised current checkout tree without lazy-fetching or claiming clean", async () => {
    const f = await fixture();
    const source = f.sources[0].tempRepo;
    const managed = f.repos[0].managedRepoPath;
    writeFileSync(path.join(source, "new"), "missing checkout tree\n");
    git(["-C", source, "add", "new"]);
    git(["-C", source, "commit", "-m", "new tree"]);
    git(["-C", source, "push", "origin", "main"]);
    const sha = git(["-C", source, "rev-parse", "HEAD"]);
    const raw = execFileSync("git", ["-C", source, "cat-file", "commit", sha]);
    expect(git(["--git-dir", managed, "hash-object", "-w", "-t", "commit", "--stdin"], raw)).toBe(
      sha
    );
    for (const [key, value] of [
      ["remote.origin.promisor", "true"],
      ["remote.origin.partialclonefilter", "blob:none"],
      ["extensions.partialClone", "origin"],
    ])
      git(["--git-dir", managed, "config", key, value]);
    writeFileSync(path.join(managed, "refs", "heads", "feat", "RESUME"), `${sha}\n`);
    const trace = path.join(createTempDir("op-trace-"), "git.log");
    writeFileSync(trace, "");
    process.env.GIT_TRACE = trace;
    const result = await resume(f, 1);
    delete process.env.GIT_TRACE;
    expect(result.worktrees[0].diagnostics[0].code).toBe("status-unavailable");
    expect(result.worktrees[0].workingState.status).toBe("unknown");
    expect(readFileSync(trace, "utf8")).not.toMatch(/\bfetch\b/);
  });

  it("repeated fresh create points to explicit resume before tag/base resolution or fetch", async () => {
    const f = await fixture();
    await cli(["repo", "tag", f.repos[0].id, "--add", "new-tag"]);
    const trace = path.join(createTempDir("op-trace-"), "git.log");
    writeFileSync(trace, "");
    process.env.GIT_TRACE = trace;
    const before = snapshot(f.home);
    const result = await cli(
      [
        "create",
        "--ticket",
        "RESUME",
        "--type",
        "feat",
        "--tag",
        "old-missing-tag",
        "--base-source",
        "fresh-remote",
        "--base",
        "missing",
      ],
      1
    );
    delete process.env.GIT_TRACE;
    expect(result.error.message).toContain("workspace resume");
    expect(readFileSync(trace, "utf8")).not.toMatch(/\bfetch\b/);
    expect(snapshot(f.home)).toEqual(before);
  });

  it("does not probe unrelated registered repository storage", async () => {
    const f = await fixture();
    const registry = readRegistry(f.home);
    const other = path.join(f.home, "unrelated", "do-not-probe.git");
    setRegistry(f.home, {
      ...registry,
      repos: [
        ...registry.repos,
        {
          ...f.repos[0],
          id: "https.example/unrelated",
          name: "unrelated",
          managedRepoPath: other,
          remoteUrl: "https://https.example/unrelated.git",
        },
      ],
    });
    const effect = Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const guarded = new Proxy(fs, {
        get(target, property) {
          const value = Reflect.get(target, property);
          return typeof value === "function"
            ? (...args: unknown[]) => {
                if (args.some((arg) => typeof arg === "string" && arg.includes("do-not-probe")))
                  throw new Error(`Unrelated repository probe: ${String(property)}`);
                return value(...args);
              }
            : value;
        },
      });
      return yield* runWorkspaceResume("RESUME", []).pipe(
        Effect.provideService(FileSystem.FileSystem, guarded)
      );
    });
    const result = await Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)));
    expect(result.data.resumable).toBe(true);
  });
});
