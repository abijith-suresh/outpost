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

test("preparation diagnostics preserve real child failure and redact all child output", async () => {
  const { preparationPhase } = await import("./prerelease-diagnostics.mjs");
  const records = [];
  let actual;
  assert.throws(
    () =>
      preparationPhase(
        "snapshot-install",
        () => {
          try {
            execFileSync(
              process.execPath,
              [
                "-e",
                "process.stdout.write('PRIVATE_URI_CONFIG');process.stderr.write('PRIVATE_CREDENTIAL');process.exit(23)",
              ],
              {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "pipe"],
                timeout: 2000,
              }
            );
          } catch (error) {
            actual = error;
            throw error;
          }
        },
        (record) => records.push(record)
      ),
    (error) => error === actual && error.status === 23
  );
  assert.deepEqual(records, [
    { preparation: 1, phase: "snapshot-install", outcome: "start" },
    {
      preparation: 1,
      phase: "snapshot-install",
      outcome: "failure",
      causes: ["child-exit-nonzero"],
    },
  ]);
  assert.doesNotMatch(JSON.stringify(records), /PRIVATE|stdout|stderr|message|stack|args/);
});

test("diagnostic async failures and bounded cause chains preserve exact error identity", async () => {
  const { preparationPhase, safePreparationCauses } = await import("./prerelease-diagnostics.mjs");
  const child = Object.assign(new Error("PRIVATE_CHILD"), { code: "ETIMEDOUT", stderr: "PRIVATE" });
  const error = new Error(
    "Prerelease preparation failed; its partial artifact directory was removed.",
    { cause: child }
  );
  const records = [];
  await assert.rejects(
    preparationPhase(
      "lifecycle-manager",
      async () => {
        throw error;
      },
      (r) => records.push(r)
    ),
    (observed) => observed === error
  );
  assert.deepEqual(records.at(-1).causes, ["preparation-wrapper", "child-timeout"]);
  child.cause = child;
  assert.deepEqual(safePreparationCauses(error), ["preparation-wrapper", "child-timeout"]);
  let deep = new Error("PRIVATE");
  for (let i = 0; i < 20; i++) deep = new Error("PRIVATE", { cause: deep });
  assert.equal(safePreparationCauses(deep).length, 4);
  assert.doesNotMatch(JSON.stringify(records), /PRIVATE/);
});

test("diagnostic sink failures cannot change success, failure or safe label bounds", async () => {
  const { preparationPhase, preparationDiagnostic } = await import("./prerelease-diagnostics.mjs");
  const sink = () => {
    throw new Error("PRIVATE_LOG_FAILURE");
  };
  const result = {};
  assert.equal(
    preparationPhase("bundle-verify", () => result, sink),
    result
  );
  const failure = new Error("PRIVATE_ORIGINAL");
  assert.throws(
    () =>
      preparationPhase(
        "owned-cleanup",
        () => {
          throw failure;
        },
        sink
      ),
    (e) => e === failure
  );
  await assert.rejects(
    preparationPhase(
      "source-finalizer",
      async () => {
        throw failure;
      },
      sink
    ),
    (e) => e === failure
  );
  const records = [];
  preparationDiagnostic("PRIVATE_PHASE", "PRIVATE_OUTCOME", failure, (r) => records.push(r));
  assert.deepEqual(records, [{ preparation: 1, phase: "unknown", outcome: "unknown" }]);
});

test("real archive checksum refusal emits safe phase while retaining nonzero failure", async () =>
  scope((dir) => {
    fixture(dir);
    writeFileSync(join(dir, "candidate.tgz"), "PRIVATE_ARCHIVE_BYTES");
    const script = `import { verifyPrepared } from ${JSON.stringify(new URL("./prerelease.mjs", import.meta.url).href)};
      try { verifyPrepared(${JSON.stringify(dir)}); } catch { process.exitCode = 23; }`;
    let failure;
    try {
      execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 2000,
      });
    } catch (error) {
      failure = error;
    }
    assert.equal(failure.status, 23);
    const records = failure.stderr
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(records, [
      { preparation: 1, phase: "bundle-verify", outcome: "start" },
      {
        preparation: 1,
        phase: "bundle-verify",
        outcome: "failure",
        causes: ["archive-checksum-refused"],
      },
    ]);
    assert.doesNotMatch(failure.stderr, /PRIVATE|stdout|stderr|message|stack/);
    assert.equal(readFileSync(join(dir, "candidate.tgz"), "utf8"), "PRIVATE_ARCHIVE_BYTES");
  }));

