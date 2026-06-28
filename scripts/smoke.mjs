import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const smokeRoot = mkdtempSync(join(tmpdir(), "outpost-smoke-"));
const packDir = join(smokeRoot, "pack");
const unpackDir = join(smokeRoot, "unpack");
const unpackedPackage = join(unpackDir, "package");
const installPrefix = join(smokeRoot, "global");
const outpostHome = join(smokeRoot, "home");
const npmPrefixEnv = {
  NPM_CONFIG_PREFIX: installPrefix,
  npm_config_global_prefix: installPrefix,
  npm_config_prefix: installPrefix,
};

let cleaned = false;

function cleanup() {
  if (cleaned) return;
  cleaned = true;
  rmSync(smokeRoot, { recursive: true, force: true });
}

function handleSignal(signal, exitCode) {
  process.once(signal, () => {
    cleanup();
    process.exit(exitCode);
  });
}

handleSignal("SIGINT", 130);
handleSignal("SIGTERM", 143);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? projectRoot,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
    shell: options.shell ?? false,
  });

  if (result.error) {
    throw result.error;
  }

  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function assertSuccess(result, label) {
  assert.equal(
    result.status,
    0,
    `${label} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

function runNpm(args, options) {
  return run(npmCommand, args, {
    ...options,
    shell: process.platform === "win32",
  });
}

function getInstalledBinPath() {
  return process.platform === "win32"
    ? join(installPrefix, "outpost.cmd")
    : join(installPrefix, "bin", "outpost");
}

function runInstalled(args, env) {
  return run(getInstalledBinPath(), args, {
    env,
    shell: process.platform === "win32",
  });
}

try {
  mkdirSync(packDir, { recursive: true });
  mkdirSync(unpackDir, { recursive: true });

  console.log("Building...");
  const buildResult = runNpm(["run", "build"]);
  assertSuccess(buildResult, "npm run build");

  console.log(`Packing to ${packDir}...`);
  const packResult = runNpm([
    "pack",
    "--json",
    "--ignore-scripts",
    "--pack-destination",
    packDir,
  ]);
  assertSuccess(packResult, "npm pack");

  const packOutput = JSON.parse(packResult.stdout);
  assert.equal(packOutput.length, 1, "npm pack should produce one tarball");
  const tarball = join(packDir, packOutput[0].filename);

  console.log(`Extracting ${tarball}...`);
  const extractResult = run("tar", ["-xzf", tarball, "-C", unpackDir]);
  assertSuccess(extractResult, "tarball extraction");

  symlinkSync(
    join(projectRoot, "node_modules"),
    join(unpackedPackage, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );

  console.log(`Linking to ${installPrefix}...`);
  const linkResult = runNpm(
    ["link", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"],
    {
      cwd: unpackedPackage,
      env: npmPrefixEnv,
    },
  );
  assertSuccess(linkResult, "global package link");

  console.log("Test: importing packed package is side-effect-free");
  const importResult = run(process.execPath, [
    "--input-type=module",
    "--eval",
    [
      `import { runCli } from ${JSON.stringify(pathToFileURL(join(unpackedPackage, "dist", "index.js")).href)};`,
      'if (typeof runCli !== "function") throw new TypeError("runCli missing");',
      'process.stdout.write("OK\\n");',
    ].join("\n"),
  ]);
  assert.equal(importResult.status, 0);
  assert.equal(importResult.stdout, "OK\n");
  assert.equal(importResult.stderr, "");

  console.log("Test: outpost --help");
  const helpResult = runInstalled(["--help"]);
  assert.equal(helpResult.status, 0);
  assert.match(helpResult.stdout, /Usage:\n {2}outpost <command> \[options\]/);
  assert.equal(helpResult.stderr, "");

  console.log("Test: outpost --version");
  const versionResult = runInstalled(["--version"]);
  assert.equal(versionResult.status, 0);
  assert.equal(versionResult.stdout, `${version}\n`);
  assert.equal(versionResult.stderr, "");

  console.log("Test: outpost wat (unknown command)");
  const unknownResult = runInstalled(["wat"]);
  assert.equal(unknownResult.status, 1);
  assert.equal(unknownResult.stdout, "");
  assert.equal(
    unknownResult.stderr,
    "Unknown command: wat\nRun `outpost --help` to see available commands.\n",
  );

  console.log("Test: outpost create --json (missing args)");
  const createResult = runInstalled(["create", "--json"]);
  assert.equal(createResult.status, 1);
  assert.equal(createResult.stdout, "");
  const createError = JSON.parse(createResult.stderr);
  assert.equal(createError.ok, false);
  assert.equal(createError.exitCode, 1);
  assert.equal(createError.command, null);
  assert.equal(createError.error.code, "USAGE_ERROR");
  assert.ok(createError.error.message.includes("Usage: outpost create"));
  assert.ok(createError.error.message.includes("--ticket is required."));
  assert.ok(createError.error.message.includes("--type is required."));
  assert.ok(
    createError.error.message.includes("At least one --repo is required."),
  );

  console.log("Test: structured partial result exits 1");
  const commandEnv = { OUTPOST_HOME: outpostHome };
  const initResult = runInstalled(["init", "--json"], commandEnv);
  assert.equal(initResult.status, 0);
  assert.equal(initResult.stderr, "");

  const now = new Date(0).toISOString();
  writeFileSync(
    join(outpostHome, "repos.json"),
    `${JSON.stringify(
      {
        repos: [
          {
            id: "file:///missing/repo",
            importedAt: now,
            lastFetchedAt: now,
            managedRepoPath: join(outpostHome, "repos", "missing.git"),
            name: "repo",
            remoteName: "origin",
            remoteUrl: "file:///missing/repo",
            sourceRepoPath: join(smokeRoot, "missing-source"),
          },
        ],
      },
      null,
      2,
    )}\n`,
  );

  const partialResult = runInstalled(
    ["repo", "fetch", "--all", "--json"],
    commandEnv,
  );
  assert.equal(partialResult.status, 1);
  assert.equal(partialResult.stderr, "");
  const partialOutput = JSON.parse(partialResult.stdout);
  assert.equal(partialOutput.ok, false);
  assert.equal(partialOutput.command, "repo fetch");
  assert.equal(partialOutput.exitCode, 1);
  assert.equal(partialOutput.data.failedCount, 1);
  assert.equal(partialOutput.data.results[0].fetchStatus, "failed");

  console.log("\nAll smoke tests passed.");
} finally {
  cleanup();
}
