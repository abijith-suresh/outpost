import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  installPrepared,
  preparePrerelease,
  snapshotCommit,
  sourceFingerprint,
  validateDispatch,
  validateManifest,
  verifyInstalledContents,
  verifyPrepared,
} from "./prerelease.mjs";
import { makeBuildIdentity } from "./prerelease-identity.mjs";

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const build = makeBuildIdentity({
  sourceSha: "a".repeat(40),
  sourceVersion: "0.0.26",
  channel: "dev",
  date: "20261028",
  runId: "12",
  attempt: "1",
});
const cohort = {
  "@effect/platform-node": "4.0.6",
  "@effect/platform-node-shared": "4.0.6",
  effect: "4.0.6",
};
const runtime = Object.fromEntries(
  Object.keys(cohort).map((name) => [
    `node_modules/${name}`,
    {
      version: "4.0.6",
      resolved: `https://registry.npmjs.org/${name}/-/test-4.0.6.tgz`,
      integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
    },
  ])
);
const scope = async (callback) => {
  const directory = mkdtempSync(join(tmpdir(), "outpost candidate guards é "));
  try {
    await callback(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};
function fixture(directory) {
  const bytes = Buffer.from("bounded test archive");
  const metadata = Buffer.from(
    JSON.stringify({
      name: "@abijith-suresh/outpost",
      version: build.version,
      private: true,
      outpostBuild: build,
      dependencies: cohort,
    })
  );
  const manifest = {
    schemaVersion: 1,
    build,
    tag: "dev",
    publication: "disabled",
    requirements: { node: ">=24.19.0 <25", npm: "11.16.0" },
    runtime,
    packages: [
      {
        name: "@abijith-suresh/outpost",
        version: build.version,
        filename: "candidate.tgz",
        sha256: sha256(bytes),
        integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
        files: [{ path: "package.json", size: metadata.length, sha256: sha256(metadata) }],
      },
    ],
  };
  const encoded = JSON.stringify(manifest);
  writeFileSync(join(directory, "manifest.json"), encoded);
  writeFileSync(join(directory, "candidate.tgz"), bytes);
  writeFileSync(
    join(directory, "SHA256SUMS"),
    `${sha256(bytes)}  candidate.tgz\n${sha256(encoded)}  manifest.json\n`
  );
  return { manifest, metadata };
}
test("manual dispatch is trusted main only and publication requests fail before output", async () => {
  const context = {
    identity: build,
    eventName: "workflow_dispatch",
    repository: "abijith-suresh/outpost",
    ref: "refs/heads/main",
    sourceSha: build.sourceSha,
    checkedOutSha: build.sourceSha,
    publishRequested: false,
  };
  assert.deepEqual(validateDispatch(context), build);
  for (const patch of [
    { eventName: "push" },
    { repository: "fork/outpost" },
    { ref: "refs/heads/topic" },
    { checkedOutSha: "b".repeat(40) },
    ...[true, "true", "yes", 1].map((publishRequested) => ({ publishRequested })),
  ])
    assert.throws(() => validateDispatch({ ...context, ...patch }));
  await scope(async (dir) => {
    await assert.rejects(
      preparePrerelease(dir, join(dir, "absent"), build, { publish: true }),
      /Publication is disabled/
    );
    assert.deepEqual(readdirSync(dir), []);
  });
});
test("bounded manifest and hashes reject tampering before install/tool execution", async () =>
  scope((dir) => {
    const { manifest } = fixture(dir);
    assert.deepEqual(verifyPrepared(dir), manifest);
    assert.throws(
      () => installPrepared(dir, join(dir, "absent"), "b".repeat(40)),
      /approved source SHA/
    );
    for (const patch of [
      { publication: "enabled" },
      { packages: [...manifest.packages, manifest.packages[0]] },
      {
        runtime: {
          ...runtime,
          "node_modules/effect": { ...runtime["node_modules/effect"], version: "4.0.7" },
        },
      },
      {
        runtime: {
          ...runtime,
          "node_modules/effect": {
            ...runtime["node_modules/effect"],
            resolved: "https://other.invalid/effect.tgz",
          },
        },
      },
      { unknown: true },
    ])
      assert.throws(() => validateManifest({ ...manifest, ...patch }));
    for (const path of [
      "../outside",
      "dist/../escape",
      "dist/link\\file",
      "dist/:drive",
      "dist/\u0000",
      "unexpected/file",
    ])
      assert.throws(() =>
        validateManifest({
          ...manifest,
          packages: [
            { ...manifest.packages[0], files: [{ path, size: 0, sha256: "a".repeat(64) }] },
          ],
        })
      );
    writeFileSync(join(dir, "candidate.tgz"), "changed");
    assert.throws(() => installPrepared(dir, join(dir, "absent"), build.sourceSha), /checksum/);
    assert.equal(readdirSync(dir).includes("absent"), false);
  }));
test("installed per-file hashes, exact graph and symlink refusal precede execution", async () =>
  scope((dir) => {
    const { manifest, metadata } = fixture(dir);
    const home = join(dir, "node_modules/@abijith-suresh/outpost"),
      effect = join(dir, "node_modules/effect");
    mkdirSync(home, { recursive: true });
    mkdirSync(effect);
    writeFileSync(join(home, "package.json"), metadata);
    writeFileSync(
      join(effect, "package.json"),
      JSON.stringify({ name: "effect", version: "4.0.6" })
    );
    writeFileSync(
      join(dir, "package-lock.json"),
      JSON.stringify({ packages: { "node_modules/effect": runtime } })
    );
    writeFileSync(join(home, "package.json"), Buffer.concat([metadata, Buffer.from(" ")]));
    assert.throws(() => verifyInstalledContents(dir, manifest), /content verification/);
    writeFileSync(join(home, "package.json"), metadata);
    if (process.platform !== "win32") {
      rmSync(join(dir, "candidate.tgz"));
      symlinkSync(join(dir, "manifest.json"), join(dir, "candidate.tgz"));
      assert.throws(() => verifyPrepared(dir));
    }
  }));
test("Git object snapshot uses committed exact bytes without moving or changing dirty source", async () =>
  scope((dir) => {
    const source = join(dir, "source"),
      snapshot = join(dir, "snapshot");
    mkdirSync(source);
    mkdirSync(snapshot);
    const git = (args) =>
      execFileSync("git", args, {
        cwd: source,
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      });
    git(["init", "--quiet"]);
    writeFileSync(join(source, "tracked é.txt"), "committed exact\r\n");
    git(["-c", "core.autocrlf=false", "add", "."]);
    git([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "fixture",
    ]);
    const head = git(["rev-parse", "HEAD"]).trim();
    writeFileSync(join(source, "tracked é.txt"), "uncommitted");
    writeFileSync(join(source, "untracked"), "keep");
    const before = git(["status", "--porcelain=v1", "-z"]);
    const sourceTree = () => {
      const result = [];
      const walk = (path) => {
        const stat = lstatSync(path, { bigint: true });
        if (stat.isDirectory()) for (const name of readdirSync(path).sort()) walk(join(path, name));
        else
          result.push([
            path,
            String(stat.dev),
            String(stat.ino),
            String(stat.mtimeNs),
            sha256(readFileSync(path)),
          ]);
      };
      walk(source);
      return result;
    };
    const identities = sourceTree();
    snapshotCommit(source, snapshot, head);
    assert.equal(readFileSync(join(snapshot, "tracked é.txt"), "utf8"), "committed exact\r\n");
    assert.deepEqual(readdirSync(snapshot), ["tracked é.txt"]);
    assert.equal(git(["status", "--porcelain=v1", "-z"]), before);
    assert.equal(readFileSync(join(source, "tracked é.txt"), "utf8"), "uncommitted");
    assert.equal(readFileSync(join(source, "untracked"), "utf8"), "keep");
    assert.equal(git(["rev-parse", "HEAD"]).trim(), head);
    assert.deepEqual(
      sourceTree(),
      identities,
      "source files, index, refs, reflogs and objects preserve bytes, mtimes and identities"
    );
  }));
test("manual workflow has read-only permissions and canonical transfer, no publisher", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/prepare-prerelease.yml", import.meta.url),
    "utf8"
  );
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /\n {2}(push|pull_request|schedule):/);
  assert.match(workflow, /contents: read/);
  assert.doesNotMatch(
    workflow,
    /(?:id-token:|packages:|contents:) write|secrets\.|npm (publish|login)|gh release|version-packages/
  );
  assert.match(workflow, /Download the canonical Linux bytes without rebuilding the candidate/);
  assert.match(workflow, /npm\.cmd run check:prerelease/);
});

