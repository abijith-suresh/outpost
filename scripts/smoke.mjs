import { createRequire } from "node:module";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync, execSync } from "node:child_process";
import { ok, strictEqual } from "node:assert";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

const projectRoot = dirname(dirname(new URL(import.meta.url).pathname)).replace(
  /\\/g,
  "/",
);

let packDir;
let prefix;

process.on("exit", () => {
  if (packDir)
    try {
      rmSync(packDir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  if (prefix)
    try {
      rmSync(prefix, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
});

function runBin(...args) {
  const binPath = join(prefix, "bin", "outpost");
  const result = execFileSync(binPath, args, {
    encoding: "utf8",
    stdio: "pipe",
    env: { ...process.env },
  });
  return { stdout: result, stderr: "", status: 0 };
}

function runBinFails(...args) {
  const binPath = join(prefix, "bin", "outpost");
  try {
    execFileSync(binPath, args, {
      encoding: "utf8",
      stdio: "pipe",
      env: { ...process.env },
    });
    throw new Error("Expected non-zero exit");
  } catch (e) {
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      status: e.status ?? null,
    };
  }
}

// Step 1: Build
console.log("Building...");
execSync("npm run build", { stdio: "inherit", cwd: projectRoot });

// Step 2: npm pack
packDir = mkdtempSync(join(tmpdir(), "outpost-smoke-pack-"));
console.log(`Packing to ${packDir}...`);
execSync(`npm pack --pack-destination "${packDir}"`, {
  cwd: projectRoot,
  stdio: "pipe",
});

const tarballs = readdirSync(packDir).filter((f) => f.endsWith(".tgz"));
strictEqual(tarballs.length, 1, `Expected 1 tarball, found ${tarballs.length}`);
const tarball = join(packDir, tarballs[0]);

// Step 3: npm install globally
prefix = mkdtempSync(join(tmpdir(), "outpost-smoke-prefix-"));
console.log(`Installing to ${prefix}...`);
execSync(`npm install --global --prefix "${prefix}" "${tarball}"`, {
  stdio: "pipe",
});

// Step 4: Verify

// outpost --help
console.log("Test: outpost --help");
let r = runBin("--help");
strictEqual(r.status, 0, `--help status: ${r.status}`);
ok(r.stdout.includes("Usage:"), "--help should contain Usage:");

// outpost --version
console.log("Test: outpost --version");
r = runBin("--version");
strictEqual(r.status, 0, `--version status: ${r.status}`);
ok(
  r.stdout.trim() === version,
  `--version expected "${version}", got "${r.stdout.trim()}"`,
);

// outpost wat
console.log("Test: outpost wat (unknown command)");
const rWat = runBinFails("wat");
strictEqual(rWat.status, 1, `wat status: ${rWat.status}`);
ok(
  rWat.stderr.includes("Unknown command"),
  `stderr should include "Unknown command", got: "${rWat.stderr}"`,
);

// outpost create --json
console.log("Test: outpost create --json (missing args)");
const rCreate = runBinFails("create", "--json");
strictEqual(rCreate.status, 1, `create --json status: ${rCreate.status}`);
ok(rCreate.stderr.length > 0, "create --json should produce stderr usage");

// npm exec --package <tarball> -- outpost --help
console.log("Test: npm exec --package <tarball> -- outpost --help");
const npmExecResult = execFileSync(
  "npm",
  ["exec", "--package", tarball, "--", "outpost", "--help"],
  { encoding: "utf8", env: { ...process.env } },
);
ok(npmExecResult.includes("Usage:"), "npm exec should show help");

// Test: importing the package produces no output or CLI execution
console.log("Test: importing the package is side-effect-free");
const importDir = mkdtempSync(join(tmpdir(), "outpost-smoke-import-"));
const importTestScript = join(importDir, "import-test.mjs");
try {
  writeFileSync(
    importTestScript,
    [
      'import { runCli } from "' + projectRoot + '/dist/index.js";',
      'import process from "node:process";',
      "process.exitCode = 0;",
      'console.log("OK");',
    ].join("\n"),
    "utf8",
  );
  const importResult = execFileSync(process.execPath, [importTestScript], {
    encoding: "utf8",
    env: { ...process.env },
  });
  ok(
    importResult.trim() === "OK",
    `Import should produce only "OK", got: "${importResult.trim()}"`,
  );
} finally {
  rmSync(importDir, { recursive: true, force: true });
}

// Cleanup will happen in exit handler
console.log("\nAll smoke tests passed. Cleaning up...");
