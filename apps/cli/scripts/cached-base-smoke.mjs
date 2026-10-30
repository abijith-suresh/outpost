import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export function verifyCachedBaseWorkflow({ runInstalled, validateInstalled, smokeRoot }) {
  const root = join(smokeRoot, "cached café");
  const source = join(root, "src");
  const home = join(root, "h");
  const marker = join(root, "helper-ran");
  mkdirSync(source, { recursive: true });
  const git = (...args) =>
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
        source,
        ...args,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    ).trim();
  const call = (args, expected = 0) => {
    const r = runInstalled([...args, "--json"], { OUTPOST_HOME: home });
    assert.equal(r.status, expected, `${args}\n${r.stdout}\n${r.stderr}`);
    const envelope = JSON.parse(r.stderr || r.stdout);
    validateInstalled(envelope.command, envelope);
    assert.doesNotMatch(`${r.stdout}${r.stderr}`, /FIXTURE_SECRET_42/);
    return envelope.data;
  };
  git("init", "-b", "main");
  git("config", "core.autocrlf", "false");
  writeFileSync(join(source, "README"), "cached original\n");
  git("add", ".");
  git("commit", "-m", "cached");
  const cached = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/team/topic/sub", cached);
  writeFileSync(join(source, "README"), "source only advanced\n");
  git("commit", "-am", "local");
  const local = git("rev-parse", "HEAD");
  git("update-index", "--split-index");
  git(
    "remote",
    "add",
    "team",
    "https://fixture-user:FIXTURE_SECRET_42@invalid.example/uncontacted"
  );
  git("config", "credential.helper", `!echo called > "${marker.replaceAll("\\", "/")}"; exit 99`);
  git("config", "core.askPass", `echo called > "${marker.replaceAll("\\", "/")}"`);
  writeFileSync(join(source, "dirty"), "preserved source\n");
  const snapshot = () => {
    const found = new Map();
    const visit = (dir) => {
      for (const n of readdirSync(dir)) {
        const p = join(dir, n);
        const s = lstatSync(p, { bigint: true });
        if (s.isDirectory()) visit(p);
        else if (s.isFile())
          found.set(p, [s.mtimeNs.toString(), readFileSync(p).toString("base64")]);
      }
    };
    visit(source);
    return found;
  };
  const before = snapshot();
  call(["init"]);
  const record = call(["repo", "register", source, "--name", "app"]).repository;
  const args = [
    "create",
    "--ticket",
    "CACHED",
    "--type",
    "feat",
    "--repo",
    record.id,
    "--base-source",
    "cached-remote",
    "--remote",
    "team",
    "--base",
    "refs/heads/topic/sub",
  ];
  const preview = call([...args, "--dry-run"]);
  assert.equal(preview.worktrees[0].baseCommit, cached);
  const made = call(args);
  assert.equal(made.worktrees[0].baseRemote, "team");
  assert.equal(made.worktrees[0].baseCommit, cached);
  assert.notEqual(cached, local);
  const manifest = JSON.parse(readFileSync(join(home, "workspaces", "CACHED.json"), "utf8"));
  assert.equal(manifest.version, 6);
  assert.match(
    readFileSync(join(home, "worktrees", "CACHED", "AGENTS.md"), "utf8"),
    /unverified cached snapshot/
  );
  assert.equal(call(["workspace", "show", "CACHED"]).worktrees[0].baseRemote, "team");
  assert.equal(
    call(["workspace", "resume", "CACHED"]).worktrees[0].originalBase.remoteRef,
    "refs/heads/topic/sub"
  );
  call(["workspace", "remove", "CACHED"]);
  assert.equal(git("rev-parse", "main"), local);
  assert.equal(git("rev-parse", "feat/CACHED"), cached);
  const after = snapshot();
  for (const [p, value] of before) assert.deepEqual(after.get(p), value, p);
  assert.equal(existsSync(marker), false);
  const scan = (dir) => {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n);
      if (lstatSync(p).isDirectory()) scan(p);
      else assert.doesNotMatch(readFileSync(p, "utf8"), /FIXTURE_SECRET_42/, p);
    }
  };
  scan(home);
  git("config", "--unset-all", "remote.team.url");
  const missing = [...args];
  missing[2] = "MISSING";
  call([...missing, "--dry-run"], 1);
  console.log(
    "Installed cached v6 named tracking SHA/provenance preserved source split bytes/ns, local branches and no helper/transport or secret persistence."
  );
}
