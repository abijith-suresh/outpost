import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { verifyBorrowedLocalWorkflow } from "../apps/cli/scripts/borrowed-local-smoke.mjs";
import {
  ManagerFixtureCleanupError,
  verifyManagerWorkflow,
} from "../apps/cli/scripts/manager-smoke.mjs";
import { verifyRegisterWorkflow } from "../apps/cli/scripts/register-smoke.mjs";
import { verifyResumeWorkflow } from "../apps/cli/scripts/resume-smoke.mjs";
import { installPrepared, preserveFixture } from "./prerelease.mjs";

export async function checkInstalledPrerelease(installation) {
  const smokeRoot = mkdtempSync(join(tmpdir(), "outpost candidate é "));
  let preserve = false;
  try {
    const installedPackage = join(installation.directory, "node_modules/@abijith-suresh/outpost");
    const runInstalled = (args, env = {}) => {
      const quote = (value) => `'${value.replaceAll("'", "''")}'`;
      const script = `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding; & ${[installation.executable, ...args].map(quote).join(" ")}; exit $LASTEXITCODE`;
      return spawnSync(
        process.platform === "win32" ? "powershell.exe" : installation.executable,
        process.platform === "win32"
          ? [
              "-NoProfile",
              "-NonInteractive",
              "-EncodedCommand",
              Buffer.from(script, "utf16le").toString("base64"),
            ]
          : args,
        { cwd: smokeRoot, encoding: "utf8", timeout: 30000, env: { ...process.env, ...env } }
      );
    };
    const validateInstalled = (command, output) => {
      const schema = JSON.parse(
        readFileSync(
          join(installedPackage, "schemas", `${command.replaceAll(" ", "-")}.output.json`),
          "utf8"
        )
      );
      const validate = new Ajv2020({ strict: true }).compile(schema);
      assert.ok(validate(output), JSON.stringify(validate.errors));
    };
    const version = runInstalled(["--version"]);
    assert.equal(version.status, 0, version.stderr);
    assert.equal(version.stdout.trim(), installation.version);
    verifyRegisterWorkflow({ runInstalled, validateInstalled, smokeRoot });
    const previousCwd = process.cwd();
    try {
      process.chdir(fileURLToPath(new URL("../apps/cli", import.meta.url)));
      verifyBorrowedLocalWorkflow({ runInstalled, validateInstalled, smokeRoot });
    } finally {
      process.chdir(previousCwd);
    }
    verifyResumeWorkflow({ runInstalled, validateInstalled, smokeRoot });
    await verifyManagerWorkflow({
      launcher: installation.executable,
      runInstalled,
      smokeRoot,
      installedPackage,
    });
    console.log(
      `Staged CLI/manager lifecycle passed on ${process.platform}: ${installation.version}`
    );
  } catch (error) {
    preserve = error instanceof ManagerFixtureCleanupError;
    throw error;
  } finally {
    if (!preserve) rmSync(smokeRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (
    process.argv.length !== 6 ||
    process.argv[2] !== "--bundle" ||
    process.argv[4] !== "--expected-sha"
  )
    throw new Error("Use --bundle ABSOLUTE_DIRECTORY --expected-sha FULL_SHA");
  const temporary = mkdtempSync(join(tmpdir(), "outpost candidate consumer "));
  let preserve = false;
  try {
    const installation = installPrepared(
      resolve(process.argv[3]),
      join(temporary, "install"),
      process.argv[5]
    );
    await checkInstalledPrerelease(installation);
  } catch (error) {
    preserve = preserveFixture(error);
    throw error;
  } finally {
    if (!preserve) rmSync(temporary, { recursive: true, force: true });
  }
}
