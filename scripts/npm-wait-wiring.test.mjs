import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import observer from "./npm-wait-observer.cjs";
import owned from "./npm-wait-owned.cjs";
import {
  measureOwned,
  observeChild,
  suppliedNpmEntry,
  TARGET,
  validateSourceFiles,
} from "./probe-npm-wait.mjs";

const require = createRequire(import.meta.url);
const fixture = (t) => {
  const { directory: dir } = owned.createOwnedDirectory(
    path.join(os.tmpdir(), "outpost-wait-wiring-")
  );
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test("owned scratch canonicalizes an alias parent before actual child checkpoint startup", (t) => {
  const base = fixture(t);
  const actual = path.join(base, "actual"),
    alias = path.join(base, "alias");
  fs.mkdirSync(actual);
  fs.symlinkSync(actual, alias, process.platform === "win32" ? "junction" : "dir");
  const { directory, identity } = owned.createOwnedDirectory(path.join(alias, "probe-"));
  assert.equal(directory, fs.realpathSync.native(directory));
  assert.equal(identity.real, directory);
  assert.equal(path.dirname(directory), fs.realpathSync.native(actual));
  const childFile = path.resolve("scripts/npm-wait-child.cjs");
  execFileSync(
    process.execPath,
    [
      "-e",
      `require(${JSON.stringify(childFile)}).prepare(${JSON.stringify(process.env.npm_execpath)},${JSON.stringify(directory)},${JSON.stringify(identity.dev)},${JSON.stringify(identity.ino)});`,
    ],
    { timeout: 2000, stdio: ["ignore", "pipe", "pipe"] }
  );
  assert.equal(
    observer.readWaitCheckpoint(path.join(directory, "wait-checkpoint.json")).valid,
    true
  );
});

test("owned writer uses exclusive file, bounded strict records and refuses replacement", (t) => {
  const dir = fixture(t),
    id = owned.identity(dir),
    writer = owned.checkpointWriter(dir, id);
  const core = observer.createWaitObserver();
  try {
    writer.write(core.snapshot());
    assert.equal(observer.readWaitCheckpoint(path.join(dir, "wait-checkpoint.json")).valid, true);
    assert.throws(() => owned.checkpointWriter(dir, id));
    assert.throws(() => writer.write({ ...core.snapshot(), privatePath: "PRIVATE" }));
    assert.ok(fs.statSync(path.join(dir, "wait-checkpoint.json")).size <= 65536);
    fs.renameSync(path.join(dir, "wait-checkpoint.json"), path.join(dir, "original"));
    fs.writeFileSync(path.join(dir, "wait-checkpoint.json"), "SENTINEL");
    assert.throws(() => writer.write(core.snapshot()));
    assert.equal(fs.readFileSync(path.join(dir, "wait-checkpoint.json"), "utf8"), "SENTINEL");
  } finally {
    writer.close();
    core.stop();
  }
});

test("owned cleanup refuses substituted directory and leaves replacement bytes untouched", (t) => {
  const base = fixture(t),
    dir = path.join(base, "owned");
  fs.mkdirSync(dir);
  const id = owned.identity(dir);
  fs.renameSync(dir, path.join(base, "old"));
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "sentinel"), "PRIVATE");
  assert.throws(() => owned.removeOwned(dir, id));
  assert.equal(fs.readFileSync(path.join(dir, "sentinel"), "utf8"), "PRIVATE");
});

test("actual bounded child exit/timeout and sink failures preserve original result fields without raw output", (t) => {
  const dir = fixture(t),
    checkpoint = path.join(dir, "missing");
  const records = [];
  for (const mode of ["exit", "timeout"]) {
    let caught;
    try {
      observeChild(
        process.execPath,
        [
          "-e",
          mode === "exit"
            ? 'process.stderr.write("PRIVATE_URI_PATH");process.exit(23)'
            : "setInterval(()=>{},5000)",
        ],
        { timeout: mode === "exit" ? 2000 : 200, stdio: ["ignore", "pipe", "pipe"] },
        checkpoint,
        (v) => {
          records.push(v);
          throw Error("PRIVATE_SINK");
        }
      );
    } catch (e) {
      caught = e;
    }
    assert.ok(caught);
    assert.equal(mode === "exit" ? caught.status : caught.code, mode === "exit" ? 23 : "ETIMEDOUT");
  }
  assert.doesNotMatch(JSON.stringify(records), /PRIVATE|URI|PATH/);
  assert.ok(records.every((v) => v.checkpoint.coverage === "unknown"));
  const result = observeChild(
    process.execPath,
    ["-e", 'process.stdout.write("ok")'],
    { timeout: 2000, stdio: ["ignore", "pipe", "pipe"] },
    checkpoint,
    () => {
      throw Error("PRIVATE");
    }
  );
  assert.equal(result.toString(), "ok");
});

