import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import observer from "./npm-wait-observer.cjs";
import { parentPreflight } from "./npm-wait-preflight.mjs";
import { locateNpm } from "./probe-npm-wait.mjs";

const require = createRequire(import.meta.url);
const entry = process.env.npm_execpath;
const installed = observer.verifyPinnedNpm(entry);
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "outpost-preflight-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const name of ["package.json", ...Object.keys(observer.PINNED)]) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.copyFileSync(path.join(installed.root, name), file);
  }
  return dir;
}
function capture(operation) {
  const records = [];
  let value, error;
  try {
    value = parentPreflight(1, (v) => records.push(v), operation);
  } catch (e) {
    error = e;
  }
  assert.equal(records.length, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(records[0])) <= 8192);
  return { value, error, record: records[0] };
}
function privateAbsent(record) {
  assert.doesNotMatch(
    JSON.stringify(record),
    /PRIVATE|[\\/]|11\.16|24\.22|npm-cli|sha256|Error|stack|package\.json/
  );
}

test("positive preflight records only fixed matches/IDs; actual source and method hashes remain required", () => {
  const { value, error, record } = capture((trace) => observer.verifyPinnedNpm(entry, trace));
  assert.equal(error, undefined);
  assert.equal(value.entry, installed.entry);
  assert.equal(record.nodeMatch, true);
  assert.equal(record.selectedNpmVersionMatch, true);
  assert.ok(record.files.every((r) => r.state === "match" && r.hashMatch));
  assert.ok(record.hooks.every((r) => r.state === "unreached"));
  privateAbsent(record);
  const records = [];
  const active = parentPreflight(
    2,
    (r) => records.push(r),
    (trace) => observer.attachPinnedNpmObserver(entry, {}, trace)
  );
  active.stop();
  assert.equal(records.length, 1);
  assert.ok(records[0].hooks.every((r) => r.state === "match" && r.hashMatch));
  assert.equal(records[0].attachment, "match");
  privateAbsent(records[0]);
});

test("wrong/hostile version, invalid/oversized metadata refuse with no later file or hook work", (t) => {
  for (const content of [
    JSON.stringify({ version: "PRIVATE_VERSION_URI_CREDENTIAL" }),
    "{PRIVATE",
    "x".repeat(65537),
  ]) {
    const dir = fixture(t);
    fs.writeFileSync(path.join(dir, "package.json"), content);
    const { error, record } = capture((trace) =>
      observer.verifyPinnedNpm(path.join(dir, "bin/npm-cli.js"), trace)
    );
    assert.equal(error.code, "INVALID_NPM_WAIT_PROBE");
    assert.equal(error.reason, "pin-mismatch");
    assert.equal(record.selectedNpmVersionMatch, content.startsWith('{"version"') ? false : null);
    assert.ok(record.files.every((r) => r.state === "unreached"));
    assert.ok(record.hooks.every((r) => r.state === "unreached"));
    privateAbsent(record);
  }
});

test("layout refusal is fixed and fail-fast, no selected-version or file observations", (t) => {
  const dir = fixture(t);
  const renamed = path.join(dir, "bin/PRIVATE_ENTRY.js");
  fs.copyFileSync(path.join(dir, "bin/npm-cli.js"), renamed);
  const { error, record } = capture((trace) => observer.verifyPinnedNpm(renamed, trace));
  assert.equal(error.reason, "pin-mismatch");
  assert.equal(record.layout[2].match, false);
  assert.equal(record.layout[3].state, "unreached");
  assert.equal(record.selectedNpmVersionMatch, null);
  assert.ok(record.files.every((r) => r.state === "unreached"));
  privateAbsent(record);
  const absent = capture((trace) =>
    observer.verifyPinnedNpm(path.join(dir, "PRIVATE_MISSING"), trace)
  );
  assert.equal(absent.record.layout[1].state, "unavailable");
  privateAbsent(absent.record);
});

test("read/hash failures identify numeric first file and leave remaining files/hooks unreached", (t) => {
  for (const mode of ["missing", "oversized", "changed", "linked"]) {
    const dir = fixture(t);
    const file = path.join(dir, "lib/npm.js");
    if (mode === "missing") fs.unlinkSync(file);
    else if (mode === "oversized") fs.writeFileSync(file, "x".repeat(262145));
    else if (mode === "changed") fs.appendFileSync(file, "\nPRIVATE");
    else {
      fs.renameSync(file, `${file}.original`);
      fs.symlinkSync(`${file}.original`, file);
    }
    const { error, record } = capture((trace) =>
      observer.attachPinnedNpmObserver(path.join(dir, "bin/npm-cli.js"), {}, trace)
    );
    assert.equal(error.reason, "pin-mismatch");
    assert.equal(record.files[0].state, "match");
    assert.equal(record.files[1].state, mode === "changed" ? "hash-mismatch" : "read-refused");
    assert.ok(record.files.slice(2).every((r) => r.state === "unreached"));
    assert.equal(record.hookLoad, "unreached");
    assert.ok(record.hooks.every((r) => r.state === "unreached"));
    privateAbsent(record);
  }
});

