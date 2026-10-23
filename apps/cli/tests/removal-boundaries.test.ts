import { execFileSync } from "node:child_process";
import { renameSync, rmSync, symlinkSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
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
  writeRegistry,
} from "./helpers.ts";

setupAfterEach();

async function fixture() {
  const home = createTempDir();
  process.env.OUTPOST_HOME = home;
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  expect(await runCli(["init"])).toBe(0);
  const source = await createManagedRepoFixture({ defaultBranch: "main" });
  expect(await runCli(["repo", "add", source.tempRepo])).toBe(0);
  return { home, source, repo: readRegistry(home).repos[0] };
}

describe("repository removal boundaries", () => {
  it("refuses a corrupted registry path outside reposRoot", async () => {
    const { home, repo } = await fixture();
    const external = createTempDir();
    writeFileSync(path.join(external, "sentinel"), "external");
    writeRegistry(home, [{ ...repo, managedRepoPath: external }]);
    expect(await runCli(["repo", "remove", repo.id, "--json"])).toBe(1);
    expect(readFileSync(path.join(external, "sentinel"), "utf8")).toBe("external");
    expect(readRegistry(home).repos).toHaveLength(1);
  });
  it("refuses a replaced ancestor symlink into an external directory", async () => {
    const { home, repo } = await fixture();
    const external = createTempDir();
    const ancestor = path.dirname(repo.managedRepoPath);
    const moved = path.join(external, path.basename(repo.managedRepoPath));
    renameSync(repo.managedRepoPath, moved);
    writeFileSync(path.join(moved, "sentinel"), "external");
    rmSync(ancestor, { recursive: true });
    symlinkSync(external, ancestor, "dir");
    expect(await runCli(["repo", "remove", repo.id, "--json"])).toBe(1);
    expect(readFileSync(path.join(moved, "sentinel"), "utf8")).toBe("external");
    expect(readRegistry(home).repos).toHaveLength(1);
  });
  it.each(["directory", "foreign-git"])("refuses %s at the former managed path", async (kind) => {
    const { home, repo } = await fixture();
    rmSync(repo.managedRepoPath, { recursive: true });
    mkdirSync(repo.managedRepoPath);
    if (kind === "foreign-git")
      execFileSync("git", ["init", "--bare"], { cwd: repo.managedRepoPath });
    writeFileSync(path.join(repo.managedRepoPath, "sentinel"), "foreign");
    expect(await runCli(["repo", "remove", repo.id, "--json"])).toBe(1);
    expect(existsSync(path.join(repo.managedRepoPath, "sentinel"))).toBe(true);
    expect(readRegistry(home).repos).toHaveLength(1);
  });
  it("protects an actual linked worktree after its manifest disappears", async () => {
    const { home, repo } = await fixture();
    expect(await runCli(["create", "--ticket", "ORPHAN", "--type", "fix", "--repo", repo.id])).toBe(
      0
    );
    rmSync(path.join(home, "workspaces", "ORPHAN.json"));
    const worktree = path.join(home, "worktrees", "ORPHAN", repo.name);
    writeFileSync(path.join(worktree, "agent-work.txt"), "keep");
    expect(await runCli(["repo", "remove", repo.id, "--json"])).toBe(1);
    expect(existsSync(repo.managedRepoPath)).toBe(true);
    expect(readFileSync(path.join(worktree, "agent-work.txt"), "utf8")).toBe("keep");
  });
  it("unregisters an absent owned mirror without deleting anything else", async () => {
    const { home, repo } = await fixture();
    rmSync(repo.managedRepoPath, { recursive: true });
    expect(await runCli(["repo", "remove", repo.id, "--json"])).toBe(0);
    expect(readRegistry(home).repos).toEqual([]);
  });
  it("keeps unmanaged-directory warnings inside JSON and stderr empty", async () => {
    const { home, repo } = await fixture();
    mkdirSync(path.join(home, "worktrees", "unmanaged"));
    const info = vi.spyOn(console, "log").mockImplementation(() => undefined);
    info.mockClear();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await runCli(["repo", "remove", repo.id, "--json"])).toBe(0);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(info.mock.calls[0][0])).data.warnings[0]).toMatch(/unmanaged/);
  });
});

it.each(["AGENTS.md", "agents.MD", "AGENTS.md."])(
  "reserves generated guidance path %s in dry-run and execution",
  async (repoName) => {
    const home = createTempDir();
    process.env.OUTPOST_HOME = home;
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await runCli(["init"])).toBe(0);
    const source = await createManagedRepoFixture({ defaultBranch: "main", repoName });
    expect(await runCli(["repo", "add", source.tempRepo])).toBe(0);
    const repo = readRegistry(home).repos[0];
    const args = ["create", "--ticket", "RESERVED", "--type", "fix", "--repo", repo.id];
    expect(await runCli([...args, "--dry-run"])).toBe(1);
    expect(await runCli(args)).toBe(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("reserved generated path AGENTS.md")
    );
    expect(existsSync(path.join(home, "worktrees", "RESERVED"))).toBe(false);
    expect(
      execFileSync(
        "git",
        ["--git-dir", repo.managedRepoPath, "for-each-ref", "refs/heads/fix/RESERVED"],
        { encoding: "utf8" }
      ).trim()
    ).toBe("");
  }
);
