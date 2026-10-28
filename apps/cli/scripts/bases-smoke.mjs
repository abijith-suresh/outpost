import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Use only installed commands and disposable local Git. A missing remote makes
// accidental fetches in offline modes observable on either supported platform.
export function verifyBaseWorkflow({ runInstalled, validateInstalled, smokeRoot }) {
  const fixture = join(smokeRoot, "bases café");
  const source = join(fixture, "s");
  const remote = join(fixture, "r.git");
  const home = join(fixture, "h");
  mkdirSync(source, { recursive: true });
  const git = (args, cwd = source) =>
    execFileSync(
      "git",
      process.platform === "win32" ? ["-c", "core.longpaths=true", ...args] : args,
      {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
      }
    ).trim();
  const call = (args, expected = 0) => {
    const result = runInstalled([...args, "--json"], { OUTPOST_HOME: home });
    assert.equal(result.status, expected, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
    const output = JSON.parse(expected === 0 ? result.stdout : result.stderr);
    validateInstalled(output.command, output);
    assert.equal(output.ok, expected === 0);
    assert.equal(expected === 0 ? result.stderr : result.stdout, "");
    return output;
  };
  git(["init", "--bare", remote]);
  git(["init", "-b", "main"]);
  git(["config", "user.name", "Outpost Base Smoke"]);
  git(["config", "user.email", "base@example.invalid"]);
  const commit = (text) => {
    writeFileSync(join(source, "work.txt"), `${text}\n`);
    git(["add", "work.txt"]);
    git(["commit", "-m", text]);
    return git(["rev-parse", "HEAD"]);
  };
  const localSha = commit("local starting commit");
  git(["remote", "add", "origin", remote]);
  git(["push", "origin", "main"]);
  git(["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);
  call(["init"]);
  call(["repo", "add", source]);
  const repo = call(["repo", "list"]).data.repos[0];
  const cachedSha = commit("cached remote commit");
  git(["push", "origin", "main"]);
  call(["repo", "fetch", "--all"]);
  const freshSha = commit("fresh remote commit");
  git(["push", "origin", "main"]);
  const sourceOnlySha = commit("source-only commit");
  writeFileSync(join(source, "untracked.txt"), "preserve source edits\n");
  const sourceStatus = git(["status", "--porcelain"]);
  const sourceConfig = readFileSync(join(source, ".git", "config"));
  const args = (ticket, mode, base = "main") => [
    "create",
    "--ticket",
    ticket,
    "--type",
    "feat",
    "--repo",
    repo.id,
    "--base-source",
    mode,
    "--base",
    base,
  ];
  const checkMember = (created, ticket, mode, sha, requestedBase = "main") => {
    const member = created.worktrees[0];
    assert.equal(member.baseSource, mode);
    assert.equal(member.requestedBase, requestedBase);
    assert.equal(member.baseCommit, sha);
    assert.equal(member.baseResolution, "resolved");
    assert.equal(git(["rev-parse", "HEAD"], member.path), sha);
    const manifest = JSON.parse(readFileSync(join(home, "workspaces", `${ticket}.json`), "utf8"));
    assert.equal(manifest.version, 3);
    for (const key of ["baseSource", "requestedBase", "baseRef", "baseCommit"]) {
      assert.deepEqual(manifest.repositories[0][key], member[key]);
    }
    assert.match(readFileSync(join(created.ticketDirectory, "AGENTS.md"), "utf8"), new RegExp(sha));
  };
  const local = call(args("BASE-L", "local")).data;
  checkMember(local, "BASE-L", "local", localSha);
  const defaultArgs = args("BASE-C", "cached-remote");
  defaultArgs.splice(defaultArgs.indexOf("--base-source"), 2);
  const cached = call(defaultArgs).data;
  checkMember(cached, "BASE-C", "cached-remote", cachedSha);
  const exactObject = call(args("BASE-OID", "local", localSha)).data;
  checkMember(exactObject, "BASE-OID", "local", localSha, localSha);
  const registryBefore = readFileSync(join(home, "repos.json"));
  const configBefore = readFileSync(join(home, "config.json"));
  const refsBefore = git(["--git-dir", repo.managedRepoPath, "show-ref"]);
  const preview = call([...args("BASE-F", "fresh-remote"), "--dry-run"]).data;
  assert.equal(preview.worktrees[0].baseCommit, null);
  assert.equal(preview.worktrees[0].baseResolution, "fetch-required");
  assert.equal(preview.worktrees[0].baseSource, "fresh-remote");
  const guidance = call(["guidance", "preview", ...args("BASE-F", "fresh-remote").slice(1)]).data;
  assert.match(guidance.content, /fetch-required/);
  assert.doesNotMatch(guidance.content, new RegExp(freshSha));
  assert.equal(git(["--git-dir", repo.managedRepoPath, "show-ref"]), refsBefore);
  assert.deepEqual(readFileSync(join(home, "repos.json")), registryBefore);
  assert.deepEqual(readFileSync(join(home, "config.json")), configBefore);
  assert.ok(!existsSync(join(home, "worktrees", "BASE-F")));
  const fresh = call(args("BASE-F", "fresh-remote")).data;
  checkMember(fresh, "BASE-F", "fresh-remote", freshSha);
  assert.equal(git(["--git-dir", repo.managedRepoPath, "rev-parse", "refs/heads/main"]), localSha);
  assert.equal(
    git(["--git-dir", repo.managedRepoPath, "rev-parse", "refs/remotes/origin/main"]),
    freshSha
  );
  assert.throws(() =>
    git(["--git-dir", repo.managedRepoPath, "cat-file", "-e", `${sourceOnlySha}^{commit}`])
  );
  call(args("BASE-SOURCE", "local", sourceOnlySha), 1);
  assert.ok(!existsSync(join(home, "worktrees", "BASE-SOURCE")));
  renameSync(remote, `${remote} offline`);
  checkMember(call(args("BASE-OFF-L", "local")).data, "BASE-OFF-L", "local", localSha);
  checkMember(
    call(args("BASE-OFF-C", "cached-remote")).data,
    "BASE-OFF-C",
    "cached-remote",
    freshSha
  );
  const offlineRefs = git(["--git-dir", repo.managedRepoPath, "show-ref"]);
  const offlinePreview = call([...args("BASE-OFF-F", "fresh-remote"), "--dry-run"]).data;
  assert.equal(offlinePreview.worktrees[0].baseCommit, null);
  assert.equal(offlinePreview.worktrees[0].baseResolution, "fetch-required");
  call(args("BASE-OFF-F", "fresh-remote"), 1);
  assert.equal(git(["--git-dir", repo.managedRepoPath, "show-ref"]), offlineRefs);
  assert.ok(!existsSync(join(home, "worktrees", "BASE-OFF-F")));
  assert.equal(git(["rev-parse", "HEAD"]), sourceOnlySha);
  assert.equal(git(["status", "--porcelain"]), sourceStatus);
  assert.deepEqual(readFileSync(join(source, ".git", "config")), sourceConfig);
  assert.equal(readFileSync(join(source, "untracked.txt"), "utf8"), "preserve source edits\n");
  for (const ticket of ["BASE-L", "BASE-C", "BASE-OID", "BASE-F", "BASE-OFF-L", "BASE-OFF-C"]) {
    call(["workspace", "remove", ticket]);
  }
  process.stdout.write(
    "Installed base selection preserved distinct local/cached/fresh SHAs and source-only work\n"
  );
}
