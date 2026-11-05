import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";

export class ManagerFixtureCleanupError extends Error {
  constructor(cause) {
    super("Owned manager or browser cleanup was not confirmed; preserve the smoke fixture.", {
      cause,
    });
  }
}

async function withinCleanupDeadline(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Owned manager did not close within 5 seconds")),
          5000
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Fixed categories only: child diagnostics can contain paths, URLs or credentials. */
export function managerStartupDiagnostic(stderr, code, signal) {
  const category = /\bERR_ACCESS_DENIED\b/.test(stderr)
    ? "access-denied"
    : stderr.includes("Manager could not start.")
      ? "manager-startup-refused"
      : /\b(?:ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND)\b/.test(stderr)
        ? "module-not-found"
        : "unclassified";
  return {
    category,
    exitCode: Number.isSafeInteger(code) ? code : null,
    signal: ["SIGINT", "SIGTERM", "SIGKILL", "SIGABRT"].includes(signal)
      ? signal
      : signal
        ? "other"
        : null,
  };
}

function managerFixtureRoots(installedPackage, smokeRoot) {
  const roots = [dirname(dirname(installedPackage)), smokeRoot];
  const canonical = roots.map((root) => {
    const before = statSync(root, { bigint: true });
    const real = realpathSync.native(root);
    const after = statSync(real, { bigint: true });
    const confirmed = statSync(root, { bigint: true });
    assert(before.isDirectory() && after.isDirectory() && confirmed.isDirectory());
    assert.equal(before.dev, after.dev);
    assert.equal(before.ino, after.ino);
    assert.equal(before.dev, confirmed.dev);
    assert.equal(before.ino, confirmed.ino);
    return real;
  });
  return { roots, canonical };
}

/** Actual installed foreground launcher, native .cmd through PowerShell on Windows. */
export async function verifyManagerWorkflow({
  launcher,
  runInstalled,
  smokeRoot,
  installedPackage,
}) {
  // Initialize metadata with the same verified spelling the manager will pin.
  smokeRoot = managerFixtureRoots(installedPackage, smokeRoot).canonical[1];
  const home = join(smokeRoot, "manager home Ω");
  const initialized = runInstalled(["init", "--json"], { OUTPOST_HOME: home });
  assert.equal(initialized.status, 0, initialized.stderr);
  const expectedFutureRoot = join(realpathSync.native(home), "future worktrees");
  const source = join(smokeRoot, "ms");
  mkdirSync(source);
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: source, encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, "Synthetic local Git failed");
  };
  git("init", "--initial-branch=main");
  git(
    "-c",
    "user.name=Outpost fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "source only"
  );
  git("config", "remote.synthetic.url", "https://SECRET_TRANSPORT_MARKER@example.invalid/private");
  const importRemote = join(smokeRoot, "mi.git");
  git("init", "--bare", importRemote);
  git("remote", "add", "local", importRemote);
  writeFileSync(join(source, "tracked.txt"), "committed source bytes\n");
  git("add", "tracked.txt");
  git(
    "-c",
    "user.name=Outpost fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "tracked source"
  );
  git("update-index", "--split-index");
  writeFileSync(join(source, "tracked.txt"), "dirty source bytes\n");
  writeFileSync(join(source, "untracked.txt"), "untracked source bytes\n");
  const preserved = [
    join(source, "tracked.txt"),
    join(source, "untracked.txt"),
    join(source, ".git", "index"),
    ...readdirSync(join(source, ".git"))
      .filter((name) => name.startsWith("sharedindex."))
      .map((name) => join(source, ".git", name)),
  ];
  const original = preserved.map((file) => ({
    file,
    bytes: readFileSync(file),
    mtime: statSync(file, { bigint: true }).mtimeNs,
  }));
  const configPath = join(source, ".git", "config");
  const configBefore = readFileSync(configPath);
  const configTime = statSync(configPath, { bigint: true }).mtimeNs;
  const quoted = (value) => `"${value.replaceAll("\\", "/")}"`;
  const { roots, canonical } = managerFixtureRoots(installedPackage, smokeRoot);
  // Native Windows evidence: the short temp spelling alone does not grant the
  // canonical home read. Both spellings identify these same owned fixture roots.
  const reads = [...new Set([...roots, ...canonical])];
  const writes = [...new Set([smokeRoot, canonical[1]])];
  // Linux's callback realpath checks ancestor /tmp. Add its test-only allowance
  // before the nested fixture: Node24's permission trie otherwise drops the parent.
  const permissions = `--permission --allow-child-process${process.platform === "linux" ? " --allow-fs-read=/tmp" : ""} ${reads.map((root) => `--allow-fs-read=${quoted(root)}`).join(" ")} ${writes.map((root) => `--allow-fs-write=${quoted(root)}`).join(" ")}`;
  const denied = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import fs from 'node:fs';try{fs.readFileSync(${JSON.stringify(fileURLToPath(new URL("../src/cli.ts", import.meta.url)))});process.exitCode=1;}catch(error){if(error.code!=="ERR_ACCESS_DENIED")throw error;process.stdout.write("SOURCE_DENIED");}`,
    ],
    { env: { ...process.env, NODE_OPTIONS: permissions }, encoding: "utf8", windowsHide: true }
  );
  assert.equal(denied.status, 0, denied.stderr);
  assert.equal(denied.stdout, "SOURCE_DENIED");
  const env = {
    ...process.env,
    OUTPOST_HOME: home,
    OUTPOST_SMOKE_LAUNCHER: launcher,
    NODE_OPTIONS: permissions,
  };
  const child =
    process.platform === "win32"
      ? spawn(
          "powershell.exe",
          [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "& $env:OUTPOST_SMOKE_LAUNCHER manage; exit $LASTEXITCODE",
          ],
          { cwd: smokeRoot, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
        )
      : spawn(launcher, ["manage"], { cwd: smokeRoot, env, stdio: ["ignore", "pipe", "pipe"] });
  const exit = new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve([code, signal]))
  );
  const closed = new Promise((resolve) => child.once("close", resolve));
  let stdout = "",
    stderr = "";
  let origin = "",
    browser,
    browserBearer = "",
    originalFailure,
    workflowFailed = false;
  try {
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Installed manager did not start within 10 seconds")),
        10000
      );
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        const match = /http:\/\/127\.0\.0\.1:\d+\/#pair=[0-9a-f]+/.exec(stdout);
        if (match) {
          clearTimeout(timer);
          resolve(match[0]);
        }
      });
      child.stderr.on("data", (chunk) => {
        const remaining = 65536 - Buffer.byteLength(stderr);
        if (remaining > 0) stderr += Buffer.from(chunk).subarray(0, remaining).toString("utf8");
      });
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        const startupExit = managerStartupDiagnostic(stderr, code, signal);
        reject(
          new Error(`Installed manager exited before pairing: ${JSON.stringify(startupExit)}`)
        );
      });
      child.once("error", () => {
        clearTimeout(timer);
        reject(new Error("Installed manager launcher could not start"));
      });
    });
    origin = new URL(url).origin;
    const health = await fetch(origin);
    assert.equal(health.status, 200);
    assert.match(await health.text(), /Outpost/);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const pairedResponse = page.waitForResponse(
      (response) => response.url().endsWith("/api/v1/pair") && response.status() === 200
    );
    await page.goto(url);
    browserBearer = (await (await pairedResponse).json()).data.bearer;
    await page.getByRole("heading", { name: "Repositories", exact: true }).waitFor();
    assert.equal(new URL(page.url()).hash, "");
    await page.getByRole("button", { name: "Register repository", exact: true }).click();
    await page.getByLabel("Name", { exact: true }).fill("registered clone");
    await page.getByLabel("Absolute checkout path").fill(source);
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    try {
      await page
        .getByRole("status")
        .filter({ hasText: "Operation: succeeded. Action completed." })
        .waitFor();
    } catch (error) {
      console.error(
        "Manager browser diagnostic:",
        (await page.locator("body").innerText()).replaceAll(
          "SECRET_TRANSPORT_MARKER",
          "[redacted synthetic transport]"
        )
      );
      throw error;
    }
    await page.getByText("registered clone", { exact: true }).first().waitFor();
    assert.equal(
      (await page.locator("body").innerText()).includes("SECRET_TRANSPORT_MARKER"),
      false
    );
    for (const item of original) {
      assert.deepEqual(readFileSync(item.file), item.bytes);
      assert.equal(statSync(item.file, { bigint: true }).mtimeNs, item.mtime);
    }
    assert.deepEqual(readFileSync(configPath), configBefore);
    assert.equal(statSync(configPath, { bigint: true }).mtimeNs, configTime);
    const finished = async (trigger) => {
      const response = page.waitForResponse(
        (r) => r.url().endsWith("/api/v1/operations") && r.request().method() === "POST"
      );
      await trigger();
      const result = await (await response).json();
      assert.equal(result.ok, true);
      await expect
        .poll(
          async () => {
            const response = await fetch(`${origin}/api/v1/operations/${result.data.id}`, {
              headers: {
                Origin: origin,
                "X-Outpost-Manager": "1",
                Authorization: `Bearer ${browserBearer}`,
              },
            });
            const state = await response.json();
            return state.data?.state;
          },
          { timeout: 30000 }
        )
        .toBe("succeeded");
    };
    await page.getByRole("button", { name: "Import repository", exact: true }).click();
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(page.getByText("Enter an absolute native checkout path.")).toBeVisible();
    await expect(page.getByLabel("Absolute checkout path")).toBeFocused();
    await page.getByLabel("Absolute checkout path").fill(source);
    await page.getByLabel("Remote name (optional)").fill("local");
    await finished(() => page.getByRole("button", { name: "Confirm", exact: true }).click());
    await page.getByRole("button", { name: "mi", exact: true }).waitFor();
    const imported = JSON.parse(
      runInstalled(["repo", "list", "--json"], { OUTPOST_HOME: home }).stdout
    ).data.repos;
    assert.equal(imported.length, 2);
    assert.equal(imported.filter((repo) => repo.name === "mi" && repo.managedRepoPath).length, 1);
    assert.equal(
      (await page.locator("body").innerText()).includes("SECRET_TRANSPORT_MARKER"),
      false
    );
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Open settings editor", exact: true }).click();
    await page.getByLabel("Absolute path", { exact: true }).fill(join(home, "future worktrees"));
    await finished(() => page.getByRole("button", { name: "Save root", exact: true }).click());
    await page
      .getByLabel("Plaintext guidance", { exact: true })
      .fill("Future-only fixture guidance Ω");
    await finished(() => page.getByRole("button", { name: "Save guidance", exact: true }).click());
    const stored = JSON.parse(
      runInstalled(["config", "show", "--json"], { OUTPOST_HOME: home }).stdout
    ).data;
    assert.equal(stored.extraInstructions, "Future-only fixture guidance Ω");
    assert.equal(stored.worktreesRoot, expectedFutureRoot);
    await page.getByRole("button", { name: "Repositories", exact: true }).click();
    await page.getByText("registered clone", { exact: true }).first().waitFor();
    await page
      .getByRole("group", { name: "Actions for registered clone", exact: true })
      .getByRole("button", { name: "Unregister", exact: true })
      .click();
    await finished(() => page.getByRole("button", { name: "Confirm", exact: true }).click());
    const retained = JSON.parse(
      runInstalled(["repo", "list", "--retained", "--json"], { OUTPOST_HOME: home }).stdout
    ).data;
    assert.equal(retained.repos.length, 1);
    await page.getByRole("button", { name: "Retained", exact: true }).click();
    await page.getByRole("button", { name: "Restore", exact: true }).click();
    await finished(() => page.getByRole("button", { name: "Confirm", exact: true }).click());
    assert.equal(
      JSON.parse(runInstalled(["repo", "list", "--json"], { OUTPOST_HOME: home }).stdout).data.repos
        .length,
      2
    );
    for (const item of original) {
      assert.deepEqual(readFileSync(item.file), item.bytes);
      assert.equal(statSync(item.file, { bigint: true }).mtimeNs, item.mtime);
    }
    assert.deepEqual(readFileSync(configPath), configBefore);
    assert.equal(statSync(configPath, { bigint: true }).mtimeNs, configTime);
    const storage = await page.evaluate(() => ({
      local: localStorage.length,
      session: sessionStorage.length,
      cookies: document.cookie,
    }));
    assert.deepEqual(storage, { local: 0, session: 0, cookies: "" });
    assert.deepEqual(errors, []);
    await page.getByRole("button", { name: "Stop manager", exact: true }).click();
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    const [code] = await withinCleanupDeadline(exit);
    assert.equal(code, 0, "Foreground manager exited unsuccessfully");
    assert.equal(stderr.includes("SECRET_TRANSPORT_MARKER"), false);
    console.log(
      "Installed foreground manager paired, imported a local remote, registered/unregistered/restored a local clone and changed future settings coherently with the CLI, preserved source config bytes/ns-mtime, kept sessions out of browser storage and stopped through bundled browser assets."
    );
  } catch (error) {
    originalFailure = error;
    workflowFailed = true;
  }
  if (child.exitCode === null && child.signalCode === null && origin && browserBearer) {
    await fetch(`${origin}/api/v1/stop`, {
      method: "POST",
      headers: {
        Origin: origin,
        "X-Outpost-Manager": "1",
        Authorization: `Bearer ${browserBearer}`,
        "Content-Type": "application/json",
      },
      body: "{}",
      signal: AbortSignal.timeout(5000),
    })
      .then(() => withinCleanupDeadline(closed))
      .catch(() => {});
  }
  let browserCloseFailure;
  try {
    await browser?.close();
  } catch (error) {
    browserCloseFailure = error;
  }
  if (
    child.exitCode === null &&
    child.signalCode === null &&
    Number.isSafeInteger(child.pid) &&
    child.pid > 0
  ) {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        timeout: 5000,
        maxBuffer: 4096,
      });
    } else child.kill("SIGTERM");
  }
  try {
    await withinCleanupDeadline(closed);
  } catch (error) {
    throw new ManagerFixtureCleanupError(originalFailure ?? error);
  }
  if (browserCloseFailure)
    throw new ManagerFixtureCleanupError(originalFailure ?? browserCloseFailure);
  if (workflowFailed) throw originalFailure;
}
