import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { verifyOldCachedWriter } from "./fresh-old-writer-smoke.mjs";

export function verifyFreshBaseWorkflow({ runInstalled, validateInstalled, smokeRoot }) {
  const root = join(smokeRoot, "fresh café");
  const source = join(root, "src");
  const writer = join(root, "writer");
  const remote = join(root, "r.git");
  const home = join(root, "h");
  mkdirSync(source, { recursive: true });
  mkdirSync(writer);
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
  const call = (args, code = 0) => {
    const r = runInstalled([...args, "--json"], { OUTPOST_HOME: home });
    assert.equal(r.status, code, `${args}\n${r.stdout}\n${r.stderr}`);
    const envelope = JSON.parse(r.stderr || r.stdout);
    validateInstalled(envelope.command, envelope);
    return envelope.data;
  };
  git(source, "init", "-b", "main");
  git(source, "config", "core.autocrlf", "false");
  writeFileSync(join(source, "README"), "source A\n");
  git(source, "add", ".");
  git(source, "commit", "-m", "A");
  const initial = git(source, "rev-parse", "HEAD");
  git(source, "clone", "--bare", source, remote);
  git(source, "remote", "add", "team", remote);
  git(source, "update-ref", "refs/remotes/team/main", initial);
  git(writer, "clone", remote, ".");
  git(writer, "config", "core.autocrlf", "false");
  writeFileSync(join(writer, "new"), "remote only B\n");
  git(writer, "add", ".");
  git(writer, "commit", "-m", "B");
  git(writer, "push", "origin", "main");
  const fresh = git(writer, "rev-parse", "HEAD");
  assert.notEqual(initial, fresh);
  assert.throws(() => git(source, "cat-file", "-e", fresh));
  git(source, "update-index", "--split-index");
  writeFileSync(join(source, "dirty"), "source dirty\n");
  function snapshot(directory) {
    const values = new Map();
    const visit = (dir) => {
      for (const name of readdirSync(dir)) {
        const file = join(dir, name);
        const stat = lstatSync(file, { bigint: true });
        if (stat.isDirectory()) visit(file);
        else if (stat.isFile()) values.set(file, [stat.mtimeNs, readFileSync(file)]);
      }
    };
    visit(directory);
    return values;
  }
  function preserved(values) {
    for (const [file, [mtime, bytes]] of values) {
      assert.equal(lstatSync(file, { bigint: true }).mtimeNs, mtime, file);
      assert.deepEqual(readFileSync(file), bytes, file);
    }
  }
  call(["init"]);
  const repo = call(["repo", "register", source, "--name", "app"]).repository;
  const before = snapshot(source);
  const args = [
    "create",
    "--ticket",
    "FRESH",
    "--type",
    "feat",
    "--repo",
    repo.id,
    "--base-source",
    "fresh-remote",
    "--remote",
    "team",
    "--base",
    "refs/heads/main",
  ];
  const preview = call([...args, "--dry-run"]);
  assert.equal(preview.worktrees[0].baseCommit, null);
  assert.equal(preview.worktrees[0].baseResolution, "fetch-required");
  preserved(before);
  const made = call(args);
  const member = made.worktrees[0];
  assert.equal(member.baseCommit, fresh);
  assert.equal(git(member.path, "rev-parse", "HEAD"), fresh);
  assert.equal(git(source, "rev-parse", "refs/remotes/team/main"), initial);
  assert.equal(git(source, "rev-parse", "main"), initial);
  const mf = join(home, "workspaces", "FRESH.json");
  assert.equal(JSON.parse(readFileSync(mf, "utf8")).version, 7);
  assert.equal(member.fetchReceipt.commit, fresh);
  assert.equal(git(source, "rev-parse", member.fetchReceipt.ref), fresh);
  assert.equal(made.receiptInventory.operationId, member.fetchReceipt.operationId);
  assert.ok(existsSync(made.receiptInventory.path));
  const completed = JSON.parse(readFileSync(made.receiptInventory.path, "utf8"));
  assert.equal(completed.status, "completed-retained");
  assert.equal(call(["doctor"]).status, "ok");
  const preceding = process.env.OUTPOST_PRECEDING_CLI;
  if (preceding) {
    const old = (args, code) => {
      const r = spawnSync(process.execPath, [preceding, ...args, "--json"], {
        env: { ...process.env, OUTPOST_HOME: home },
        encoding: "utf8",
        timeout: 30_000,
      });
      assert.equal(r.status, code, `${args}: ${r.stdout}\n${r.stderr}`);
      return JSON.parse(r.stderr || r.stdout);
    };
    const protectedFiles = new Map([...snapshot(source), ...snapshot(home)]);
    const legacyDoctor = old(["doctor"], 0);
    assert.ok(
      legacyDoctor.data.operationRecords.some(
        (record) => record.kind === "operation" && record.metadata?.status === "completed-retained"
      )
    );
    assert.ok(
      legacyDoctor.data.diagnostics.some((message) => message.includes("Incomplete operations"))
    );
    preserved(protectedFiles);
    assert.equal(old(["workspace", "show", "FRESH"], 0).data.status, "invalid");
    old(["workspace", "resume", "FRESH"], 1);
    old(["workspace", "remove", "FRESH"], 1);
    old(["repo", "remove", repo.id], 1);
    preserved(protectedFiles);
    const originalManifest = readFileSync(mf);
    const inventoryBefore = readFileSync(made.receiptInventory.path);
    verifyOldCachedWriter({ preceding, root, home, repoId: repo.id, runInstalled });
    old(["workspace", "remove", "OLDCACHED"], 0);
    assert.deepEqual(readFileSync(made.receiptInventory.path), inventoryBefore);
    const independent = old(
      [
        "create",
        "--ticket",
        "OLDLOCAL",
        "--type",
        "feat",
        "--repo",
        repo.id,
        "--base-source",
        "local",
        "--base",
        "refs/heads/main",
      ],
      0
    );
    assert.equal(independent.data.worktrees[0].baseCommit, initial);
    assert.equal(
      JSON.parse(readFileSync(join(home, "workspaces", "OLDLOCAL.json"), "utf8")).version,
      5
    );
    old(["workspace", "remove", "OLDLOCAL"], 0);
    assert.deepEqual(readFileSync(mf), originalManifest);
    preserved(before);
    console.log(
      "Actual installed PR157 refuses v7 read/mutations and preserves original files; independent old v5 writer leaves v7/inventory unchanged. Old doctor may call retained inventory incomplete."
    );
  }
  git(member.path, "commit", "--allow-empty", "-m", "owned advance");
  const advanced = git(member.path, "rev-parse", "HEAD");
  writeFileSync(join(member.path, "dirty"), "owned dirty\n");
  const resumed = call(["workspace", "resume", "FRESH"]);
  assert.equal(resumed.resumable, true);
  assert.equal(resumed.worktrees[0].currentHead, advanced);
  assert.deepEqual(resumed.worktrees[0].originalBase.fetchReceipt, member.fetchReceipt);
  call(["workspace", "remove", "FRESH"], 1);
  // Explicit fixture edit only. The product never cleans dirty work automatically.
  unlinkSync(join(member.path, "dirty"));
  call(["workspace", "remove", "FRESH"]);
  assert.ok(existsSync(made.receiptInventory.path));
  assert.equal(git(source, "rev-parse", member.fetchReceipt.ref), fresh);
  assert.equal(git(source, "rev-parse", "feat/FRESH"), advanced);
  preserved(before);
  console.log(
    "Installed borrowed fresh v7 advertised remote-only SHA; cache/source refs and split bytes/ns preserved; retained receipt/inventory survive advanced resume and clean removal."
  );
}
