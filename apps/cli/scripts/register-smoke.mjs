import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

function snapshot(root) {
  const entries = [];
  const visit = (file) => {
    const s = lstatSync(file, { bigint: true });
    if (s.isDirectory()) {
      for (const name of readdirSync(file).sort()) visit(join(file, name));
    } else
      entries.push([
        relative(root, file),
        s.mtimeNs.toString(),
        readFileSync(file).toString("base64"),
      ]);
  };
  visit(root);
  return entries;
}
export function verifyRegisterWorkflow({ runInstalled, validateInstalled, smokeRoot }) {
  const root = join(smokeRoot, "register café");
  const source = join(root, "s");
  const home = join(root, "h");
  const trace = join(root, "trace");
  mkdirSync(source, { recursive: true });
  writeFileSync(trace, "");
  const git = (...args) =>
    execFileSync(
      "git",
      ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args],
      { cwd: source, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    ).trim();
  const call = (args, expected = 0) => {
    const r = runInstalled([...args, "--json"], { OUTPOST_HOME: home, GIT_TRACE: trace });
    assert.equal(r.status, expected, `${args.join(" ")}\n${r.stdout}\n${r.stderr}`);
    const output = JSON.parse(expected === 0 ? r.stdout : r.stderr);
    validateInstalled(output.command, output);
    return output.data;
  };
  git("init", "-b", "main");
  writeFileSync(join(source, "README"), "committed\n");
  git("add", ".");
  git("commit", "-m", "source");
  git("config", "credential.helper", "!exit 97");
  git("remote", "add", "team", "https://invalid.example/no-contact");
  writeFileSync(join(source, "README"), "dirty\n");
  writeFileSync(join(source, "untracked"), "preserve\n");
  const before = snapshot(source);
  call(["init"]);
  call(["repo", "register", source, "--name", "api", "--dry-run"]);
  const record = call(["repo", "register", source, "--name", "api"]).repository;
  assert.equal(
    record.common.device,
    lstatSync(join(source, ".git"), { bigint: true }).dev.toString()
  );
  console.log(
    `Installed directory identity: ${JSON.stringify({ platform: process.platform, device: record.common.device, inode: record.common.inode })}`
  );
  assert.equal(
    record.common.inode,
    lstatSync(join(source, ".git"), { bigint: true }).ino.toString()
  );
  assert.equal(call(["repo", "register", source, "--name", "api"]).action, "already-registered");
  assert.equal(call(["repo", "show", record.id]).status, "ok");
  call(["repo", "list"]);
  call(
    [
      "create",
      "--ticket",
      "TASK",
      "--type",
      "feat",
      "--repo",
      record.id,
      "--base-source",
      "fresh-remote",
      "--base",
      "main",
    ],
    1
  );
  call(["repo", "fetch", "--all"], 1);
  assert.equal(call(["repo", "remove", record.id]).storage, "external-unchanged");
  call(["repo", "list", "--retained"]);
  call(["repo", "show", record.id, "--retained"]);
  assert.equal(call(["repo", "restore", record.id]).storage, "external-unchanged");
  assert.deepEqual(snapshot(source), before);
  assert.doesNotMatch(
    readFileSync(trace, "utf8"),
    /run_command:.*(?:fetch|clone|credential|remote-https|upload-pack)/u
  );
  console.log(
    "Installed offline registration/retention/restore: source bytes/mtime and lossless directory identity preserved; no transport/auth helper."
  );
}
