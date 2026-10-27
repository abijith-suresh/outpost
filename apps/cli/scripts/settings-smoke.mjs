import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
    assert.equal(result.status, 1, `${args.join(" ")}\n${result.stderr}\n${result.stdout}`);
    assert.equal(result.stdout, "");
    const output = JSON.parse(result.stderr);
    validateInstalled(output.command, output);
    assert.equal(output.ok, false);
    return output;
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
  for (const member of legacyManifest.repositories) {
    for (const key of ["baseSource", "requestedBase", "baseRef", "baseCommit"]) delete member[key];
  }
  writeFileSync(manifestPath, `${JSON.stringify(legacyManifest, null, 2)}\n`);
  // New creation installs root/provenance safeguards. Model a genuine legacy
  // home explicitly so the following root-refusal test still checks migration
  // from v1, with its original paths and exact persisted bytes.
  const initialConfig = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  writeFileSync(
    join(home, "config.json"),
    `${JSON.stringify({
      version: 1,
      outpostHome: initialConfig.outpostHome,
      reposRoot: initialConfig.reposRoot,
      worktreesRoot: initialConfig.worktreesRoot,
    })}\n`
  );
  const initialRegistry = JSON.parse(readFileSync(join(home, "repos.json"), "utf8"));
  writeFileSync(
    join(home, "repos.json"),
    `${JSON.stringify({ repos: initialRegistry.repositories ?? initialRegistry.repos })}\n`
  );
  const legacyBytes = readFileSync(manifestPath);
  if (process.platform === "win32") {
    // Exercise the installed .cmd shim and native canonicalization before the
    // first v2 migration. A rejected root must preserve the v1 state bytewise.
    const canonicalFixture = realpathSync.native(fixture);
    const unsupportedRoot = join(canonicalFixture, "unsupported café ".repeat(9), "future");
    mkdirSync(unsupportedRoot, { recursive: true });
    const sentinel = join(unsupportedRoot, "keep.txt");
    writeFileSync(sentinel, "unowned root sentinel\n");
    const configPath = join(home, "config.json");
    const registryPath = join(home, "repos.json");
    const configBefore = readFileSync(configPath);
    const registryBefore = readFileSync(registryPath);
    const refsBefore = git(["--git-dir", repo.managedRepoPath, "show-ref"]);
    const sourceConfigBefore = readFileSync(join(source, ".git", "config"));
    const refused = refuse(["config", "set", "worktreesRoot", unsupportedRoot]);
    assert.equal(refused.error.reason, "invalid-arguments");
    assert.equal(refused.error.retryable, false);
    assert.match(refused.error.message, /UTF-8 bytes; maximum 220/);
    assert.match(refused.error.action, /shorter user-owned/);
    assert.deepEqual(readFileSync(configPath), configBefore);
    assert.deepEqual(readFileSync(registryPath), registryBefore);
    assert.deepEqual(readFileSync(manifestPath), legacyBytes);
    assert.deepEqual(readFileSync(agentsPath), agentsBefore);
    assert.deepEqual(readFileSync(join(source, ".git", "config")), sourceConfigBefore);
    assert.equal(git(["--git-dir", repo.managedRepoPath, "show-ref"]), refsBefore);
    assert.equal(git(["rev-parse", "HEAD"], oldWorktree), oldHead);
    assert.equal(readFileSync(sentinel, "utf8"), "unowned root sentinel\n");
    assert.equal(call(["workspace", "show", "OLD-1"]).status, "ready");
    process.stdout.write(
      "Installed Windows path refusal preserved legacy state and branch-only work\n"
    );
  }
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

  // An innocuous unregister must never discard branch-only work. Exercise the
  // actual installed CLI, then recover offline using only its saved identity.
  assert.throws(() => git(["cat-file", "-e", `${oldHead}^{commit}`]), "source has workspace SHA");
  assert.throws(
    () => git(["--git-dir", remote, "cat-file", "-e", `${oldHead}^{commit}`]),
    "remote has workspace SHA"
  );
  writeFileSync(join(source, "source-only.txt"), "keep source-only work too\n");
  git(["add", "source-only.txt"]);
  git(["commit", "-m", "source-only work"]);
  const sourceOnlyHead = git(["rev-parse", "HEAD"]);
  const refs = git(["--git-dir", repo.managedRepoPath, "show-ref"]);
  const mirrorConfig = readFileSync(join(repo.managedRepoPath, "config"));
  const sourceConfig = readFileSync(join(source, ".git", "config"));
  const registryPath = join(home, "repos.json");
  const registryBefore = readFileSync(registryPath);
  const configBefore = readFileSync(configPath);
  const activeRecord = call(["repo", "show", repo.id]);
  const removalPlan = call(["repo", "remove", repo.id, "--dry-run"]);
  assert.equal(removalPlan.action, "unregistered");
  assert.equal(removalPlan.storage, "retained");
  assert.deepEqual(readFileSync(registryPath), registryBefore, "preview changed registration");
  assert.deepEqual(readFileSync(configPath), configBefore, "preview changed configuration");
  const removed = call(["repo", "remove", repo.id]);
  assert.equal(removed.action, "unregistered");
  assert.equal(removed.storage, "retained");
  assert.equal(call(["repo", "list"]).repos.length, 0);
  const retainedList = call(["repo", "list", "--retained"]).repos;
  assert.equal(retainedList.length, 1);
  assert.equal(retainedList[0].id, repo.id);
  const retained = call(["repo", "show", repo.id, "--retained"]);
  assert.equal(retained.inspection.status, "ok");
  assert.ok(
    retained.inspection.refs.some(
      (ref) => ref.name === "refs/heads/feat/OLD-1" && ref.objectId === oldHead
    ),
    "retained inspection lost exact branch-only SHA"
  );
  const retainedBytes = readFileSync(registryPath);
  refuse(["repo", "add", source]);
  refuse(["repo", "remove", repo.id]);
  assert.deepEqual(readFileSync(registryPath), retainedBytes);
  assert.equal(git(["--git-dir", repo.managedRepoPath, "show-ref"]), refs);
  assert.deepEqual(readFileSync(join(repo.managedRepoPath, "config")), mirrorConfig);
  assert.deepEqual(readFileSync(join(source, ".git", "config")), sourceConfig);
  assert.equal(git(["rev-parse", "HEAD"]), sourceOnlyHead);

  // A same-path foreign directory is never adopted as the retained repository.
  const savedStorage = `${repo.managedRepoPath}.saved`;
  renameSync(repo.managedRepoPath, savedStorage);
  mkdirSync(repo.managedRepoPath);
  const foreignSentinel = join(repo.managedRepoPath, "keep.txt");
  writeFileSync(foreignSentinel, "foreign storage\n");
  assert.equal(call(["repo", "show", repo.id, "--retained"]).inspection.status, "unavailable");
  refuse(["repo", "restore", repo.id]);
  assert.equal(readFileSync(foreignSentinel, "utf8"), "foreign storage\n");
  assert.deepEqual(readFileSync(registryPath), retainedBytes);
  rmSync(repo.managedRepoPath, { recursive: true });
  renameSync(savedStorage, repo.managedRepoPath);

  // Settings writers must preserve the versioned retained set. Neither source
  // nor remote is available at its registered path when restoration runs.
  call(["guidance", "clear"]);
  assert.equal(call(["repo", "list", "--retained"]).repos[0].id, repo.id);
  const offlineSource = `${source} offline`;
  renameSync(source, offlineSource);
  renameSync(remote, `${remote} offline`);
  const beforeRestore = readFileSync(registryPath);
  call(["repo", "restore", repo.id, "--dry-run"]);
  assert.deepEqual(readFileSync(registryPath), beforeRestore);
  call(["repo", "restore", repo.id]);
  assert.equal(call(["repo", "list", "--retained"]).repos.length, 0);
  const restored = call(["repo", "show", repo.id]);
  for (const key of [
    "id",
    "name",
    "managedRepoPath",
    "remoteName",
    "remoteUrl",
    "sourceRepoPath",
    "importedAt",
    "lastFetchedAt",
    "tags",
  ]) {
    assert.deepEqual(restored[key], activeRecord[key], `restore changed ${key}`);
  }
  assert.equal(git(["--git-dir", repo.managedRepoPath, "show-ref"], offlineSource), refs);
  assert.equal(git(["rev-parse", "HEAD"], offlineSource), sourceOnlyHead);
  assert.deepEqual(readFileSync(join(offlineSource, ".git", "config")), sourceConfig);
  assert.deepEqual(readFileSync(join(repo.managedRepoPath, "config")), mirrorConfig);
  process.stdout.write(
    "Installed unregister/restore preserved exact branch-only and source-only SHAs\n"
  );
}