test("candidate identity rejects ambiguous, invalid dates and noncanonical run coordinates", () => {
  for (const patch of [
    { channel: "latest" },
    { channel: "beta" },
    { date: "20260230" },
    { date: "2026115" },
    { runId: "01" },
    { attempt: "0" },
    { runId: "9007199254740992" },
    { version: "0.0.26" },
    { sourceSha: "HEAD" },
    { sourceVersion: "0.0.26-dev" },
    { extra: true },
  ])
    assert.throws(() => makeBuildIdentity({ ...build, ...patch }));
});

test("source fingerprint never invokes clean/process filters or fsmonitor and detects dirty byte changes", async () =>
  scope((dir) => {
    const source = join(dir, "source");
    mkdirSync(source);
    const git = (...args) =>
      execFileSync("git", args, {
        cwd: source,
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      });
    git("init", "--quiet");
    writeFileSync(join(source, ".gitattributes"), "tracked.txt filter=probe\n");
    writeFileSync(join(source, "tracked.txt"), "committed\n");
    git("add", ".");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "fixture"
    );
    const marker = join(dir, "invoked");
    const helper = join(dir, "probe.cjs");
    writeFileSync(
      helper,
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'invoked'); process.stdin.pipe(process.stdout);`
    );
    const command = `node "${helper.replaceAll("\\", "/")}"`;
    git("update-index", "--split-index");
    const sharedIndex = git("rev-parse", "--shared-index-path").trim();
    assert.ok(sharedIndex, "fixture must have an actual shared index");
    git("config", "filter.probe.clean", command);
    writeFileSync(join(source, "tracked.txt"), "dirty bytes of different size\n");
    // Reproduce the old inspection's side effect without claiming it is harmless.
    git("diff", "--no-ext-diff", "--no-textconv", "--binary", "HEAD", "--");
    assert.equal(readFileSync(marker, "utf8"), "invoked");
    rmSync(marker);
    git("config", "filter.probe.process", command);
    git("config", "core.fsmonitor", command);
    const tree = () => {
      const result = [];
      const walk = (path) => {
        const stat = lstatSync(path, { bigint: true });
        result.push([
          path,
          String(stat.dev),
          String(stat.ino),
          String(stat.mtimeNs),
          stat.isFile() ? sha256(readFileSync(path)) : "directory",
        ]);
        if (stat.isDirectory()) for (const name of readdirSync(path).sort()) walk(join(path, name));
      };
      walk(source);
      return result;
    };
    const before = tree();
    const fingerprint = sourceFingerprint(source);
    assert.equal(sourceFingerprint(source), fingerprint);
    assert.deepEqual(
      tree(),
      before,
      "source/index/refs/reflogs/objects stay byte/identity/mtime exact"
    );
    assert.throws(() => readFileSync(marker), { code: "ENOENT" });
    utimesSync(join(source, sharedIndex), new Date(), new Date(Date.now() + 10000));
    assert.notEqual(
      sourceFingerprint(source),
      fingerprint,
      "shared-index mtime changes must be detected"
    );
    writeFileSync(join(source, "tracked.txt"), "another dirty value\n");
    assert.notEqual(sourceFingerprint(source), fingerprint);
    writeFileSync(join(source, "untracked.txt"), "untracked source\n");
    const withUntracked = sourceFingerprint(source);
    writeFileSync(join(source, "untracked.txt"), "changed untracked source\n");
    assert.notEqual(sourceFingerprint(source), withUntracked);
    assert.throws(() => readFileSync(marker), { code: "ENOENT" });
  }));

test("missing promisor source objects refuse before transport and preserve split-index storage", async () =>
  scope((dir) => {
    const source = join(dir, "source");
    const snapshot = join(dir, "snapshot");
    mkdirSync(source);
    mkdirSync(snapshot);
    const git = (...args) =>
      execFileSync("git", args, {
        cwd: source,
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      });
    git("init", "--quiet");
    writeFileSync(join(source, "tracked.txt"), "source object\n");
    git("add", ".");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "fixture"
    );
    const head = git("rev-parse", "HEAD").trim();
    const blob = git("rev-parse", "HEAD:tracked.txt").trim();
    git("update-index", "--split-index");
    const marker = join(dir, "transport-invoked");
    const helper = join(dir, "transport.cjs");
    writeFileSync(
      helper,
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'invoked'); process.exit(1);`
    );
    git("config", "core.sshCommand", `node "${helper.replaceAll("\\", "/")}"`);
    git("config", "remote.origin.url", "ssh://invalid.example/absent");
    git("config", "remote.origin.promisor", "true");
    rmSync(join(source, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
    const tree = () => {
      const result = [];
      const walk = (path) => {
        const stat = lstatSync(path, { bigint: true });
        result.push([
          path,
          String(stat.dev),
          String(stat.ino),
          String(stat.mtimeNs),
          stat.isFile() ? sha256(readFileSync(path)) : "directory",
        ]);
        if (stat.isDirectory()) for (const name of readdirSync(path).sort()) walk(join(path, name));
      };
      walk(source);
      return result;
    };
    const before = tree();
    assert.throws(() => snapshotCommit(source, snapshot, head), /Partial-clone\/promisor/);
    assert.throws(() => sourceFingerprint(source), /Partial-clone\/promisor/);
    assert.deepEqual(readdirSync(snapshot), []);
    assert.deepEqual(tree(), before);
    assert.throws(() => readFileSync(marker), { code: "ENOENT" });
    git("config", "--unset", "remote.origin.promisor");
    const withoutPromisor = tree();
    assert.throws(() => snapshotCommit(source, snapshot, head), /Source snapshot/);
    assert.deepEqual(tree(), withoutPromisor);
    assert.throws(() => readFileSync(marker), { code: "ENOENT" });
  }));
