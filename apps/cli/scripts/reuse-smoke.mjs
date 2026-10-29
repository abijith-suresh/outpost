import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";

function snapshot(root) {
  const entries = [];
  const visit = (file) => {
    const stat = lstatSync(file, { bigint: true });
    const entry = [relative(root, file), stat.mtimeNs.toString()];
    if (stat.isSymbolicLink()) entry.push("symlink", readlinkSync(file));
    else if (stat.isDirectory()) {
      entries.push([...entry, "directory"]);
      for (const name of readdirSync(file).sort()) visit(join(file, name));
      return;
    } else entry.push("file", createHash("sha256").update(readFileSync(file)).digest("hex"));
    entries.push(entry);
  };
  visit(root);
  return entries;
}

// The existing branch is admitted from owned managed storage after ordinary
// workspace removal. The remote is unavailable throughout the reuse workflow.
export function verifyReuseWorkflow({ runInstalled, validateInstalled, smokeRoot }) {
  const fixture = join(smokeRoot, "reuse café");
  const home = join(fixture, "h");
  const trace = join(fixture, "trace.log");
  mkdirSync(fixture, { recursive: true });
  writeFileSync(trace, "");
  const git = (args, cwd = fixture) =>
    execFileSync(
      "git",
      [
        ...(process.platform === "win32" ? ["-c", "core.longpaths=true"] : []),
        "-c",
        "user.name=Outpost Reuse Smoke",
        "-c",
        "user.email=reuse@example.invalid",
        ...args,
      ],
      {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
      }
    ).trim();
  const call = (args, expected = 0) => {
    const result = runInstalled([...args, "--json"], { OUTPOST_HOME: home, GIT_TRACE: trace });
    assert.equal(result.status, expected, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
    const output = JSON.parse(expected === 0 ? result.stdout : result.stderr);
    validateInstalled(output.command, output);
    assert.equal(output.ok, expected === 0);
    assert.equal(expected === 0 ? result.stderr : result.stdout, "");
    return output;
  };
  const sources = [];
  const remotes = [];
  call(["init"]);
  for (let index = 1; index <= 2; index++) {
    const source = join(fixture, `s${index}`);
    const remote = join(fixture, `r${index}.git`);
    mkdirSync(source);
    git(["init", "--bare", remote]);
    git(["init", "-b", "main"], source);
    writeFileSync(join(source, "work.txt"), "initial\n");
    git(["add", "."], source);
    git(["commit", "-m", "initial"], source);
    git(["remote", "add", "origin", remote], source);
    git(["push", "origin", "main"], source);
    git(["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);
    call(["repo", "add", source]);
    writeFileSync(join(source, "source-only.txt"), "source-only committed work\n");
    git(["add", "."], source);
    git(["commit", "-m", "source-only"], source);
    writeFileSync(join(source, "dirty.txt"), "preserve source edits\n");
    sources.push(source);
    remotes.push(remote);
  }
  const repos = call(["repo", "list"]).data.repos;
  const selection = repos.flatMap((repo) => ["--repo", repo.id]);
  const args = (ticket) => ["create", "--ticket", ticket, "--type", "feat", ...selection];
  const seed = call(args("BORROW-SEED")).data;
  assert.ok(seed.worktrees.every((member) => member.branchDisposition === "created"));
  const branch = seed.branch;
  assert.equal(branch, "feat/BORROW-SEED");
  const originalHeads = seed.worktrees.map((member) => {
    writeFileSync(join(member.path, "unique.txt"), `unique branch-only ${member.repoId}\n`);
    git(["add", "."], member.path);
    git(["commit", "-m", "branch-only"], member.path);
    return git(["rev-parse", "HEAD"], member.path);
  });
  call(["workspace", "remove", "BORROW-SEED"]);
  for (const remote of remotes) renameSync(remote, `${remote}.offline`);
  writeFileSync(trace, "");
  const immutableSources = [...sources, ...remotes.map((remote) => `${remote}.offline`)];
  const sourceBefore = immutableSources.map(snapshot);
  const reuseArgs = (ticket) => [...args(ticket), "--reuse-branch", branch];
  git(["--git-dir", repos[0].managedRepoPath, "branch", "only-first", originalHeads[0]]);
  const refsBeforeRefusal = repos.map((repo) =>
    git(["--git-dir", repo.managedRepoPath, "show-ref"])
  );
  const refused = call([...args("BORROW-MISSING"), "--reuse-branch", "only-first"], 1);
  assert.match(refused.error.message, /branch|ref|available/i);
  assert.ok(!existsSync(join(home, "worktrees", "BORROW-MISSING")));
  assert.ok(!existsSync(join(home, "workspaces", "BORROW-MISSING.json")));
  assert.deepEqual(
    repos.map((repo) => git(["--git-dir", repo.managedRepoPath, "show-ref"])),
    refsBeforeRefusal,
    "later member refusal changed an existing branch"
  );
  // Fixture owner temporarily moves its own object outside storage. Reuse must
  // refuse both leaf aliases and directory junctions without repairing either.
  for (const kind of ["leaf", "fanout"]) {
    const repo = repos[0];
    const sha = originalHeads[0];
    const fanout = join(repo.managedRepoPath, "objects", sha.slice(0, 2));
    const loose = join(fanout, sha.slice(2));
    const original = kind === "leaf" ? loose : fanout;
    const held = join(fixture, `external-object-${kind}`);
    const refBytes = readFileSync(
      join(repo.managedRepoPath, "refs", "heads", ...branch.split("/"))
    );
    renameSync(original, held);
    symlinkSync(
      held,
      original,
      kind === "leaf" ? "file" : process.platform === "win32" ? "junction" : "dir"
    );
    const externalBefore = snapshot(held);
    for (const dry of [true, false]) {
      const ticket = `BORROW-OBJECT-${kind}-${dry ? "DRY" : "RUN"}`;
      const refusedAlias = call([...reuseArgs(ticket), ...(dry ? ["--dry-run"] : [])], 1);
      assert.match(refusedAlias.error.message, /alias|ownership|storage/i);
      assert.ok(!existsSync(join(home, "worktrees", ticket)));
      assert.ok(!existsSync(join(home, "workspaces", `${ticket}.json`)));
      assert.deepEqual(
        readFileSync(join(repo.managedRepoPath, "refs", "heads", ...branch.split("/"))),
        refBytes
      );
      assert.deepEqual(snapshot(held), externalBefore);
      assert.ok(lstatSync(original).isSymbolicLink());
    }
    renameSync(held, `${held}.absent`);
    assert.throws(() =>
      git(["--git-dir", repo.managedRepoPath, "cat-file", "-e", `${sha}^{commit}`])
    );
    renameSync(`${held}.absent`, held);
    // Explicit fixture teardown, never an Outpost repair or source import.
    unlinkSync(original);
    renameSync(held, original);
  }
  const beforePreview = snapshot(home);
  const preview = call([...reuseArgs("BORROW-NEW"), "--dry-run"]).data;
  assert.equal(preview.branch, branch);
  assert.ok(preview.worktrees.every((member) => member.branchDisposition === "existing"));
  assert.deepEqual(
    preview.worktrees.map((member) => member.baseCommit),
    originalHeads
  );
  assert.deepEqual(snapshot(home), beforePreview, "reuse dry-run changed owned bytes or mtimes");
  assert.ok(!existsSync(join(home, "worktrees", "BORROW-NEW")));

  const created = call(reuseArgs("BORROW-NEW")).data;
  assert.equal(created.branch, branch);
  const manifestFile = join(home, "workspaces", "BORROW-NEW.json");
  const manifestBytes = readFileSync(manifestFile);
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.version, 4);
  for (let index = 0; index < created.worktrees.length; index++) {
    const member = created.worktrees[index];
    assert.equal(member.branch, branch);
    assert.equal(member.branchDisposition, "existing");
    assert.equal(member.baseSource, "local");
    assert.equal(member.requestedBase, branch);
    assert.equal(member.baseRef, `refs/heads/${branch}`);
    assert.equal(member.baseCommit, originalHeads[index]);
    assert.equal(git(["rev-parse", "HEAD"], member.path), originalHeads[index]);
    assert.equal(git(["symbolic-ref", "HEAD"], member.path), `refs/heads/${branch}`);
    assert.equal(manifest.repositories[index].baseCommit, originalHeads[index]);
    assert.equal(manifest.repositories[index].branchDisposition, "existing");
    assert.match(
      readFileSync(join(created.ticketDirectory, "AGENTS.md"), "utf8"),
      new RegExp(originalHeads[index])
    );
    assert.throws(() =>
      git([
        "--git-dir",
        repos[index].managedRepoPath,
        "show-ref",
        "--verify",
        "refs/heads/feat/BORROW-NEW",
      ])
    );
  }
  const conflict = call(reuseArgs("BORROW-CONFLICT"), 1);
  assert.match(conflict.error.message, /checked out|attached|worktree/i);
  assert.ok(!existsSync(join(home, "worktrees", "BORROW-CONFLICT")));
  assert.deepEqual(readFileSync(manifestFile), manifestBytes);
  const repeated = call(reuseArgs("BORROW-NEW"), 1);
  assert.match(repeated.error.message, /workspace resume/);
  const incompatible = call([...reuseArgs("BORROW-OPTIONS"), "--base-source", "fresh-remote"], 1);
  assert.match(incompatible.error.message, /mutually|cannot|combine|exclusive/i);
  const advanced = created.worktrees.map((member) => {
    writeFileSync(join(member.path, "advanced.txt"), "advanced after admission\n");
    git(["add", "."], member.path);
    git(["commit", "-m", "advance reused branch"], member.path);
    return git(["rev-parse", "HEAD"], member.path);
  });
  const resumed = call(["workspace", "resume", "BORROW-NEW"]).data;
  assert.equal(resumed.status, "ready");
  assert.deepEqual(
    resumed.worktrees.map((member) => member.currentHead),
    advanced
  );
  assert.deepEqual(
    resumed.worktrees.map((member) => member.originalBase.baseCommit),
    originalHeads
  );
  assert.ok(
    resumed.worktrees.every((member) => member.originalBase.branchDisposition === "existing")
  );
  assert.deepEqual(readFileSync(manifestFile), manifestBytes);
  call(["workspace", "remove", "BORROW-NEW"]);
  for (let index = 0; index < repos.length; index++) {
    assert.equal(
      git(["--git-dir", repos[index].managedRepoPath, "rev-parse", `refs/heads/${branch}`]),
      advanced[index]
    );
  }
  const again = call(reuseArgs("BORROW-AGAIN")).data;
  assert.deepEqual(
    again.worktrees.map((member) => member.baseCommit),
    advanced
  );
  call(["workspace", "remove", "BORROW-AGAIN"]);
  assert.deepEqual(
    immutableSources.map(snapshot),
    sourceBefore,
    "reuse changed source or offline remote bytes/mtimes"
  );
  assert.doesNotMatch(readFileSync(trace, "utf8"), /\bfetch\b/);
  process.stdout.write(
    "Installed explicit branch reuse preserved branch-only and advanced commits, source bytes/mtimes and original provenance offline\n"
  );
}
