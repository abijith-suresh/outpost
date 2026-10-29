import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

function snapshot(root) {
  const result = new Map();
  const visit = (dir) => {
    for (const name of readdirSync(dir)) {
      const file = join(dir, name);
      const stat = lstatSync(file, { bigint: true });
      if (stat.isDirectory()) visit(file);
      else if (stat.isFile())
        result.set(file, [stat.mtimeNs.toString(), readFileSync(file).toString("base64")]);
    }
  };
  visit(root);
  return result;
}
function preserved(before) {
  for (const [file, value] of before)
    assert.deepEqual(
      [lstatSync(file, { bigint: true }).mtimeNs.toString(), readFileSync(file).toString("base64")],
      value,
      file
    );
}
export function verifyBorrowedLocalWorkflow({ runInstalled, validateInstalled, smokeRoot }) {
  const root = join(smokeRoot, "borrowed local café");
  const source = join(root, "source");
  const home = join(root, "h");
  const trace = join(root, "trace");
  mkdirSync(source, { recursive: true });
  writeFileSync(trace, "");
  const git = (cwd, ...args) =>
    execFileSync(
      "git",
      [
        "-c",
        "core.longpaths=true",
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-C",
        cwd,
        ...args,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    ).trim();
  const call = (args, expected = 0) => {
    const r = runInstalled([...args, "--json"], { OUTPOST_HOME: home, GIT_TRACE: trace });
    assert.equal(r.status, expected, `${args}\n${r.stdout}\n${r.stderr}`);
    const output = JSON.parse(expected === 0 ? r.stdout : r.stderr);
    validateInstalled(output.command, output);
    return output;
  };
  git(source, "init", "-b", "main");
  git(source, "config", "core.autocrlf", "false");
  writeFileSync(join(source, "README"), "source-only\n");
  git(source, "add", ".");
  git(source, "commit", "-m", "local");
  const sha = git(source, "rev-parse", "HEAD");
  git(source, "update-index", "--split-index");
  git(source, "config", "branch.autoSetupMerge", "always");
  git(source, "config", "credential.helper", "!exit 97");
  git(source, "config", "filter.idle.smudge", "exit 98");
  const hook = join(source, ".git", "hooks", "reference-transaction");
  writeFileSync(hook, "#!/bin/sh\nexit 99\n");
  chmodSync(hook, 0o755);
  writeFileSync(join(source, "README"), "dirty source\n");
  writeFileSync(join(source, ".gitattributes"), "README filter=idle\n");
  const before = snapshot(source);
  call(["init"]);
  const record = call(["repo", "register", source, "--name", "app"]).data.repository;
  const create = [
    "create",
    "--ticket",
    "LOCAL",
    "--type",
    "feat",
    "--repo",
    record.id,
    "--base-source",
    "local",
    "--base",
    "refs/heads/main",
  ];
  assert.equal(call([...create, "--dry-run"]).data.worktrees[0].baseCommit, sha);
  preserved(before);
  const made = call(create).data;
  const checkout = made.worktrees[0].path;
  assert.equal(made.worktrees[0].storageKind, "borrowed");
  assert.equal(git(checkout, "rev-parse", "HEAD"), sha);
  assert.equal(readFileSync(join(checkout, "README"), "utf8"), "source-only\n");
  preserved(before);
  const manifest = JSON.parse(readFileSync(join(home, "workspaces", "LOCAL.json"), "utf8"));
  assert.equal(manifest.version, 5);
  assert.equal(manifest.repositories[0].storage.common.inode, record.common.inode);
  call(["workspace", "show", "LOCAL"]);
  call(["repo", "remove", record.id], 1);
  call(create, 1);
  git(checkout, "-c", "core.hooksPath=", "commit", "--allow-empty", "-m", "advanced");
  const advanced = git(checkout, "rev-parse", "HEAD");
  writeFileSync(join(checkout, "untracked"), "owned work\n");
  const resumed = call(["workspace", "resume", "LOCAL"]).data;
  assert.equal(resumed.worktrees[0].currentHead, advanced);
  assert.equal(resumed.worktrees[0].originalBase.baseCommit, sha);
  assert.equal(resumed.worktrees[0].workingState.status, "dirty");
  call(["workspace", "remove", "LOCAL"], 1);
  unlinkSync(join(checkout, "untracked"));
  call(["workspace", "remove", "LOCAL"]);
  assert.equal(git(source, "rev-parse", "feat/LOCAL"), advanced);
  preserved(before);
  call(["repo", "remove", record.id]);
  call(["repo", "restore", record.id]);
  preserved(before);
  assert.doesNotMatch(
    readFileSync(trace, "utf8"),
    /run_command:.*(?:fetch|clone|credential|remote-https|upload-pack)/u
  );
  for (const mode of ["commands", "process"]) {
    const converted = join(root, mode);
    mkdirSync(converted);
    git(converted, "init", "-b", "main");
    git(converted, "config", "core.autocrlf", "false");
    writeFileSync(join(converted, "README"), "content\n");
    writeFileSync(join(converted, ".gitattributes"), "README filter=trusted\n");
    git(converted, "add", ".");
    git(converted, "commit", "-m", "conversion");
    const marker = join(root, `${mode}-driver.log`);
    const driver = resolve("scripts/fixtures/trusted-filter.mjs").replaceAll("\\", "/");
    const command = (direction) =>
      `node "${driver}" ${direction} "${marker.replaceAll("\\", "/")}"`;
    if (mode === "process") git(converted, "config", "filter.trusted.process", command("process"));
    else
      for (const direction of ["clean", "smudge"])
        git(converted, "config", `filter.trusted.${direction}`, command(direction));
    git(converted, "config", "filter.trusted.required", "true");
    const original = snapshot(converted);
    const registered = call(["repo", "register", converted, "--name", mode]).data.repository;
    const created = call([
      "create",
      "--ticket",
      mode,
      "--type",
      "feat",
      "--repo",
      registered.id,
      "--base-source",
      "local",
      "--base",
      "refs/heads/main",
    ]).data;
    assert.equal(readFileSync(join(created.worktrees[0].path, "README"), "utf8"), "WORK:content\n");
    assert.equal(call(["workspace", "resume", mode]).data.resumable, true);
    call(["workspace", "remove", mode]);
    assert.match(readFileSync(marker, "utf8"), /clean/);
    assert.match(readFileSync(marker, "utf8"), /smudge/);
    preserved(original);
  }
  console.log(
    "Installed borrowed local v5 lifecycle preserved split source indexes/sharedindex nanosecond mtimes, dirty source, original SHA, advanced branch disabled hooks/transport, plus trusted synthetic clean/smudge/process conversion."
  );
}
