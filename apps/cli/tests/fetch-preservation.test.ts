import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  commitFile,
  configureGitIdentity,
  createManagedRepoFixture,
  createTempDir,
  localRepoId,
  path,
  pushBranch,
  readRegistry,
  runCli,
  setupAfterEach,
} from "./helpers.ts";

setupAfterEach();

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe("fetch ref isolation", () => {
  it.each([false, true])(
    "preserves workspace commits on fetch and re-add, legacy=%s",
    async (legacy) => {
      const home = createTempDir();
      process.env.OUTPOST_HOME = home;
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      expect(await runCli(["init"])).toBe(0);
      const source = await createManagedRepoFixture({ defaultBranch: "develop" });
      expect(await runCli(["repo", "add", source.tempRepo])).toBe(0);
      const repo = readRegistry(home).repos[0];
      if (legacy) {
        git(repo.managedRepoPath, "config", "remote.origin.fetch", "+refs/*:refs/*");
        git(repo.managedRepoPath, "config", "remote.origin.mirror", "true");
        git(repo.managedRepoPath, "update-ref", "-d", "refs/remotes/origin/develop");
      }
      const create = (ticket: string, base?: string) =>
        runCli([
          "create",
          "--ticket",
          ticket,
          "--type",
          "fix",
          "--repo",
          localRepoId(source.tempRemote),
          ...(base
            ? ["--base-source", "local", "--base", base]
            : legacy && ticket === "FIRST"
              ? ["--base-source", "local"]
              : []),
        ]);
      expect(await create("FIRST")).toBe(0);
      const worktree = path.join(home, "worktrees", "FIRST", repo.name);
      await configureGitIdentity(worktree);
      await commitFile(worktree, "agent.txt", "keep me\n", "agent work");
      const agentCommit = git(worktree, "rev-parse", "HEAD");
      // A remote deletion must still be pruned from the tracking namespace.
      git(source.tempRepo, "branch", "obsolete");
      git(source.tempRepo, "push", "origin", "obsolete");
      expect(await runCli(["repo", "fetch", "--all"])).toBe(0);
      git(source.tempRepo, "push", "origin", "--delete", "obsolete");
      await commitFile(source.tempRepo, "upstream.txt", "new base\n", "advance remote");
      await pushBranch(source.tempRepo, "origin", "develop");
      const upstreamCommit = git(source.tempRepo, "rev-parse", "HEAD");
      expect(await runCli(["repo", "fetch", "--all"])).toBe(0);
      expect(await runCli(["repo", "add", source.tempRepo])).toBe(0);
      expect(git(repo.managedRepoPath, "rev-parse", "refs/heads/fix/FIRST")).toBe(agentCommit);
      expect(git(worktree, "rev-parse", "HEAD")).toBe(agentCommit);
      expect(git(repo.managedRepoPath, "for-each-ref", "refs/remotes/origin/obsolete")).toBe("");
      expect(git(repo.managedRepoPath, "config", "--get-all", "remote.origin.fetch")).toBe(
        "+refs/heads/*:refs/remotes/origin/*"
      );
      expect(await create("SECOND")).toBe(0);
      expect(git(path.join(home, "worktrees", "SECOND", repo.name), "rev-parse", "HEAD")).toBe(
        upstreamCommit
      );
      expect(await create("THIRD", "fix/FIRST")).toBe(0);
      expect(git(path.join(home, "worktrees", "THIRD", repo.name), "rev-parse", "HEAD")).toBe(
        agentCommit
      );
    }
  );
});
