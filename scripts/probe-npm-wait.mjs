import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import observer from "./npm-wait-observer.cjs";
import owned from "./npm-wait-owned.cjs";
import { parentPreflight } from "./npm-wait-preflight.mjs";
import { snapshotCommit, sourceFingerprint } from "./prerelease.mjs";
export const TARGET = Object.freeze({
  source: "0f3e0caf26b4e9a73f5c453eb59465dc1598041c",
  tree: "8223d25c42451377787f0b107380d4a07d41f635",
  lock: "4cd696c26a0aa4faf5e8878ce147e2c07306b01f7549d79243e7b18bab7583fc",
});
const TIMEOUT = 180000,
  MAX_BUFFER = 128 * 1024 * 1024;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const refusal = (category) =>
  Object.assign(new Error("Npm wait probe refused."), { probeCategory: category });
const safe = (sink, value) => {
  try {
    sink(value);
  } catch {
    /* Never replace child outcome. */
  }
};
export function locateNpm(command, trace) {
  if (!path.isAbsolute(command) || path.basename(command).toLowerCase() !== "npm.cmd")
    throw refusal("npm-locator");
  return observer.verifyPinnedNpm(
    path.join(path.dirname(command), "node_modules/npm/bin/npm-cli.js"),
    trace
  ).entry;
}
function git(root, args) {
  const env = {
    ...process.env,
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const key of Object.keys(process.env))
    if (
      /^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG|REPLACE_REF_BASE)(?:$|_)/.test(
        key
      )
    )
      throw refusal("git-environment");
  return execFileSync("git", ["-c", "core.fsmonitor=false", ...args], {
    cwd: root,
    env,
    timeout: 30000,
    maxBuffer: MAX_BUFFER,
    stdio: ["ignore", "pipe", "pipe"],
  });
}
export function validateSourceFiles(directory) {
  const lock = observer.readBounded(path.join(directory, "package-lock.json"), 16 * 1024 * 1024);
  const pkg = JSON.parse(observer.readBounded(path.join(directory, "package.json"), 65536));
  const cli = JSON.parse(
    observer.readBounded(path.join(directory, "apps/cli/package.json"), 65536)
  );
  const node = observer.readBounded(path.join(directory, ".node-version"), 64).toString().trim();
  if (
    hash(lock) !== TARGET.lock ||
    pkg.packageManager !== "npm@11.16.0" ||
    cli.version !== "0.0.26" ||
    node !== "24.22.1"
  )
    throw refusal("source-pins");
}
export function observeChild(executable, args, options, checkpoint, sink = () => {}) {
  let result, failure;
  const start = performance.now();
  try {
    result = execFileSync(executable, args, options);
  } catch (error) {
    failure = error;
  }
  const childDurationMs = Math.floor(performance.now() - start);
  const value = observer.readWaitCheckpoint(checkpoint);
  safe(sink, {
    npmWaitObservation: 1,
    currentCoverage: "unknown",
    observationOnly: true,
    childDurationMs,
    checkpointAgeUpperBoundMs: value.valid ? childDurationMs : null,
    checkpoint: value,
  });
  if (failure) throw failure;
  return result;
}
export async function measureOwned(root, directory, identity, operation, sink = () => {}) {
  let before;
  let result, original, cleanupFailure, sourceFailure;
  try {
    before = sourceFingerprint(root);
    result = await operation();
  } catch (error) {
    original = error;
  }
  try {
    owned.removeOwned(directory, identity);
  } catch {
    cleanupFailure = refusal("cleanup-identity");
  }
  try {
    if (before !== undefined && sourceFingerprint(root) !== before)
      sourceFailure = refusal("source-drift");
  } catch {
    sourceFailure = refusal("source-finalizer");
  }
  safe(sink, {
    npmWaitFinalizer: 1,
    cleanup: cleanupFailure ? "refused" : "complete",
    source: sourceFailure || before === undefined ? "unknown-or-drift" : "complete",
  });
  if (original) throw original;
  if (cleanupFailure) throw cleanupFailure;
  if (sourceFailure) throw sourceFailure;
  return result;
}
const RUNNER_STAGES = new Set([
  "locator",
  "parent-attach",
  "source-preflight",
  "source-files",
  "diagnostic-copy",
  "warmup",
  "measured-child",
]);
let runnerStage = "locator";
const markStage = (stage) => {
  if (RUNNER_STAGES.has(stage)) runnerStage = stage;
};
export async function runProbe(
  root,
  entry,
  sink = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
) {
  markStage("parent-attach");
  const verified = parentPreflight(2, sink, (trace) =>
    observer.attachPinnedNpmObserver(entry, {}, trace)
  );
  verified.stop();
  markStage("source-preflight");
  sourceFingerprint(root); // Preflight existing source/promisor restrictions before setup or install.
  const diagnosticHead = git(root, ["rev-parse", "HEAD"]).toString().trim();
  if (!/^[a-f0-9]{40}$/.test(diagnosticHead)) throw refusal("diagnostic-head");
  // Intentional exact-object setup fetch BEFORE fingerprint baseline. No moving ref fallback.
  try {
    git(root, ["-c", "protocol.allow=never", "cat-file", "-e", `${TARGET.source}^{commit}`]);
  } catch {
    try {
      git(root, ["fetch", "--no-tags", "--no-write-fetch-head", "origin", TARGET.source]);
    } catch {
      throw refusal("source-unavailable");
    }
  }
  try {
    if (
      git(root, ["-c", "protocol.allow=never", "rev-parse", `${TARGET.source}^{tree}`])
        .toString()
        .trim() !== TARGET.tree
    )
      throw refusal("source-tree");
  } catch {
    throw refusal("source-unavailable");
  }
  markStage("source-files");
  validateSourceFiles(root); // Root warmup lock parity, before any install.
  try {
    const blob = (file) =>
      git(root, ["-c", "protocol.allow=never", "cat-file", "blob", `${TARGET.source}:${file}`]);
    if (
      hash(blob("package-lock.json")) !== TARGET.lock ||
      JSON.parse(blob("package.json")).packageManager !== "npm@11.16.0" ||
      JSON.parse(blob("apps/cli/package.json")).version !== "0.0.26" ||
      blob(".node-version").toString().trim() !== "24.22.1"
    )
      throw refusal("source-pins");
  } catch {
    throw refusal("source-pins");
  }
  const tempRelative = path.relative(fs.realpathSync(root), fs.realpathSync(os.tmpdir()));
  if (
    !tempRelative ||
    (!tempRelative.startsWith(`..${path.sep}`) &&
      tempRelative !== ".." &&
      !path.isAbsolute(tempRelative))
  )
    throw refusal("scratch-location");
  const { directory, identity } = owned.createOwnedDirectory(
    path.join(os.tmpdir(), "outpost-npm-wait-")
  );
  let measured = false;
  try {
    markStage("diagnostic-copy");
    // Copy exact reviewed diagnostic bytes before baseline; no source writes in measurement.
    const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
    const diagnosticHashes = {};
    for (const name of ["npm-wait-child.cjs", "npm-wait-observer.cjs", "npm-wait-owned.cjs"]) {
      const bytes = observer.readBounded(path.join(scriptDirectory, name), 65536);
      fs.writeFileSync(path.join(directory, name), bytes, { flag: "wx", mode: 0o600 });
      diagnosticHashes[name] = hash(bytes);
    }
    const snapshot = path.join(directory, "source");
    fs.mkdirSync(snapshot);
    if (
      hash(
        git(root, [
          "-c",
          "protocol.allow=never",
          "cat-file",
          "blob",
          `${TARGET.source}:package-lock.json`,
        ])
      ) !== TARGET.lock
    )
      throw refusal("source-pins");
    // Same ordinary root ci warmup as candidate CI, before the measured baseline.
    markStage("warmup");
    execFileSync(process.execPath, [entry, "ci"], {
      cwd: root,
      maxBuffer: MAX_BUFFER,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    safe(sink, {
      npmWaitProvenance: 1,
      diagnosticHead,
      targetSource: TARGET.source,
      targetTree: TARGET.tree,
      lockSha256: TARGET.lock,
      node: "24.22.1",
      npm: "11.16.0",
      diagnosticHashes,
      diagnosticOnly: true,
      timingMayBePerturbed: true,
    });
    markStage("measured-child");
    measured = true;
    return await measureOwned(
      root,
      directory,
      identity,
      () => {
        snapshotCommit(root, snapshot, TARGET.source);
        validateSourceFiles(snapshot);
        return observeChild(
          process.execPath,
          [
            path.join(directory, "npm-wait-child.cjs"),
            entry,
            directory,
            identity.dev,
            identity.ino,
          ],
          {
            cwd: snapshot,
            timeout: TIMEOUT,
            maxBuffer: MAX_BUFFER,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
            shell: false,
          },
          path.join(directory, "wait-checkpoint.json"),
          sink
        );
      },
      sink
    );
  } finally {
    if (!measured) {
      try {
        owned.removeOwned(directory, identity);
      } catch {
        safe(sink, { npmWaitFinalizer: 1, cleanup: "refused", source: "not-measured" });
        // Unmeasured setup always retains its original failure.
      }
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== "--npm-command")
      throw refusal("invocation");
    const sink = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
    const entry = parentPreflight(1, sink, (trace) => locateNpm(process.argv[3], trace));
    await runProbe(process.cwd(), entry, sink);
  } catch (error) {
    const allowed = [
      "invocation",
      "scratch-location",
      "npm-locator",
      "git-environment",
      "diagnostic-head",
      "source-pins",
      "source-unavailable",
      "cleanup-identity",
      "source-drift",
      "source-finalizer",
    ];
    const startupRefused =
      error.status === 86 &&
      Buffer.isBuffer(error.stderr) &&
      error.stderr.length === Buffer.byteLength("NPM_WAIT_PROBE_INVALID\n") &&
      error.stderr.toString("ascii") === "NPM_WAIT_PROBE_INVALID\n";
    const category = startupRefused
      ? "invalid-probe"
      : error.code === "INVALID_NPM_WAIT_PROBE"
        ? "invalid-probe"
        : error.code === "ETIMEDOUT"
          ? "child-timeout"
          : allowed.includes(error.probeCategory)
            ? error.probeCategory
            : Number.isInteger(error.status)
              ? "child-exit"
              : "unknown";
    process.stderr.write(
      `${JSON.stringify({ npmWaitProbeFailure: 1, category, stage: runnerStage })}\n`
    );
    process.exitCode =
      Number.isInteger(error.status) && error.status > 0 && error.status <= 255 ? error.status : 1;
  }
}