test("narrow child rejects bad npm pin before any npm execution and leaks no supplied entry", (t) => {
  const dir = fixture(t),
    fake = path.join(dir, "PRIVATE-npm-cli.js");
  fs.writeFileSync(fake, 'require("node:fs").writeFileSync("EXECUTED","bad")');
  let caught;
  try {
    execFileSync(
      process.execPath,
      [path.resolve("scripts/npm-wait-child.cjs"), fake, dir, "0", "0"],
      { cwd: dir, timeout: 2000, stdio: ["ignore", "pipe", "pipe"] }
    );
  } catch (e) {
    caught = e;
  }
  assert.equal(caught.status, 86);
  assert.equal(caught.stderr.toString(), "NPM_WAIT_PROBE_INVALID\n");
  assert.equal(fs.existsSync(path.join(dir, "EXECUTED")), false);
});

test("npm-supplied entry refuses guessed wrappers and source validation refuses wrong lock before install", (t) => {
  const dir = fixture(t);
  assert.throws(() => suppliedNpmEntry("npm.cmd"));
  assert.throws(() => suppliedNpmEntry(path.join(dir, "npm.cmd")));
  fs.mkdirSync(path.join(dir, "apps/cli"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package-lock.json"), "{}");
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ packageManager: "npm@11.16.0" })
  );
  fs.writeFileSync(path.join(dir, "apps/cli/package.json"), JSON.stringify({ version: "0.0.26" }));
  fs.writeFileSync(path.join(dir, ".node-version"), "24.22.1");
  assert.throws(() => validateSourceFiles(dir));
  assert.equal(TARGET.source, "0f3e0caf26b4e9a73f5c453eb59465dc1598041c");
});

test("measured scratch cleanup and source finalizer retain exact original error and detect drift", async (t) => {
  const root = fixture(t),
    scratch = fixture(t);
  const git = (args) =>
    execFileSync("git", args, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    });
  git(["init"]);
  git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "fixture",
  ]);
  const file = path.join(root, "source");
  fs.writeFileSync(file, "before");
  const failure = new Error("PRIVATE_CHILD");
  const records = [];
  await assert.rejects(
    measureOwned(
      root,
      scratch,
      owned.identity(scratch),
      () => {
        fs.writeFileSync(file, "after");
        throw failure;
      },
      (v) => records.push(v)
    ),
    (e) => e === failure
  );
  assert.equal(fs.existsSync(scratch), false);
  assert.equal(records[0].source, "unknown-or-drift");
  const second = fixture(t);
  await assert.rejects(
    measureOwned(root, second, owned.identity(second), () => {
      fs.writeFileSync(file, "another");
    }),
    (e) => e.probeCategory === "source-drift"
  );
});

