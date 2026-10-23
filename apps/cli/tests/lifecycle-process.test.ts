import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { chmodSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  commitFile,
  configureGitIdentity,
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
const require = createRequire(import.meta.url);
const cliRoot = fileURLToPath(new URL("..", import.meta.url));
const cli = path.join(cliRoot, "dist", "cli.js");
const children = new Set<ChildProcess>();
const barrierPids = new Set<number>();

// Exercise the real executable and signal handler, not a mocked workflow.
beforeAll(() => {
  execFileSync(
    process.execPath,
    [
      path.join(path.dirname(require.resolve("typescript/package.json")), "bin", "tsc"),
      "-p",
      path.join(cliRoot, "tsconfig.json"),
    ],
    { cwd: cliRoot, stdio: "pipe" }
  );
}, 30_000);
afterEach(() => {
  for (const child of children) child.kill("SIGKILL");
  children.clear();
  for (const pid of barrierPids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* Already reaped by scoped cancellation. */
    }
  }
  barrierPids.clear();
});

function launch(args: string[], env: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, [cli, ...args, "--json"], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const done = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      children.delete(child);
      resolve({ code, signal, stdout, stderr });
    });
  });
  return { child, done };
}

async function waitForFile(file: string) {
  await vi.waitFor(() => expect(existsSync(file)).toBe(true), { timeout: 10_000, interval: 20 });
  barrierPids.add(Number(readFileSync(file, "utf8")));
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** Pause one exact Git mutation. Other Git commands use the real executable. */
function barrier(match: string[]) {
  const root = createTempDir("outpost-barrier-");
  const ready = path.join(root, "ready");
  const release = path.join(root, "release");
  const shim = path.join(root, "git");
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  writeFileSync(
    shim,
    `#!${process.execPath}
const fs = require('node:fs');
const cp = require('node:child_process');
const args = process.argv.slice(2);
const match = ${JSON.stringify(match)};
if (match.every((part, index) => args[index] === part)) {
  fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid));
  while (!fs.existsSync(${JSON.stringify(release)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}
const result = cp.spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' });
process.exit(result.status ?? 1);
`
  );
  chmodSync(shim, 0o755);
  return { ready, release, env: { PATH: `${root}:${process.env.PATH}` } };
}

async function fixture(count = 1) {
  const home = createTempDir();
  process.env.OUTPOST_HOME = home;
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  expect(await runCli(["init"])).toBe(0);
  for (let index = 0; index < count; index++) {
    const source = await createManagedRepoFixture({ defaultBranch: "main" });
    expect(await runCli(["repo", "add", source.tempRepo])).toBe(0);
  }
  return { home, repos: readRegistry(home).repos };
}

function createArgs(ticket: string, repos: ReturnType<typeof readRegistry>["repos"]) {
  return [
    "create",
    "--ticket",
    ticket,
    "--type",
    "fix",
    ...repos.flatMap((repo) => ["--repo", repo.id]),
  ];
}

describe("shared mutation subprocesses", () => {
  it("refuses overlapping adds deterministically and preserves both registrations after retry", async () => {
    const { home } = await fixture(0);
    const alpha = await createManagedRepoFixture({ defaultBranch: "main" });
    const beta = await createManagedRepoFixture({ defaultBranch: "main" });
    const pause = barrier(["clone"]);
    const first = launch(["repo", "add", alpha.tempRepo], pause.env);
    await waitForFile(pause.ready);
    const second = await launch(["repo", "add", beta.tempRepo]).done;
    expect(second.code).toBe(1);
    expect(second.stdout).toBe("");
    expect(JSON.parse(second.stderr).error.message).toMatch(/home is locked/);
    writeFileSync(pause.release, "go");
    expect((await first.done).code).toBe(0);
    expect((await launch(["repo", "add", beta.tempRepo]).done).code).toBe(0);
    expect(readRegistry(home).repos).toHaveLength(2);
    expect(existsSync(path.join(home, ".mutation.lock"))).toBe(false);
  }, 20_000);

  it("prevents fetch snapshot rewrites from racing add or remove", async () => {
    const { home, repos } = await fixture();
    const beta = await createManagedRepoFixture({ defaultBranch: "main" });
    const pause = barrier(["fetch"]);
    const fetching = launch(["repo", "fetch", "--all"], pause.env);
    await waitForFile(pause.ready);
    expect((await launch(["repo", "add", beta.tempRepo]).done).code).toBe(1);
    expect((await launch(["repo", "remove", repos[0].id]).done).code).toBe(1);
    writeFileSync(pause.release, "go");
    expect((await fetching.done).code).toBe(0);
    expect((await launch(["repo", "add", beta.tempRepo]).done).code).toBe(0);
    expect(readRegistry(home).repos).toHaveLength(2);
    expect((await launch(["repo", "remove", repos[0].id]).done).code).toBe(0);
    expect(readRegistry(home).repos).toHaveLength(1);
  }, 20_000);

  it("protects create against repo remove and workspace remove before the manifest exists", async () => {
    const { home, repos } = await fixture();
    const repo = repos[0];
    const pause = barrier(["--git-dir", repo.managedRepoPath, "worktree", "add"]);
    const creating = launch(createArgs("RACE", repos), pause.env);
    await waitForFile(pause.ready);
    for (const args of [
      ["repo", "remove", repo.id],
      ["workspace", "remove", "RACE"],
      createArgs("RACE", repos),
    ]) {
      const result = await launch(args).done;
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stderr).error.message).toMatch(/home is locked/);
    }
    writeFileSync(pause.release, "go");
    expect((await creating.done).code).toBe(0);
    expect(existsSync(path.join(home, "workspaces", "RACE.json"))).toBe(true);
    expect((await launch(["repo", "remove", repo.id]).done).code).toBe(1);
    expect((await launch(["workspace", "remove", "RACE"]).done).code).toBe(0);
    expect((await launch(["repo", "remove", repo.id]).done).code).toBe(0);
  }, 20_000);
});