test("npm progress retains real timing forms but excludes arbitrary keys and hostile log data", async () =>
  scope(async (dir) => {
    const { summarizeNpmInstallLogs } = await import("./npm-install-diagnostics.mjs");
    writeFileSync(
      join(dir, "npm-debug.log"),
      [
        "12 timing idealTree Completed in 91ms",
        "13 timing reify:unpack Completed in 11887ms",
        "14 timing reify:unpack Completed in 2ms",
        "15 timing command:ci Completed in 12209ms",
        "16 http cache https://PRIVATE_URI_TOKEN.example/private 0ms (cache hit)",
        "17 http fetch GET 200 https://PRIVATE_CREDENTIAL.example/hidden 1ms (cache miss)",
        "18 timing PRIVATE_TIMING_KEY Completed in 99ms",
        "19 timing reify Completed in 9999999999999999999999ms",
        "20 verbose config PRIVATE_ENV_VALUE",
        "21 error code ETIMEDOUT",
        "22 timing reify Completed in 5ms PRIVATE_TRAILER",
        "",
      ].join("\n")
    );
    const summary = summarizeNpmInstallLogs(dir);
    assert.equal(summary.outcome, "observed");
    assert.equal(summary.commandTimingObserved, true);
    assert.deepEqual(summary.timings, [
      { phase: "idealTree", count: 1, maxMs: 91 },
      { phase: "reify:unpack", count: 2, maxMs: 11887 },
      { phase: "command:ci", count: 1, maxMs: 12209 },
    ]);
    assert.equal(summary.cacheHits, 1);
    assert.equal(summary.cacheMisses, 1);
    assert.equal(summary.httpFetches, 1);
    assert.equal(summary.networkErrorTokens, 1);
    assert.doesNotMatch(JSON.stringify(summary), /PRIVATE|https|config|credential|\.log/);
  }));

test("npm progress bounds missing, oversized, truncated and excessive log evidence", async () =>
  scope(async (dir) => {
    const { summarizeNpmInstallLogs } = await import("./npm-install-diagnostics.mjs");
    assert.equal(summarizeNpmInstallLogs(join(dir, "missing")).outcome, "incomplete");
    assert.equal(summarizeNpmInstallLogs(dir).outcome, "unknown");
    writeFileSync(
      join(dir, "oversized.log"),
      `1 timing idealTree Completed in 1ms\n${"x".repeat(300 * 1024)}`
    );
    let summary = summarizeNpmInstallLogs(dir);
    assert.equal(summary.outcome, "incomplete");
    assert.equal(summary.truncated, true);
    assert.deepEqual(summary.timings, [{ phase: "idealTree", count: 1, maxMs: 1 }]);
    rmSync(join(dir, "oversized.log"));
    writeFileSync(join(dir, "truncated.log"), "1 timing command:ci Completed in 2ms");
    summary = summarizeNpmInstallLogs(dir);
    assert.equal(summary.outcome, "incomplete");
    assert.equal(summary.commandTimingObserved, false);
    rmSync(join(dir, "truncated.log"));
    for (let i = 0; i < 20; i++)
      writeFileSync(join(dir, `${i}.log`), "1 timing idealTree Completed in 1ms\n");
    summary = summarizeNpmInstallLogs(dir);
    assert.equal(summary.outcome, "incomplete");
    assert.ok(summary.filesRead <= 8);
    assert.ok(summary.linesRead <= 16384);
  }));

