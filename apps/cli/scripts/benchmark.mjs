import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

// Real fresh processes, one real Git worktree per workspace, no remote network.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(root, "dist", "cli.js");
const scratch = mkdtempSync(join(tmpdir(), "outpost-benchmark-"));
const home = join(scratch, "home");
const samples = 3;
const env = { ...process.env, OUTPOST_HOME: home };
const run = (command, args, cwd = scratch) =>
  execFileSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });
const git = (cwd, ...args) => run("git", args, cwd);
const outpost = (...args) => run(process.execPath, [cli, ...args]);
const measure = (fn) => {
  const durations = [];
  for (let sample = 0; sample < samples; sample++) {
    const start = performance.now();
    fn();
    durations.push(Math.round(performance.now() - start));
  }
  return {
    medianMs: [...durations].sort((a, b) => a - b)[Math.floor(samples / 2)],
    samplesMs: durations,
  };
};
const report = {
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  samples,
  head: git(root, "rev-parse", "HEAD").trim(),
  workingTreeDirty: git(root, "status", "--porcelain").trim().length > 0,
  startup: {},
  workspaceList: {},
};
try {
  report.startup.node = measure(() => run(process.execPath, ["-e", ""]));
  for (const [name, args] of [
    ["version", ["--version"]],
    ["help", ["--help"]],
    ["describe", ["describe", "--json"]],
  ]) {
    report.startup[name] = measure(() => outpost(...args));
  }
  const source = join(scratch, "source");
  const remote = join(scratch, "remote.git");
  mkdirSync(source);
  git(source, "init", "--initial-branch=main");
  git(source, "config", "user.name", "Benchmark");
  git(source, "config", "user.email", "benchmark@example.invalid");
  writeFileSync(join(source, "README.md"), "benchmark\n");
  git(source, "add", ".");
  git(source, "commit", "-m", "fixture");
  git(scratch, "clone", "--bare", source, remote);
  git(source, "remote", "add", "origin", remote);
  outpost("init", "--json");
  outpost("repo", "add", source, "--json");
  const repo = JSON.parse(readFileSync(join(home, "repos.json"), "utf8")).repos[0];
  const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  let created = 0;
  for (const count of [1, 10, 50, 100]) {
    while (created < count) {
      const ticket = `BENCH-${++created}`;
      const branch = `feat/${ticket}`;
      const directory = join(config.worktreesRoot, ticket);
      mkdirSync(directory);
      git(
        scratch,
        "--git-dir",
        repo.managedRepoPath,
        "worktree",
        "add",
        "-b",
        branch,
        join(directory, repo.name),
        "main"
      );
      writeFileSync(
        join(home, "workspaces", `${ticket}.json`),
        JSON.stringify({
          ticket,
          type: "feat",
          branch,
          createdAt: new Date(0).toISOString(),
          workspacePath: ticket,
          repositories: [
            {
              id: repo.id,
              name: repo.name,
              base: "main",
              managedPath: relative(config.reposRoot, repo.managedRepoPath),
              worktreePath: repo.name,
            },
          ],
        })
      );
    }
    report.workspaceList[count] = measure(() => {
      const output = JSON.parse(outpost("workspace", "list", "--json"));
      assert.equal(output.data.workspaces.length, count);
      assert.ok(output.data.workspaces.every((workspace) => workspace.status === "ready"));
    });
    process.stderr.write(`Measured ${count} real workspaces\n`);
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
