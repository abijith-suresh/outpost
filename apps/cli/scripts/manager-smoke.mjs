import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, expect } from "@playwright/test";

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

/** Failure-only comparison of the real installed metadata reader; never a passing fallback. */
export function inspectManagerStartupBoundary({ home, installedPackage, smokeRoot, permissions }) {
  try {
    const roots = [dirname(dirname(installedPackage)), smokeRoot];
    const canonical = roots.map((root) => {
      const before = statSync(root, { bigint: true });
      const real = realpathSync.native(root);
      const after = statSync(real, { bigint: true });
      assert(before.isDirectory() && after.isDirectory());
      assert.equal(before.dev, after.dev);
      assert.equal(before.ino, after.ino);
      return real;
    });
    const quoted = (value) => `"${value.replaceAll("\\", "/")}"`;
    const both = `${permissions} ${canonical.map((root) => `--allow-fs-read=${quoted(root)}`).join(" ")} --allow-fs-write=${quoted(canonical[1])}`;
    const input = JSON.stringify({
      home,
      source: fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
      inventory: pathToFileURL(join(installedPackage, "dist/application/inventory.js")).href,
    });
    const script = `
      import fs from 'node:fs';
      import fsp from 'node:fs/promises';
      const input=JSON.parse(fs.readFileSync(0,'utf8'));
      const result={sourceDenied:false,realpath:false,canonicalStat:false,recordedHome:false,code:'none'};
      const code=e=>['ERR_ACCESS_DENIED','ENOENT','EACCES','EPERM'].includes(e?.code)?e.code:'other';
      try{fs.readFileSync(input.source);}catch(e){result.sourceDenied=e.code==='ERR_ACCESS_DENIED';}
      try{const real=await fsp.realpath(input.home);result.realpath=true;result.canonicalStat=(await fsp.lstat(real)).isDirectory();}catch(e){result.code=code(e);}
      try{const{RecordedFiles}=await import(input.inventory);await RecordedFiles.open(input.home);result.recordedHome=true;}catch(e){if(result.code==='none')result.code=code(e);}
      process.stdout.write(JSON.stringify(result));
    `;
    const inspect = (options) => {
      const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
        cwd: smokeRoot,
        env: { ...process.env, NODE_OPTIONS: options },
        input,
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: 65536,
        windowsHide: true,
      });
      if (child.status !== 0)
        return {
          unavailable: true,
          ...managerStartupDiagnostic(child.stderr, child.status, child.signal),
        };
      const raw = JSON.parse(child.stdout);
      if (
        !["sourceDenied", "realpath", "canonicalStat", "recordedHome"].every(
          (key) => typeof raw[key] === "boolean"
        ) ||
        !["none", "ERR_ACCESS_DENIED", "ENOENT", "EACCES", "EPERM", "other"].includes(raw.code)
      )
        return { unavailable: true };
      return {
        sourceDenied: raw.sourceDenied,
        realpath: raw.realpath,
        canonicalStat: raw.canonicalStat,
        recordedHome: raw.recordedHome,
        code: raw.code,
      };
    };
    return {
      rootSpellingsDiffer: roots.some((root, index) => root !== canonical[index]),
      original: inspect(permissions),
      bothOwnedSpellings: inspect(both),
    };
  } catch {
    return { unavailable: true };
  }
}

/** Actual installed foreground launcher, native .cmd through PowerShell on Windows. */
export async function verifyManagerWorkflow({
  launcher,
  runInstalled,
  smokeRoot,
  installedPackage,
}) {
  const home = join(smokeRoot, "manager home Ω");
  const initialized = runInstalled(["init", "--json"], { OUTPOST_HOME: home });
  assert.equal(initialized.status, 0, initialized.stderr);
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
  // Linux's callback realpath checks ancestor /tmp. Add its test-only allowance
  // before the nested fixture: Node24's permission trie otherwise drops the parent.
  const permissions = `--permission --allow-child-process${process.platform === "linux" ? " --allow-fs-read=/tmp" : ""} --allow-fs-read=${quoted(dirname(dirname(installedPackage)))} --allow-fs-read=${quoted(smokeRoot)} --allow-fs-write=${quoted(smokeRoot)}`;
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
  const exit = once(child, "exit");
  let stdout = "",
    stderr = "";
  let startupExit = null;
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
      startupExit = managerStartupDiagnostic(stderr, code, signal);
      reject(new Error(`Installed manager exited before pairing: ${JSON.stringify(startupExit)}`));
    });
  }).catch(() => {
    const boundary =
      child.exitCode === null
        ? { unavailable: true }
        : inspectManagerStartupBoundary({ home, installedPackage, smokeRoot, permissions });
    throw new Error(
      `Installed manager startup failed: ${JSON.stringify({ exit: startupExit, boundary })}`
    );
  });
  const origin = new URL(url).origin;
  let browser;
  try {
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
    const browserBearer = (await (await pairedResponse).json()).data.bearer;
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
    assert.equal(stored.worktreesRoot, join(home, "future worktrees"));
    await page.getByRole("button", { name: "Repositories", exact: true }).click();
    await page.getByText("registered clone", { exact: true }).first().waitFor();
    await page.getByRole("button", { name: "Unregister", exact: true }).click();
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
      1
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
    const [code] = await exit;
    assert.equal(code, 0, "Foreground manager exited unsuccessfully");
    assert.equal(stderr.includes("SECRET_TRANSPORT_MARKER"), false);
    console.log(
      "Installed foreground manager paired, registered/unregistered/restored a local clone and changed future settings coherently with the CLI, preserved source config bytes/ns-mtime, kept sessions out of browser storage and stopped through bundled browser assets."
    );
  } finally {
    await browser?.close();
    if (child.exitCode === null) child.kill();
  }
}