test("npm progress parsing cannot follow linked logs", async () =>
  scope(async (dir) => {
    if (process.platform === "win32") return;
    const { summarizeNpmInstallLogs } = await import("./npm-install-diagnostics.mjs");
    writeFileSync(join(dir, "private"), "1 timing command:ci Completed in 2ms\n");
    symlinkSync(join(dir, "private"), join(dir, "linked.log"));
    const summary = summarizeNpmInstallLogs(dir);
    assert.equal(summary.outcome, "incomplete");
    assert.equal(summary.filesRead, 0);
    assert.equal(summary.commandTimingObserved, false);
  }));

test("npm diagnostic setup/read/sink failures never change exact operation outcomes", async () =>
  scope(async (dir) => {
    const { withNpmInstallDiagnostics } = await import("./npm-install-diagnostics.mjs");
    const missingParent = join(dir, "absent");
    const value = {};
    const summaries = [];
    assert.equal(
      withNpmInstallDiagnostics(
        missingParent,
        (args) => {
          assert.deepEqual(args, []);
          return value;
        },
        (s) => summaries.push(s)
      ),
      value
    );
    assert.equal(summaries[0].outcome, "unknown");
    const failure = new Error("PRIVATE_ORIGINAL");
    assert.throws(
      () =>
        withNpmInstallDiagnostics(
          dir,
          (args) => {
            assert.deepEqual(args.slice(0, 2), ["--timing", "--logs-dir"]);
            rmSync(args[2], { recursive: true });
            throw failure;
          },
          () => {
            throw new Error("PRIVATE_SINK");
          }
        ),
      (e) => e === failure
    );
    assert.equal(
      withNpmInstallDiagnostics(
        dir,
        (args) => {
          rmSync(args[2], { recursive: true });
          return value;
        },
        (s) => summaries.push(s)
      ),
      value
    );
    assert.equal(summaries.at(-1).outcome, "incomplete");
  }));

test("npm diagnostic summary precedes cleanup and preserves actual child timeout and exit", async () =>
  scope(async (dir) => {
    const { withNpmInstallDiagnostics } = await import("./npm-install-diagnostics.mjs");
    for (const mode of ["timeout", "exit"]) {
      const parent = join(dir, mode);
      mkdirSync(parent);
      let actual,
        summarized = false;
      assert.throws(
        () => {
          try {
            withNpmInstallDiagnostics(
              parent,
              (args) => {
                writeFileSync(join(args[2], "npm.log"), "1 timing idealTree Completed in 1ms\n");
                try {
                  execFileSync(
                    process.execPath,
                    [
                      "-e",
                      mode === "timeout"
                        ? "process.stderr.write('PRIVATE_CHILD');setTimeout(()=>{},10000)"
                        : "process.stderr.write('PRIVATE_CHILD');process.exit(23)",
                    ],
                    {
                      encoding: "utf8",
                      stdio: ["ignore", "pipe", "pipe"],
                      timeout: mode === "timeout" ? 100 : 2000,
                    }
                  );
                } catch (e) {
                  actual = e;
                  throw e;
                }
              },
              (s) => {
                summarized = true;
                assert.equal(s.outcome, "observed");
              }
            );
          } finally {
            assert.equal(summarized, true);
            rmSync(parent, { recursive: true });
          }
        },
        (e) => e === actual && (mode === "timeout" ? e.code === "ETIMEDOUT" : e.status === 23)
      );
    }
  }));

