import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Installed-artifact acceptance: only disposable local Git repositories. No
// repository source imports, network remotes or developer working directories.
export function verifySettingsWorkflow({ runInstalled, validateInstalled, smokeRoot }) {
  const fixture = join(smokeRoot, "settings café");
  const home = join(fixture, "home");
  const source = join(fixture, "source");
  const remote = join(fixture, "origin.git");
  const requestedRoot = join(fixture, "future workspaces");
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
  git(["init", "--bare", remote]);
  git(["init", "-b", "main"]);
  git(["config", "user.name", "Outpost Smoke"]);
  git(["config", "user.email", "outpost@example.invalid"]);
  writeFileSync(join(source, "README.md"), "installed fixture\n");
  git(["add", "README.md"]);
  git(["commit", "-m", "initial"]);
  git(["remote", "add", "origin", remote]);
  git(["push", "origin", "main"]);
  git(["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);
  const env = { OUTPOST_HOME: home };
  const call = (args) => {
    const result = runInstalled([...args, "--json"], env);
    assert.equal(result.status, 0, `${args.join(" ")}\n${result.stderr}\n${result.stdout}`);
    assert.equal(result.stderr, "");
    const output = JSON.parse(result.stdout);
    validateInstalled(output.command, output);
    return output.data;
  };
  const refuse = (args) => {
    const result = runInstalled([...args, "--json"], env);
    assert.equal(result.status, 1, args.join(" "));
    assert.equal(result.stdout, "");
    const output = JSON.parse(result.stderr);
    validateInstalled(output.command, output);
    assert.equal(output.ok, false);
  };
  call(["init"]);
  call(["repo", "add", source]);
  const repo = call(["repo", "list"]).repos[0];
  const createArgs = (ticket) => ["--ticket", ticket, "--type", "feat", "--repo", repo.id];
  const old = call(["create", ...createArgs("OLD-1")]);
  const oldWorktree = old.worktrees[0].path;
  git(["config", "user.name", "Outpost Smoke"], oldWorktree);
  git(["config", "user.email", "outpost@example.invalid"], oldWorktree);
  writeFileSync(join(oldWorktree, "local-only.txt"), "preserve this branch-only commit\n");
  git(["add", "local-only.txt"], oldWorktree);
  git(["commit", "-m", "branch-only work"], oldWorktree);
  const oldHead = git(["rev-parse", "HEAD"], oldWorktree);
  const agentsPath = join(old.ticketDirectory, "AGENTS.md");
  const agentsBefore = readFileSync(agentsPath);
  const manifestPath = join(home, "workspaces", "OLD-1.json");
  // Represent the persisted manifest shape used by v1, including its original
  // paths. No Git data or guidance is changed by this compatibility fixture.
  const legacyManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  delete legacyManifest.version;
  delete legacyManifest.worktreesRoot;
  writeFileSync(manifestPath, `${JSON.stringify(legacyManifest, null, 2)}\n`);
  const legacyBytes = readFileSync(manifestPath);
  const nextRoot = call(["config", "set", "worktreesRoot", requestedRoot]).value;
  assert.deepEqual(readFileSync(manifestPath), legacyBytes, "root change rewrote legacy state");
  assert.deepEqual(readFileSync(agentsPath), agentsBefore, "root change overwrote guidance");
  assert.equal(git(["rev-parse", "HEAD"], oldWorktree), oldHead);
  assert.equal(call(["workspace", "show", "OLD-1"]).ticketDirectory, old.ticketDirectory);
  assert.equal(
    call(["workspace", "list"]).workspaces.find((w) => w.ticket === "OLD-1").status,
    "ready"
  );
  assert.equal(call(["doctor"]).unhealthyWorkspaceCount, 0);

  call(["repo", "tag", repo.id, "--add", "backend", "--add", "payments"]);
  assert.equal(call(["repo", "list", "--tag", "backend", "--tag", "payments"]).repos.length, 1);
  const instructions = join(fixture, "instructions.txt");
  writeFileSync(
    instructions,
    "Keep fixture credentials synthetic.\nRead each repository's guidance.\n"
  );
  call(["guidance", "set", instructions]);
  const preview = call(["guidance", "preview", ...createArgs("NEW-1")]);
  assert.match(JSON.stringify(preview), /Keep fixture credentials synthetic/);
  assert.match(JSON.stringify(preview), /outpost:workspace-agents sha256=/);
  assert.ok(!existsSync(join(nextRoot, "NEW-1")), "guidance preview created a workspace");
  const newer = call([
    "create",
    "--ticket",
    "NEW-1",
    "--type",
    "feat",
    "--tag",
    "backend",
    "--tag",
    "payments",
  ]);
  assert.equal(newer.ticketDirectory, join(nextRoot, "NEW-1"));
  assert.match(
    readFileSync(join(newer.ticketDirectory, "AGENTS.md"), "utf8"),
    /Keep fixture credentials synthetic/
  );
  const newManifestPath = join(home, "workspaces", "NEW-1.json");
  const frozenManifest = readFileSync(newManifestPath);
  call(["repo", "tag", repo.id, "--remove", "backend"]);
  call(["repo", "add", source]);
  assert.deepEqual(call(["repo", "show", repo.id]).tags, ["payments"], "reimport lost tags");
  assert.deepEqual(readFileSync(newManifestPath), frozenManifest, "tag edit changed membership");
  refuse(["create", "--ticket", "EMPTY-1", "--type", "feat", "--tag", "backend"]);
  assert.ok(!existsSync(join(nextRoot, "EMPTY-1")));
  call(["guidance", "clear"]);
  assert.deepEqual(readFileSync(agentsPath), agentsBefore);
  for (const ticket of ["CON", "NUL.txt", "bad:name", "trailing."]) {
    refuse(["create", ...createArgs(ticket), "--dry-run"]);
    assert.ok(!existsSync(join(nextRoot, ticket)));
  }

  // Future state cannot be rewritten by an older schema reader.
  const configPath = join(home, "config.json");
  const configBytes = readFileSync(configPath);
  const future = { ...JSON.parse(configBytes.toString("utf8")), version: 999 };
  const futureBytes = `${JSON.stringify(future)}\n`;
  writeFileSync(configPath, futureBytes);
  refuse(["config", "set", "worktreesRoot", join(fixture, "refused")]);
  assert.equal(readFileSync(configPath, "utf8"), futureBytes);
  writeFileSync(configPath, configBytes);

  // Removing an old workspace uses its saved root and keeps its exact branch.
  call(["workspace", "remove", "OLD-1", "--dry-run"]);
  call(["workspace", "remove", "OLD-1"]);
  assert.equal(
    git(["--git-dir", repo.managedRepoPath, "rev-parse", "refs/heads/feat/OLD-1"]),
    oldHead
  );
  assert.ok(existsSync(newer.worktrees[0].path), "old cleanup touched the new root");
  call(["workspace", "remove", "NEW-1"]);
}