test("workflow route is separate, label-bound, read-only and contains no raw event shell interpolation", () => {
  const file = fs.readFileSync(".github/workflows/npm-wait-probe.yml", "utf8");
  assert.match(file, /types: \[labeled\]/);
  assert.match(file, /format\('npmwait-\{0\}', github.event.pull_request.head.sha\)/);
  assert.match(file, /github.run_attempt == 1/);
  assert.match(file, /persist-credentials: false/);
  assert.doesNotMatch(
    file,
    /workflow_dispatch|pull_request_target|secrets\.|id-token|contents: write/
  );
  const activeStep = file.slice(file.indexOf("- name: One install-only"));
  assert.doesNotMatch(activeStep, /\$\{\{/);
  assert.match(activeStep, /shell: bash\s+run: npm run probe:npm-wait/);
  assert.doesNotMatch(file, /Get-Command|pwsh|--npm-command/);
  const root = JSON.parse(fs.readFileSync("package.json", "utf8"));
  assert.equal(root.private, true);
  assert.equal(root.scripts["probe:npm-wait"], "node scripts/probe-npm-wait.mjs");
  const child = fs.readFileSync("scripts/npm-wait-child.cjs", "utf8");
  assert.doesNotMatch(child, /\.on\(["']data|\.pipe\(|\.resume\(/);
  const { prepare } = require("./npm-wait-child.cjs");
  assert.equal(typeof prepare, "function");
});

test("verified child setup checkpoints on exit without running npm, unref does not keep it alive", (t) => {
  const base = fixture(t);
  const entry = process.env.npm_execpath;
  assert.ok(entry);
  for (const mode of ["normal", "failed-sink"]) {
    const dir = path.join(base, mode);
    fs.mkdirSync(dir);
    const id = owned.identity(dir);
    const childFile = path.resolve("scripts/npm-wait-child.cjs");
    const code = `const fs=require('node:fs');require(${JSON.stringify(childFile)}).prepare(${JSON.stringify(entry)},${JSON.stringify(dir)},${JSON.stringify(id.dev)},${JSON.stringify(id.ino)});${mode === "failed-sink" ? `fs.renameSync(${JSON.stringify(path.join(dir, "wait-checkpoint.json"))},${JSON.stringify(path.join(dir, "old"))});fs.writeFileSync(${JSON.stringify(path.join(dir, "wait-checkpoint.json"))},'SENTINEL');process.exit(23);` : ""}`;
    let failure;
    try {
      execFileSync(process.execPath, ["-e", code], {
        timeout: 2000,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      failure = e;
    }
    if (mode === "normal") {
      assert.equal(failure, undefined);
      assert.equal(observer.readWaitCheckpoint(path.join(dir, "wait-checkpoint.json")).valid, true);
    } else {
      assert.equal(failure.status, 23);
      assert.equal(failure.stderr.length, 0);
      assert.equal(fs.readFileSync(path.join(dir, "wait-checkpoint.json"), "utf8"), "SENTINEL");
    }
  }
});

test("supplied JavaScript entry retains exact pinned verification without wrapper lookup", () => {
  const verified = observer.verifyPinnedNpm(process.env.npm_execpath);
  assert.equal(suppliedNpmEntry(process.env.npm_execpath), verified.entry);
  for (const value of [undefined, "", "npm", "relative.js"])
    assert.throws(() => suppliedNpmEntry(value));
});

test("one actual pinned npm run supplies verified JavaScript entry to an owned minimal fixture", (t) => {
  const dir = fixture(t);
  const verified = observer.verifyPinnedNpm(process.env.npm_execpath);
  const runnerUrl = new URL("./probe-npm-wait.mjs", import.meta.url).href;
  const code = `import path from "node:path";import {suppliedNpmEntry} from ${JSON.stringify(runnerUrl)};const selected=process.env.npm_execpath;const canonical=suppliedNpmEntry(selected);process.stdout.write(JSON.stringify({supplied:typeof selected==='string',absoluteJavaScriptEntry:typeof selected==='string'&&path.isAbsolute(selected)&&selected.endsWith('.js'),verifiedIdentity:canonical===${JSON.stringify(verified.entry)},npmRunContext:process.env.npm_lifecycle_event==='identity'}));`;
  fs.writeFileSync(path.join(dir, "identity.mjs"), code);
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ private: true, scripts: { identity: "node identity.mjs" } })
  );
  const env = { ...process.env };
  delete env.npm_execpath;
  const output = execFileSync(process.execPath, [verified.entry, "run", "identity", "--silent"], {
    cwd: dir,
    env,
    timeout: 15000,
    maxBuffer: 8192,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  const proof = JSON.parse(output);
  assert.deepEqual(proof, {
    supplied: true,
    absoluteJavaScriptEntry: true,
    verifiedIdentity: true,
    npmRunContext: true,
  });
  t.diagnostic(JSON.stringify(proof));
});

test("completion probe budget is fixed and isolated from production preparation and workflow caps", () => {
  const probe = fs.readFileSync("scripts/probe-npm-wait.mjs", "utf8");
  const production = fs.readFileSync("scripts/prerelease.mjs", "utf8");
  const workflow = fs.readFileSync(".github/workflows/npm-wait-probe.yml", "utf8");
  assert.match(probe, /const TIMEOUT = 600000,/);
  assert.equal((probe.match(/\b600000\b/g) ?? []).length, 1);
  assert.match(probe, /measurementBudgetMs: TIMEOUT,/);
  assert.match(probe, /timeout: TIMEOUT,/);
  assert.match(production, /timeout: 180000,/);
  assert.doesNotMatch(production, /600000/);
  assert.match(workflow, /timeout-minutes: 25/);
  assert.doesNotMatch(workflow, /600000|measurementBudgetMs/);
  assert.doesNotMatch(
    probe,
    /process\.env\.(?:TIMEOUT|MEASUREMENT_BUDGET)|--(?:timeout|measurement-budget)/
  );
});