test("actual pinned npm ci emits bounded timing evidence with scripts still disabled", async () =>
  scope(async (dir) => {
    const { withNpmInstallDiagnostics } = await import("./npm-install-diagnostics.mjs");
    const { runNpm } = await import("./npm-command.mjs");
    const consumer = join(dir, "consumer");
    mkdirSync(consumer);
    const metadata = {
      name: "outpost-npm-diagnostic-fixture",
      version: "0.0.0",
      private: true,
      scripts: { prepare: "node -e \"require('fs').writeFileSync('SCRIPT_EXECUTED','bad')\"" },
    };
    writeFileSync(join(consumer, "package.json"), JSON.stringify(metadata));
    writeFileSync(
      join(consumer, "package-lock.json"),
      JSON.stringify({
        name: metadata.name,
        version: metadata.version,
        lockfileVersion: 3,
        requires: true,
        packages: { "": { name: metadata.name, version: metadata.version } },
      })
    );
    const summaries = [];
    withNpmInstallDiagnostics(
      dir,
      (args) =>
        runNpm(["ci", "--ignore-scripts", "--no-audit", "--no-fund", ...args], {
          cwd: consumer,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 10000,
          maxBuffer: 1024 * 1024,
        }),
      (s) => summaries.push(s)
    );
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].outcome, "observed");
    assert.equal(summaries[0].commandTimingObserved, true);
    assert.throws(() => readFileSync(join(consumer, "SCRIPT_EXECUTED")), { code: "ENOENT" });
  }));

test("npm LF and CRLF grammar produce equivalent fixed progress observations", async () =>
  scope(async (dir) => {
    const { summarizeNpmInstallLogs } = await import("./npm-install-diagnostics.mjs");
    // Pinned npm11.16 log-file.js uses os.EOL and formatWithOptions numeric/level/title prefixes.
    const rows = [
      "1 timing idealTree Completed in 91ms",
      "2 timing reify:unpack Completed in 11887ms",
      "3 http cache https://PRIVATE.example/hidden 1ms (cache hit)",
      "4 http fetch GET 200 https://PRIVATE.example/hidden 1ms (cache miss)",
      "5 error code ETIMEDOUT",
      "6 silly idealTree buildDeps",
      "7 silly fetch manifest PRIVATE_SPECIFIER",
      "8 silly reify moves { PRIVATE_PATH: 'PRIVATE' }",
      "9 verbose reify failed optional dependency PRIVATE_PATH",
      "10 silly tarball no local data for PRIVATE_URI. Extracting by manifest.",
      "11 silly unfinished npm timer reify 1793910000000",
      "12 timing PRIVATE_PHASE Completed in 1ms",
      "13 timing reify unsupported PRIVATE_GRAMMAR",
      "PRIVATE_CONTINUATION",
      "",
    ];
    const results = [];
    for (const eol of ["\n", "\r\n"]) {
      const selected = join(dir, eol === "\n" ? "lf" : "crlf");
      mkdirSync(selected);
      writeFileSync(join(selected, "fixture.log"), rows.join(eol));
      results.push(summarizeNpmInstallLogs(selected));
    }
    const withoutEol = ({ lineEndings: _lineEndings, ...summary }) => summary;
    assert.deepEqual(withoutEol(results[0]), withoutEol(results[1]));
    assert.doesNotMatch(JSON.stringify(results), /PRIVATE|https|unsupported/);
  }));

test("npm format summary distinguishes unknown timing forms and progress without claiming completion", async () =>
  scope(async (dir) => {
    const { summarizeNpmInstallLogs } = await import("./npm-install-diagnostics.mjs");
    writeFileSync(
      join(dir, "fixture.log"),
      [
        "1 silly idealTree buildDeps\r\n",
        "2 timing PRIVATE_PHASE Completed in 1ms\r\n",
        "3 silly reify moves PRIVATE_PATH\r\n",
        "4 verbose PRIVATE\rembedded\r\n",
        "PRIVATE_UNFRAMED\r\n",
      ].join("")
    );
    const result = summarizeNpmInstallLogs(dir);
    assert.deepEqual(result.lineEndings, { lf: false, crlf: true, embeddedCR: true });
    assert.equal(result.logLevels.timing, 1);
    assert.equal(result.unrecognizedTimingRecords, 1);
    assert.equal(result.unknownRecordLines, 1);
    assert.equal(result.progress.reifyMovesRecords, 1);
    assert.equal(result.progress.idealTreeBuildDepsRecords, 1);
    assert.equal(result.commandTimingObserved, false);
    assert.deepEqual(result.timings, []);
    assert.equal(
      Object.values(result.logLevels).reduce((a, b) => a + b, 0) + result.unknownRecordLines,
      result.linesRead
    );
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|embedded\\r/);
  }));

