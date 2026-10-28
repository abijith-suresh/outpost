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
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";

// Include bytes and mtimes: status must not refresh an index or renew linked
// worktree metadata even when its cached stat information is stale.
function snapshot(root) {
  const entries = [];
  const visit = (file) => {
    const stat = lstatSync(file, { bigint: true });
    const entry = [relative(root, file), stat.mtimeNs.toString()];
    if (stat.isSymbolicLink()) entry.push("symlink", readlinkSync(file));
    else if (stat.isDirectory()) {
      entry.push("directory");
      entries.push(entry);
      for (const name of readdirSync(file).sort()) visit(join(file, name));
      return;
    } else entry.push("file", createHash("sha256").update(readFileSync(file)).digest("hex"));
    entries.push(entry);
  };
  visit(root);
  return entries;
}

export function verifyResumeWorkflow({ runInstalled, validateInstalled, smokeRoot }) {
  const fixture = join(smokeRoot, "resume café");
  const home = join(fixture, "h");
  const trace = join(fixture, "trace.log");
  mkdirSync(fixture, { recursive: true });
  writeFileSync(trace, "");
  const sources = [];
  const remotes = [];
  const sourceOnly = [];
  const git = (args, cwd = fixture) =>
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
  const call = (args, exit = 0, partial = false) => {
    const result = runInstalled([...args, "--json"], {
      OUTPOST_HOME: home,
      GIT_TRACE: trace,
    });
    assert.equal(result.status, exit, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
    const output = JSON.parse(result.stdout || result.stderr);
    validateInstalled(output.command, output);
    assert.equal(output.ok, exit === 0);
    assert.equal(exit === 0 || partial ? result.stderr : result.stdout, "");
    if (partial) assert.ok(output.data, "partial resume lost member diagnostics");
    return output;
  };
  call(["init"]);
  for (let index = 1; index <= 2; index++) {
    const source = join(fixture, `s${index}`);
    const remote = join(fixture, `r${index}.git`);
    mkdirSync(source);
    git(["init", "--bare", remote]);
    git(["init", "-b", "main"], source);
    git(["config", "user.name", "Outpost Resume Smoke"], source);
    git(["config", "user.email", "resume@example.invalid"], source);
    writeFileSync(join(source, "work.txt"), "initial\n");
    writeFileSync(join(source, "clean.txt"), "same content, stale index stat later\n");
    git(["add", "."], source);
    git(["commit", "-m", "initial"], source);
    git(["remote", "add", "origin", remote], source);
    git(["push", "origin", "main"], source);
    git(["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);
    call(["repo", "add", source]);
    writeFileSync(join(source, "source-only.txt"), "source-only committed work\n");
    git(["add", "source-only.txt"], source);
    git(["commit", "-m", "source-only"], source);
    sourceOnly.push(git(["rev-parse", "HEAD"], source));
    writeFileSync(join(source, "dirty-source.txt"), "preserve source edits\n");
    sources.push(source);
    remotes.push(remote);
  }
  const repos = call(["repo", "list"]).data.repos;
  const createArgs = [
    "create",
    "--ticket",
    "RS-1",
    "--type",
    "feat",
    ...repos.flatMap((repo) => ["--repo", repo.id]),
  ];
  const created = call(createArgs).data;
  const manifestFile = join(home, "workspaces", "RS-1.json");
  const manifestBytes = readFileSync(manifestFile);
  const member = created.worktrees[0];
  git(["config", "user.name", "Outpost Resume Smoke"], member.path);
  git(["config", "user.email", "resume@example.invalid"], member.path);
  writeFileSync(join(member.path, "workspace-only.txt"), "new owned commit\n");
  git(["add", "workspace-only.txt"], member.path);
  git(["commit", "-m", "workspace-only"], member.path);
  const advanced = git(["rev-parse", "HEAD"], member.path);
  assert.notEqual(advanced, member.baseCommit);
  writeFileSync(join(member.path, "work.txt"), "dirty tracked work\n");
  writeFileSync(join(member.path, "untracked café.txt"), "preserve untracked work\n");
  const later = new Date(Date.now() + 5000);
  utimesSync(join(member.path, "clean.txt"), later, later);
  call(["config", "set", "worktreesRoot", join(fixture, "future")]);
  call(["repo", "tag", repos[0].id, "--add", "later"]);
  const agentsFile = join(created.ticketDirectory, "AGENTS.md");
  writeFileSync(agentsFile, `${readFileSync(agentsFile, "utf8")}\nPreserve existing user notes.\n`);
  for (const remote of remotes) renameSync(remote, `${remote}.offline`);
  const preservedRoots = [home, ...sources, ...remotes.map((remote) => `${remote}.offline`)];
  writeFileSync(trace, "");
  const inspect = (exit = 0) => {
    const before = preservedRoots.map(snapshot);
    const result = call(["workspace", "resume", "RS-1"], exit, exit === 1).data;
    assert.deepEqual(preservedRoots.map(snapshot), before, "resume changed bytes or mtimes");
    assert.deepEqual(readFileSync(manifestFile), manifestBytes);
    return result;
  };
  const resumed = inspect();
  assert.equal(resumed.status, "ready");
  assert.equal(resumed.resumable, true);
  assert.equal(resumed.ticketDirectory, created.ticketDirectory);
  assert.deepEqual(
    resumed.worktrees.map((entry) => entry.id),
    created.worktrees.map((entry) => entry.repoId)
  );
  const current = resumed.worktrees.find((entry) => entry.id === member.repoId);
  assert.equal(current.currentHead, advanced);
  assert.equal(current.currentBranch, created.branch);
  assert.equal(current.originalBase.baseCommit, member.baseCommit);
  assert.equal(current.workingState.status, "dirty");
  assert.ok(current.workingState.trackedEntries > 0);
  assert.ok(current.workingState.untrackedEntries > 0);
  assert.equal(current.path, member.path);

  const lock = join(home, ".mutation.lock");
  writeFileSync(lock, '{"operation":"preserve-held-lock"}\n');
  assert.equal(inspect(1).status, "not-ready");
  // Fixture owner releases its own synthetic lock explicitly; resume never does.
  unlinkSync(lock);

  const missing = created.worktrees[1].path;
  renameSync(missing, `${missing}.held`);
  const partial = inspect(1);
  assert.equal(partial.status, "partial");
  assert.equal(partial.worktrees.filter((entry) => entry.resumable).length, 1);
  renameSync(`${missing}.held`, missing);
  assert.doesNotMatch(readFileSync(trace, "utf8"), /\bfetch\b/);

  writeFileSync(trace, "");
  const conflict = call([...createArgs, "--base-source", "fresh-remote"], 1);
  assert.match(conflict.error.message, /workspace resume/);
  assert.doesNotMatch(readFileSync(trace, "utf8"), /\bfetch\b/);
  assert.deepEqual(readFileSync(manifestFile), manifestBytes);

  for (let index = 0; index < sources.length; index++) {
    assert.equal(git(["rev-parse", "HEAD"], sources[index]), sourceOnly[index]);
    assert.equal(
      readFileSync(join(sources[index], "dirty-source.txt"), "utf8"),
      "preserve source edits\n"
    );
  }
  assert.ok(existsSync(join(member.path, "untracked café.txt")));
  process.stdout.write(
    "Installed resume preserved advanced dirty work, frozen provenance/root/members and exact Git/source metadata\n"
  );
}