describe("cancellation and recovery subprocesses", () => {
  it("rolls back the first worktree and both branches on SIGTERM during the second worktree", async () => {
    const { home, repos } = await fixture(2);
    const pause = barrier(["--git-dir", repos[1].managedRepoPath, "worktree", "add"]);
    const creating = launch(createArgs("TERM", repos), pause.env);
    await waitForFile(pause.ready);
    expect(existsSync(path.join(home, "worktrees", "TERM", repos[0].name))).toBe(true);
    creating.child.kill("SIGTERM");
    expect((await creating.done).code).not.toBe(0);
    expect(existsSync(path.join(home, "worktrees", "TERM"))).toBe(false);
    expect(existsSync(path.join(home, "workspaces", "TERM.json"))).toBe(false);
    expect(existsSync(path.join(home, "workspaces", ".term.lock"))).toBe(false);
    expect(existsSync(path.join(home, ".mutation.lock"))).toBe(false);
    for (const repo of repos)
      expect(git(repo.managedRepoPath, "for-each-ref", "refs/heads/fix/TERM")).toBe("");
    const doctor = await launch(["doctor"]).done;
    expect(doctor.stderr).toBe("");
    expect(
      JSON.parse(doctor.stdout).data.operationRecords.some(
        (record: { kind: string }) => record.kind === "operation"
      )
    ).toBe(true);
  }, 20_000);

  it.each(["untracked", "commit"])(
    "preserves %s work introduced during a cancelled create",
    async (kind) => {
      const { home, repos } = await fixture(2);
      const pause = barrier(["--git-dir", repos[1].managedRepoPath, "worktree", "add"]);
      const creating = launch(createArgs("EDIT", repos), pause.env);
      await waitForFile(pause.ready);
      const worktree = path.join(home, "worktrees", "EDIT", repos[0].name);
      await configureGitIdentity(worktree);
      writeFileSync(path.join(worktree, "agent.txt"), "preserve me\n");
      if (kind === "commit") await commitFile(worktree, "agent.txt", "preserve me\n", "agent work");
      const commit = git(worktree, "rev-parse", "HEAD");
      creating.child.kill("SIGTERM");
      await creating.done;
      expect(readFileSync(path.join(worktree, "agent.txt"), "utf8")).toBe("preserve me\n");
      expect(git(repos[0].managedRepoPath, "rev-parse", "refs/heads/fix/EDIT")).toBe(commit);
      expect((await launch(["repo", "remove", repos[0].id]).done).code).toBe(1);
    },
    20_000
  );

  it("records intended artifacts before SIGKILL and never reaps or adopts them on retry", async () => {
    const { home, repos } = await fixture(2);
    const pause = barrier(["--git-dir", repos[1].managedRepoPath, "worktree", "add"]);
    const creating = launch(createArgs("KILL", repos), pause.env);
    await waitForFile(pause.ready);
    const shimPid = Number(readFileSync(pause.ready, "utf8"));
    creating.child.kill("SIGKILL");
    // SIGKILL cannot run finalizers. Stop the test barrier child explicitly.
    process.kill(shimPid, "SIGKILL");
    await creating.done;
    const lock = JSON.parse(readFileSync(path.join(home, ".mutation.lock"), "utf8"));
    expect(lock).toMatchObject({ operation: "create", pid: creating.child.pid });
    const journal = JSON.parse(readFileSync(lock.journalPath, "utf8"));
    expect(journal.steps[0].plans).toHaveLength(2);
    expect(journal.steps.at(-1)).toMatchObject({
      action: "create-worktree",
      managedRepoPath: repos[1].managedRepoPath,
    });
    const doctor = JSON.parse((await launch(["doctor"]).done).stdout).data;
    expect(doctor.status).toBe("degraded");
    expect(doctor.operationRecords.map((record: { kind: string }) => record.kind)).toEqual(
      expect.arrayContaining(["home-lock", "ticket-lock", "operation"])
    );
    expect((await launch(createArgs("KILL", repos)).done).code).toBe(1);
    expect(readFileSync(path.join(home, ".mutation.lock"), "utf8")).toContain(lock.id);
    expect(existsSync(path.join(home, "worktrees", "KILL", repos[0].name))).toBe(true);
    // Simulate a human releasing inspected locks. The actual Git link still
    // protects the mirror even though no manifest was written.
    rmSync(path.join(home, ".mutation.lock"));
    rmSync(path.join(home, "workspaces", ".kill.lock"));
    expect((await launch(["repo", "remove", repos[0].id]).done).code).toBe(1);
    expect(existsSync(repos[0].managedRepoPath)).toBe(true);
  }, 20_000);

  it("keeps an old lock and refuses to adopt an unregistered residual directory", async () => {
    const { home } = await fixture(0);
    const lockPath = path.join(home, ".mutation.lock");
    const contents = JSON.stringify({
      pid: 99999999,
      startedAt: "1970-01-01",
      hostname: "other-host",
    });
    writeFileSync(lockPath, contents);
    const source = await createManagedRepoFixture({ defaultBranch: "main" });
    expect((await launch(["repo", "add", source.tempRepo]).done).code).toBe(1);
    expect(readFileSync(lockPath, "utf8")).toBe(contents);
    expect(
      JSON.parse((await launch(["doctor"]).done).stdout).data.operationRecords[0].metadata
    ).toMatchObject({ hostname: "other-host" });
    rmSync(lockPath);
    // A separate registered fixture supplies the canonical path, then its
    // registry entry is removed to model a crash before registration.
    expect((await launch(["repo", "add", source.tempRepo]).done).code).toBe(0);
    const repo = readRegistry(home).repos[0];
    writeFileSync(path.join(repo.managedRepoPath, "sentinel"), "residual");
    writeFileSync(path.join(home, "repos.json"), JSON.stringify({ repos: [] }));
    const retry = await launch(["repo", "add", source.tempRepo]).done;
    expect(retry.code).toBe(1);
    expect(JSON.parse(retry.stderr).error.message).toMatch(/unregistered/);
    expect(readFileSync(path.join(repo.managedRepoPath, "sentinel"), "utf8")).toBe("residual");
    expect(readRegistry(home).repos).toEqual([]);
    expect(readdirSync(path.join(home, "operations")).length).toBeGreaterThan(0);
  }, 20_000);
});
