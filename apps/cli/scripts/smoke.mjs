import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const smokeRoot = mkdtempSync(join(tmpdir(), "outpost-smoke-"));
const packDir = join(smokeRoot, "pack");
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
    `${label} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
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

  console.log("Building...");
  const buildResult = runNpm(["run", "build"]);
  assertSuccess(buildResult, "npm run build");

  console.log(`Packing to ${packDir}...`);
  const packResult = runNpm(["pack", "--json", "--ignore-scripts", "--pack-destination", packDir]);
  assertSuccess(packResult, "npm pack");

  const packOutput = JSON.parse(packResult.stdout);
  assert.equal(packOutput.length, 1, "npm pack should produce one tarball");
  const tarball = join(packDir, packOutput[0].filename);

  console.log(`Installing ${tarball} to ${installPrefix}...`);
  const installResult = runNpm(
    [
      "install",
      "--global",
      tarball,
      "--prefer-offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ],
    {
      env: npmPrefixEnv,
    }
  );
  assertSuccess(installResult, "global packed-package install");

  const globalRootResult = runNpm(["root", "--global"], {
    env: npmPrefixEnv,
  });
  assertSuccess(globalRootResult, "resolve global package root");
  const installedPackage = join(globalRootResult.stdout.trim(), "@abijith-suresh", "outpost");

  console.log("Test: importing packed package is side-effect-free");
  const importResult = run(process.execPath, [
    "--input-type=module",
    "--eval",
    [
      `import { runCli } from ${JSON.stringify(pathToFileURL(join(installedPackage, "dist", "index.js")).href)};`,
      'if (typeof runCli !== "function") throw new TypeError("runCli missing");',
      'process.stdout.write("OK\\n");',
    ].join("\n"),
  ]);
  assert.equal(importResult.status, 0);
  assert.equal(importResult.stdout, "OK\n");
  assert.equal(importResult.stderr, "");

  console.log("Test: lazy startup through the installed runCli API");
  const lazyResult = run(process.execPath, [
    "--input-type=module",
    "--eval",
    [
      'import { registerHooks } from "node:module";',
      "const loaded = []; registerHooks({ load(url, context, next) { loaded.push(url); return next(url, context); } });",
      `const { runCli } = await import(${JSON.stringify(pathToFileURL(join(installedPackage, "dist", "index.js")).href)});`,
      'await runCli(["--version"]); await runCli(["--help"]);',
      'if (loaded.some(url => /node_modules\\/(effect|@effect)\\//.test(url))) throw new Error("Fast startup loaded Effect runtime");',
      'await runCli(["describe", "doctor", "--json"]);',
      'if (loaded.some(url => /\\/(program|runtime)\\.js$|\\/commands\\/(create|repo-add)\\.js$/.test(url))) throw new Error("Discovery loaded mutation handlers");',
      'process.stdout.write("LAZY OK\\n");',
    ].join("\n"),
  ]);
  assertSuccess(lazyResult, "lazy installed API");
  assert.ok(lazyResult.stdout.endsWith("LAZY OK\n"));

  console.log("Test: installed offline skill, schema documents and scoped-package man link");
  const installedManifest = JSON.parse(
    readFileSync(join(installedPackage, "package.json"), "utf8")
  );
  assert.equal(Object.keys(installedManifest.dependencies).length, 2);
  assert.equal(installedManifest.dependencies.ajv, undefined);
  const locations = runInstalled(["skill", "path", "--json"]);
  assertSuccess(locations, "installed guidance paths");
  const assets = JSON.parse(locations.stdout).data;
  assert.equal(
    realpathSync(assets.skillPath),
    realpathSync(join(installedPackage, "skills", "outpost", "SKILL.md"))
  );
  const schemaIndex = JSON.parse(readFileSync(join(assets.schemasPath, "index.json"), "utf8"));
  for (const entry of schemaIndex.schemas) {
    const schema = JSON.parse(readFileSync(join(assets.schemasPath, entry.path), "utf8"));
    // Synchronous compilation has no remote loader, so unresolved references fail offline.
    new Ajv2020({ strict: true }).compile(schema);
  }
  const validateInstalled = (command, output) => {
    const schema = JSON.parse(
      readFileSync(join(assets.schemasPath, `${command.replaceAll(" ", "-")}.output.json`), "utf8")
    );
    const validate = new Ajv2020({ strict: true }).compile(schema);
    assert.ok(validate(output), JSON.stringify(validate.errors));
  };
  console.log("Test: installed schema identity rejects corruption and command substitution");
  const fullDiscovery = runInstalled(["describe", "--json"]);
  assertSuccess(fullDiscovery, "all installed schema identities");
  validateInstalled("describe", JSON.parse(fullDiscovery.stdout));
  for (const entry of schemaIndex.schemas.filter((entry) => entry.kind === "output")) {
    const described = runInstalled(["describe", ...entry.command.split(" "), "--json"]);
    assertSuccess(described, `valid installed schema ${entry.command}`);
    const expected = JSON.parse(readFileSync(join(assets.schemasPath, entry.path), "utf8"));
    delete expected.$schema;
    assert.deepEqual(JSON.parse(described.stdout).data.outputSchema, expected);
  }
  const doctorAsset = join(assets.schemasPath, "doctor.output.json");
  const originalDoctor = readFileSync(doctorAsset);
  const malformedNested = JSON.parse(originalDoctor.toString("utf8"));
  malformedNested.anyOf[0].properties.data.properties.status = { type: "not-a-type" };
  const invalidKeyword = JSON.parse(originalDoctor.toString("utf8"));
  invalidKeyword.anyOf[0].required = "ok";
  const corruptAssets = [
    ["syntax", "{"],
    ["null", "null"],
    ["number", "42"],
    ["string", '"schema"'],
    ["boolean", "true"],
    ["array", "[]"],
    ["empty object", "{}"],
    ["invalid type", '{"type":"definitely-not-a-type"}'],
    ["malformed nested schema", JSON.stringify(malformedNested)],
    ["invalid keyword value", JSON.stringify(invalidKeyword)],
    ["valid wrong result schema", '{"type":"string"}'],
    ["valid wrong command schema", readFileSync(join(assets.schemasPath, "repo-add.output.json"))],
    ["changed formatting", Buffer.concat([originalDoctor, Buffer.from("\n")])],
  ];
  try {
    for (const [name, content] of corruptAssets) {
      writeFileSync(doctorAsset, content);
      for (const args of [
        ["describe", "doctor", "--json"],
        ["describe", "--json"],
      ]) {
        const refused = runInstalled(args);
        assert.equal(refused.status, 1, name);
        assert.equal(refused.stdout, "", name);
        const failure = JSON.parse(refused.stderr);
        assert.equal(failure.ok, false, name);
        assert.equal(failure.command, "describe", name);
        assert.equal(failure.error.reason, "invalid-state", name);
        validateInstalled("describe", failure);
      }
    }
  } finally {
    writeFileSync(doctorAsset, originalDoctor);
  }
  assertSuccess(runInstalled(["describe", "--json"]), "restored installed schema identities");

  validateInstalled("skill path", JSON.parse(locations.stdout));
  for (const topic of ["overview", "commands", "recovery", "schemas"]) {
    const docs = runInstalled(["docs", topic, "--json"]);
    assertSuccess(docs, `installed docs ${topic}`);
    validateInstalled("docs", JSON.parse(docs.stdout));
    assert.ok(JSON.parse(docs.stdout).data.content.length > 100);
  }
  const exported = runInstalled(["skill", "export", join(smokeRoot, "exported"), "--json"]);
  assertSuccess(exported, "explicit skill export");
  const exportedData = JSON.parse(exported.stdout);
  validateInstalled("skill export", exportedData);
  const portable = exportedData.data.skillPath;
  assert.equal(readFileSync(portable, "utf8"), readFileSync(assets.skillPath, "utf8"));
  const refusal = runInstalled(["skill", "export", join(smokeRoot, "exported"), "--json"]);
  assert.equal(refusal.status, 1);
  assert.equal(refusal.stdout, "");
  validateInstalled("skill export", JSON.parse(refusal.stderr));
  assert.equal(readFileSync(portable, "utf8"), readFileSync(assets.skillPath, "utf8"));
  if (process.platform !== "win32") {
    const manLink = join(installPrefix, "share", "man", "man1", "outpost.1");
    assert.equal(realpathSync(manLink), realpathSync(join(installedPackage, "man", "outpost.1")));
  }

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
    "Unknown command: wat\nRun `outpost --help` to see available commands.\n"
  );

  console.log("Test: outpost wat --json (unknown command)");
  const unknownJsonResult = runInstalled(["wat", "--json"]);
  assert.equal(unknownJsonResult.status, 1);
  assert.equal(unknownJsonResult.stdout, "");
  assert.deepEqual(JSON.parse(unknownJsonResult.stderr), {
    ok: false,
    command: null,
    error: {
      reason: "invalid-arguments",
      retryable: false,
      action:
        "Use outpost describe <command> --json or outpost help <command> and correct the arguments.",
      code: "UNKNOWN_COMMAND",
      message: "Unknown command: wat",
    },
    exitCode: 1,
  });

  console.log("Test: installed command contract");
  const discovery = runInstalled(["describe", "create", "--json"]);
  assertSuccess(discovery, "installed describe");
  const contract = JSON.parse(discovery.stdout).data;
  assert.equal(contract.cliVersion, version);
  assert.equal(contract.contractVersion, "1.0.0");
  assert.equal(contract.network, "none");
  assert.ok(contract.inputSchema.properties.options.properties["--ticket"]);
  assert.ok(contract.outputSchema.anyOf.length >= 2);

  console.log("Test: duplicate --json");
  const duplicateJsonResult = runInstalled(["doctor", "--json", "--json"]);
  assert.equal(duplicateJsonResult.status, 1);
  assert.equal(duplicateJsonResult.stdout, "");
  assert.deepEqual(JSON.parse(duplicateJsonResult.stderr), {
    ok: false,
    command: "doctor",
    error: {
      reason: "invalid-arguments",
      retryable: false,
      action:
        "Use outpost describe <command> --json or outpost help <command> and correct the arguments.",
      code: "INVALID_ARGUMENT",
      message: "Usage: outpost <command> [options]\n--json may only be provided once.",
    },
    exitCode: 1,
  });

  console.log("Test: outpost create --json (missing args)");
  const createResult = runInstalled(["create", "--json"]);
  assert.equal(createResult.status, 1);
  assert.equal(createResult.stdout, "");
  const createError = JSON.parse(createResult.stderr);
  assert.equal(createError.ok, false);
  assert.equal(createError.exitCode, 1);
  assert.equal(createError.command, "create");
  assert.equal(createError.error.code, "CREATE_FAILED");
  assert.ok(createError.error.message.includes("Usage: outpost create"));
  assert.ok(createError.error.message.includes("--ticket is required."));
  assert.ok(createError.error.message.includes("--type is required."));
  assert.ok(createError.error.message.includes("At least one --repo is required."));

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
      2
    )}\n`
  );

  const partialResult = runInstalled(["repo", "fetch", "--all", "--json"], commandEnv);
  assert.equal(partialResult.status, 1);
  assert.equal(partialResult.stderr, "");
  const partialOutput = JSON.parse(partialResult.stdout);
  assert.equal(partialOutput.ok, false);
  assert.equal(partialOutput.command, "repo fetch");
  assert.equal(partialOutput.exitCode, 1);
  assert.equal(partialOutput.data.failedCount, 1);
  assert.equal(partialOutput.data.results[0].fetchStatus, "failed");
  validateInstalled("repo fetch", partialOutput);

  console.log("\nAll smoke tests passed.");
} finally {
  cleanup();
}