test("hook shape/hash refusal is bounded and never reported as pin success alone", () => {
  const Arborist = require(path.join(installed.root, "node_modules/@npmcli/arborist"));
  const key = Symbol.for("reifyNode"),
    before = Object.getOwnPropertyDescriptor(Arborist.prototype, key);
  for (const replacement of [null, function PRIVATE_REPLACED() {}]) {
    Object.defineProperty(Arborist.prototype, key, { configurable: true, value: replacement });
    try {
      const { error, record } = capture((trace) =>
        observer.attachPinnedNpmObserver(entry, {}, trace)
      );
      assert.equal(error.reason, "hook-mismatch");
      assert.equal(
        record.hooks[0].state,
        replacement === null ? "shape-mismatch" : "hash-mismatch"
      );
      assert.ok(record.hooks.slice(1).every((r) => r.state === "unreached"));
      assert.equal(record.attachment, "unreached");
      privateAbsent(record);
    } finally {
      if (before) Object.defineProperty(Arborist.prototype, key, before);
      else delete Arborist.prototype[key];
    }
  }
});

test("observer callback, output sink and serialization faults preserve exact operation value/error", () => {
  const failure = new Error("PRIVATE_ORIGINAL");
  const value = {};
  assert.equal(
    parentPreflight(
      1,
      () => {
        throw Error("PRIVATE_SINK");
      },
      () => value
    ),
    value
  );
  assert.throws(
    () =>
      parentPreflight(
        2,
        () => {
          throw Error("PRIVATE_SINK");
        },
        () => {
          throw failure;
        }
      ),
    (e) => e === failure
  );
  assert.equal(
    observer.verifyPinnedNpm(entry, () => {
      throw failure;
    }).entry,
    installed.entry
  );
  const stringify = JSON.stringify;
  JSON.stringify = () => {
    throw failure;
  };
  try {
    assert.equal(
      parentPreflight(
        1,
        () => {},
        () => value
      ),
      value
    );
    assert.throws(
      () =>
        parentPreflight(
          1,
          () => {},
          () => {
            throw failure;
          }
        ),
      (e) => e === failure
    );
  } finally {
    JSON.stringify = stringify;
  }
  const record = capture((trace) => {
    trace("PRIVATE_KIND", 1, "PRIVATE_STATE", "PRIVATE_MATCH");
    return 7;
  }).record;
  privateAbsent(record);
});

test("parent CLI emits one bounded locator record then same fixed refusal with locator stage; no npm entry executes", (t) => {
  const dir = fixture(t);
  const command = path.join(dir, "npm.cmd");
  const result = spawnSync(
    process.execPath,
    [path.resolve("scripts/probe-npm-wait.mjs"), "--npm-command", command],
    { cwd: dir, timeout: 2000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
  assert.equal(result.status, 1);
  const records = result.stdout
    .trim()
    .split("\n")
    .map((s) => JSON.parse(s));
  assert.equal(records.length, 1);
  assert.equal(records[0].context, 1);
  privateAbsent(records[0]);
  assert.deepEqual(JSON.parse(result.stderr), {
    npmWaitProbeFailure: 1,
    category: "invalid-probe",
    stage: "locator",
  });
});

test("strict native-layout locator forwards existing checks without any fallback", (t) => {
  const dir = fixture(t);
  fs.mkdirSync(path.join(dir, "node_modules"), { recursive: true });
  fs.symlinkSync(
    installed.root,
    path.join(dir, "node_modules/npm"),
    process.platform === "win32" ? "junction" : "dir"
  );
  const { value, error, record } = capture((trace) => locateNpm(path.join(dir, "npm.cmd"), trace));
  assert.equal(error, undefined);
  assert.equal(value, installed.entry);
  assert.equal(record.selectedNpmVersionMatch, true);
  privateAbsent(record);
});

test("hook module load refusal follows successful source pins and leaves all hook rows unreached", (t) => {
  const dir = fixture(t);
  const { error, record } = capture((trace) =>
    observer.attachPinnedNpmObserver(path.join(dir, "bin/npm-cli.js"), {}, trace)
  );
  assert.equal(error.reason, "hook-mismatch");
  assert.ok(record.files.every((r) => r.state === "match"));
  assert.equal(record.hookLoad, "load-refused");
  assert.ok(record.hooks.every((r) => r.state === "unreached"));
  privateAbsent(record);
});

test("wrong Node emits only false exact-match, no unknown version or later lookup", () => {
  const observerFile = path.resolve("scripts/npm-wait-observer.cjs");
  const preflightFile = new URL("./npm-wait-preflight.mjs", import.meta.url).href;
  const code = `const {parentPreflight}=await import(${JSON.stringify(preflightFile)});const {createRequire}=await import('node:module');const o=createRequire(import.meta.url)(${JSON.stringify(observerFile)});Object.defineProperty(process.versions,'node',{value:'PRIVATE_UNKNOWN_NODE'});try{parentPreflight(1,r=>process.stdout.write(JSON.stringify(r)),trace=>o.verifyPinnedNpm(${JSON.stringify(entry)},trace));}catch(e){if(e.code!=='INVALID_NPM_WAIT_PROBE'||e.reason!=='pin-mismatch')process.exitCode=9;}`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    encoding: "utf8",
    timeout: 2000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(result.status, 0);
  const record = JSON.parse(result.stdout);
  assert.equal(record.nodeMatch, false);
  assert.equal(record.selectedNpmVersionMatch, null);
  assert.ok(record.layout.every((r) => r.state === "unreached"));
  assert.ok(record.files.every((r) => r.state === "unreached"));
  privateAbsent(record);
});