test("npm pinned reify/build forms use only fixed phases and two bounded location buckets", async () =>
  scope(async (dir) => {
    const { summarizeNpmInstallLogs } = await import("./npm-install-diagnostics.mjs");
    // Pinned npm11.16 Arborist reify.js/rebuild.js time.start names, serialized by npm's formatter.
    const fixed = [
      "reify:diffTrees",
      "reify:retireShallow",
      "reify:createSparse",
      "reify:loadShrinkwraps",
      "reify:loadBundles",
      "reify:audit",
      "reify:unretire",
      "reify:trash",
      "build",
      "build:deps",
      "build:links",
      "build:queue",
      "build:link",
    ];
    const keys = [
      ...fixed,
      "reifyNode:node_modules/@PRIVATE_SCOPE/PRIVATE_NAME9",
      "reifyNode:PRIVATE_FOLDER/other",
      "build:link:node_modules/PRIVATE_BINARY",
      "PRIVATE_UNKNOWN_KEY",
      "reifyNode:",
      "build:link:",
      `reifyNode:${"PRIVATE".repeat(100)}`,
      "reifyNode:PRIVATE\u0000CONTROL",
      "build:link:PRIVATE\tCONTROL",
      "reifyNode:PRIVATE\rCONTROL",
      "reifyNode:PRIVATE\nNEWLINE",
      "build:link:PRIVATE\u007fCONTROL",
    ];
    const results = [];
    for (const eol of ["\n", "\r\n"]) {
      const selected = join(dir, eol === "\n" ? "lf" : "crlf");
      mkdirSync(selected);
      writeFileSync(
        join(selected, "fixture.log"),
        keys.map((key, i) => `${i} timing ${key} Completed in ${i + 1}ms${eol}`).join("")
      );
      const result = summarizeNpmInstallLogs(selected);
      assert.deepEqual(
        result.timings
          .filter((t) => fixed.includes(t.phase))
          .map((t) => t.phase)
          .sort(),
        [...fixed].sort()
      );
      assert.deepEqual(
        result.timings.filter((t) => t.phase.endsWith(":bucket")),
        [
          { phase: "reifyNode:bucket", count: 2, maxMs: 15 },
          { phase: "build:link:bucket", count: 1, maxMs: 16 },
        ]
      );
      assert.ok(result.unrecognizedTimingRecords > 0);
      assert.equal(result.commandTimingObserved, false);
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE|node_modules|CONTROL|NEWLINE/);
      assert.equal(Object.hasOwn(result, "lastCompletion"), false);
      results.push(result);
    }
    const withoutEol = ({ lineEndings: _lineEndings, ...rest }) => rest;
    assert.deepEqual(withoutEol(results[0]), withoutEol(results[1]));
  }));

test("npm bucket suffix limits and rotation aggregation never expose names or invent ordering", async () =>
  scope(async (dir) => {
    const { summarizeNpmInstallLogs } = await import("./npm-install-diagnostics.mjs");
    writeFileSync(
      join(dir, "later.log"),
      `8 timing reifyNode:${"x".repeat(512)} Completed in 23ms\r\n9 timing build:link:PRIVATE Completed in 7ms\r\n`
    );
    writeFileSync(
      join(dir, "earlier.log"),
      `1 timing reifyNode:${"x".repeat(513)} Completed in 999ms\n2 timing reifyNode:PRIVATE Completed in 4ms\n`
    );
    const result = summarizeNpmInstallLogs(dir);
    assert.deepEqual(result.timings, [
      { phase: "reifyNode:bucket", count: 2, maxMs: 23 },
      { phase: "build:link:bucket", count: 1, maxMs: 7 },
    ]);
    assert.equal(result.unrecognizedTimingRecords, 1);
    assert.equal(result.lineEndings.lf, true);
    assert.equal(result.lineEndings.crlf, true);
    assert.doesNotMatch(
      JSON.stringify(result),
      /PRIVATE|xxxxx|earlier|later|last|location|package/
    );
  }));
