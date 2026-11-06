import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { verifyInstalledRuntime } from "../apps/cli/scripts/runtime-dependencies.mjs";
import { runNpm } from "./npm-command.mjs";
import { withNpmInstallDiagnostics } from "./npm-install-diagnostics.mjs";
import { preparationPhase as phase, preparationDiagnostic } from "./prerelease-diagnostics.mjs";
import { makeBuildIdentity, validateBuildIdentity } from "./prerelease-identity.mjs";

const gitEnvironment = () => {
  for (const key of Object.keys(process.env))
    if (
      /^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG|REPLACE_REF_BASE)(?:$|_)/.test(
        key
      )
    )
      throw new Error("Remove inherited Git location/config overrides before preparation.");
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1",
  };
};
export function installationPath(value) {
  if (typeof value !== "string" || !isAbsolute(value))
    throw new Error("Supply an absolute new destination.");
  if (
    process.platform === "win32" &&
    (/[&%^!]/.test(value) || [...value].some((c) => c.charCodeAt(0) < 32))
  )
    throw new Error("Windows npm launcher paths cannot contain &, %, ^, ! or controls.");
  return resolve(value);
}

const packages = [{ name: "@abijith-suresh/outpost", directory: "apps/cli" }];
const CONSUMER = {
  name: "outpost-candidate-consumer",
  version: "0.0.0",
  private: true,
  type: "module",
};
const COHORT = {
  "@effect/platform-node": "4.0.6",
  "@effect/platform-node-shared": "4.0.6",
  effect: "4.0.6",
};
function runtimeGraph(lock) {
  const graph = {};
  const visit = (name) => {
    const path = `node_modules/${name}`;
    if (graph[path]) return;
    const entry = lock.packages[path];
    if (
      !entry ||
      entry.link ||
      !/^https:\/\/registry.npmjs.org\//.test(entry.resolved) ||
      !/^sha512-[A-Za-z0-9+/]{86}==$/.test(entry.integrity)
    )
      invalid("Unsupported runtime lock entry.");
    graph[path] = { ...entry };
    delete graph[path].dev;
    delete graph[path].devOptional;
    for (const dependency of Object.keys({ ...entry.dependencies, ...entry.peerDependencies })) {
      if (!entry.peerDependenciesMeta?.[dependency]?.optional) visit(dependency);
    }
    if (entry.optionalDependencies)
      invalid("Optional runtime dependencies need explicit preparation support.");
  };
  for (const name of Object.keys(COHORT)) visit(name);
  return graph;
}
function validateRepository(root) {
  const metadata = json(join(root, "apps/cli/package.json"));
  if (metadata.name !== packages[0].name || !isDeepStrictEqual(metadata.dependencies, COHORT))
    invalid("Unexpected public/runtime package graph.");
  const runtime = runtimeGraph(json(join(root, "package-lock.json")));
  for (const [name, version] of Object.entries(COHORT))
    if (runtime[`node_modules/${name}`].version !== version) invalid("Unexpected runtime cohort.");
  return { manifests: [metadata], runtime };
}

const REQUIREMENTS = { node: ">=24.19.0 <25", npm: "11.16.0" };
const MAX_FILE = 16 * 1024 * 1024;
const MAX_TOTAL = 128 * 1024 * 1024;
const MAX_FILES = 8192;
const invalid = (message = "Invalid prerelease artifact.") => {
  throw new Error(message);
};
const hash = (data, algorithm = "sha256") => createHash(algorithm).update(data).digest("hex");
const integrity = (data) => `sha512-${createHash("sha512").update(data).digest("base64")}`;
const json = (file) => JSON.parse(readBounded(file).toString("utf8"));
const encode = (value) => `${JSON.stringify(value, null, 2)}\n`;
const keys = (value, expected) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort());
const safePath = (value) =>
  typeof value === "string" &&
  value.length <= 512 &&
  !value.includes("\\") &&
  [...value].every(
    (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127
  ) &&
  !value.startsWith("/") &&
  value.split("/").every((part) => part && part !== "." && part !== ".." && !part.includes(":"));
const publicPath = (value) =>
  safePath(value) &&
  (value === "package.json" ||
    /^(?:readme|license)(?:\.[a-z0-9]+)?$/i.test(value) ||
    /^(?:dist|skills|man|schemas)\//.test(value));
function readBounded(file, limit = MAX_FILE) {
  const observed = lstatSync(file);
  if (!observed.isFile()) invalid();
  const descriptor = openSync(
    file,
    constants.O_RDONLY |
      (process.platform === "win32" ? 0 : constants.O_NONBLOCK | constants.O_NOFOLLOW)
  );
  try {
    const stat = fstatSync(descriptor);
    if (
      !stat.isFile() ||
      stat.size > limit ||
      stat.dev !== observed.dev ||
      stat.ino !== observed.ino
    )
      invalid();
    // One extra byte detects a file growing after stat without an unbounded read.
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(descriptor, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    const after = fstatSync(descriptor);
    if (length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs)
      invalid();
    return bytes.subarray(0, length);
  } finally {
    closeSync(descriptor);
  }
}
const invoke = (args, cwd) =>
  runNpm(args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: 180000,
    maxBuffer: MAX_TOTAL,
    stdio: ["ignore", "pipe", "pipe"],
  });
const git = (root, args, options = {}) => {
  const settings = {
    cwd: root,
    env: gitEnvironment(),
    windowsHide: true,
    maxBuffer: MAX_TOTAL,
    timeout: 30000,
    stdio: ["pipe", "pipe", "pipe"],
    ...options,
  };
  const prefix = ["-c", "core.fsmonitor=false", "-c", "protocol.allow=never"];
  // Older supported system Git may ignore GIT_NO_LAZY_FETCH. Refuse promisor
  // configuration before object inspection rather than relying on that variable.
  try {
    execFileSync(
      "git",
      [
        ...prefix,
        "config",
        "--name-only",
        "--get-regexp",
        "^(extensions\\.partialclone|remote\\..*\\.promisor)$",
      ],
      {
        ...settings,
        input: undefined,
        encoding: "utf8",
        maxBuffer: MAX_FILE,
      }
    );
  } catch (error) {
    if (error.status !== 1) throw error;
    return execFileSync("git", [...prefix, ...args], settings);
  }
  invalid(
    "Partial-clone/promisor source configuration is unsupported; use a complete local checkout."
  );
};

function toolchain() {
  if (
    process.versions.node !== "24.22.1" ||
    invoke(["--version"], process.cwd()).trim() !== REQUIREMENTS.npm
  )
    invalid("Preparation requires Node 24.22.1 and repository-pinned npm 11.16.0.");
}
function outside(directory, root) {
  const part = relative(root, directory);
  return part !== "" && (part === ".." || part.startsWith(`..${sep}`) || isAbsolute(part));
}
const ownedDirectories = new Map();
function own(directory) {
  const state = lstatSync(directory, { bigint: true });
  if (!state.isDirectory() || state.isSymbolicLink())
    invalid("Owned directory identity unavailable.");
  ownedDirectories.set(directory, {
    dev: state.dev,
    ino: state.ino,
    real: realpathSync.native(directory),
  });
  return directory;
}
function removeOwned(directory) {
  return phase("owned-cleanup", () => removeOwnedOperation(directory));
}
function removeOwnedOperation(directory) {
  const expected = ownedDirectories.get(directory);
  const state = lstatSync(directory, { bigint: true });
  if (
    !expected ||
    !state.isDirectory() ||
    state.isSymbolicLink() ||
    state.dev !== expected.dev ||
    state.ino !== expected.ino ||
    realpathSync.native(directory) !== expected.real
  )
    invalid("Directory identity changed; preserve residue for manual inspection.");
  rmSync(directory, { recursive: true, force: true });
}
export function preserveFixture(error) {
  return (
    error?.constructor?.name === "ManagerFixtureCleanupError" ||
    (error?.cause && preserveFixture(error.cause))
  );
}
function createDestination(destination, forbiddenRoot) {
  let directory = installationPath(destination);
  directory = installationPath(join(realpathSync(dirname(directory)), basename(directory)));
  if (forbiddenRoot && !outside(directory, realpathSync(forbiddenRoot)))
    invalid("Choose a new destination outside the source repository.");
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    invalid(
      error.code === "EEXIST"
        ? "The destination already exists. Choose a new directory."
        : "Cannot create the destination directory."
    );
  }
  return own(directory);
}

export const validatePreparationIdentity = makeBuildIdentity;
export function validateDispatch(context) {
  if (!context || ![undefined, false, "false"].includes(context.publishRequested))
    invalid("Publication is disabled: no owner-controlled publication gate is configured.");
  const identity = validateBuildIdentity(context.identity);
  if (
    context.eventName !== "workflow_dispatch" ||
    context.repository !== "abijith-suresh/outpost" ||
    context.ref !== "refs/heads/main" ||
    context.sourceSha !== identity.sourceSha ||
    context.checkedOutSha !== identity.sourceSha
  )
    invalid("Prerelease dispatch must use the trusted main revision and repository.");
  return identity;
}

/** Export one bounded Git object snapshot; never switch or modify the bound checkout. */
export function snapshotCommit(...args) {
  return phase("snapshot", () => snapshotCommitOperation(...args));
}
function snapshotCommitOperation(root, directory, sha) {
  if (typeof sha !== "string" || !/^[a-f0-9]{40}$/.test(sha) || /^0+$/.test(sha))
    invalid("Supply a full source commit SHA.");
  if (git(root, ["rev-parse", "--verify", `${sha}^{commit}`], { encoding: "utf8" }).trim() !== sha)
    invalid("Source SHA must identify a commit.");
  const records = git(root, ["ls-tree", "-rz", "--full-tree", sha])
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  if (!records.length || records.length > MAX_FILES)
    invalid("Source snapshot exceeds its file bound.");
  const entries = records.map((record) => {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(record);
    if (!match || !safePath(match[3]))
      invalid("Source snapshot contains unsupported paths or file types.");
    return { mode: match[1], oid: match[2], path: match[3] };
  });
  const contents = git(root, ["cat-file", "--batch"], {
    input: `${entries.map((entry) => entry.oid).join("\n")}\n`,
  });
  let cursor = 0,
    total = 0;
  for (const entry of entries) {
    const end = contents.indexOf(10, cursor);
    if (end < cursor) invalid();
    const match = /^([a-f0-9]{40}) blob ([0-9]+)$/.exec(
      contents.subarray(cursor, end).toString("ascii")
    );
    const size = Number(match?.[2]);
    total += size;
    if (
      !match ||
      match[1] !== entry.oid ||
      !Number.isSafeInteger(size) ||
      size > MAX_FILE ||
      total > MAX_TOTAL ||
      end + size + 1 >= contents.length ||
      contents[end + size + 1] !== 10
    )
      invalid("Source snapshot exceeds its content bound.");
    const file = join(directory, entry.path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents.subarray(end + 1, end + 1 + size));
    chmodSync(file, entry.mode === "100755" ? 0o755 : 0o644);
    cursor = end + size + 2;
  }
  if (cursor !== contents.length) invalid();
}

export function validateManifest(value) {
  if (
    !keys(value, [
      "schemaVersion",
      "build",
      "tag",
      "publication",
      "requirements",
      "runtime",
      "packages",
    ]) ||
    value.schemaVersion !== 1 ||
    value.publication !== "disabled" ||
    !isDeepStrictEqual(value.requirements, REQUIREMENTS)
  )
    invalid();
  const build = validateBuildIdentity(value.build);
  if (
    !value.runtime ||
    Object.keys(value.runtime).length > 32 ||
    !isDeepStrictEqual(runtimeGraph({ packages: value.runtime }), value.runtime)
  )
    invalid("Invalid runtime closure.");
  for (const [name, version] of Object.entries(COHORT))
    if (value.runtime[`node_modules/${name}`]?.version !== version)
      invalid("Invalid runtime cohort.");
  if (
    value.tag !== build.channel ||
    !Array.isArray(value.packages) ||
    value.packages.length !== packages.length
  )
    invalid();
  const filenames = new Set();
  let total = 0;
  for (const [index, pkg] of value.packages.entries()) {
    if (
      !keys(pkg, ["name", "version", "filename", "sha256", "integrity", "files"]) ||
      pkg.name !== packages[index].name ||
      pkg.version !== build.version ||
      typeof pkg.filename !== "string" ||
      !/^[a-zA-Z0-9._-]{1,200}\.tgz$/.test(pkg.filename) ||
      filenames.has(pkg.filename) ||
      !/^[a-f0-9]{64}$/.test(pkg.sha256) ||
      !/^sha512-[A-Za-z0-9+/]{86}==$/.test(pkg.integrity) ||
      !Array.isArray(pkg.files) ||
      !pkg.files.length ||
      pkg.files.length > MAX_FILES
    )
      invalid();
    filenames.add(pkg.filename);
    const paths = new Set();
    for (const file of pkg.files) {
      total += file.size;
      if (
        !keys(file, ["path", "size", "sha256"]) ||
        !publicPath(file.path) ||
        paths.has(file.path) ||
        !Number.isSafeInteger(file.size) ||
        file.size < 0 ||
        file.size > MAX_FILE ||
        total > MAX_TOTAL ||
        !/^[a-f0-9]{64}$/.test(file.sha256)
      )
        invalid();
      paths.add(file.path);
    }
    if (!paths.has("package.json")) invalid();
  }
  return value;
}
const sums = (manifest, manifestBytes) =>
  `${[
    ...manifest.packages.map((pkg) => `${pkg.sha256}  ${pkg.filename}`),
    `${hash(manifestBytes)}  manifest.json`,
  ].join("\n")}\n`;
export function verifyPrepared(...args) {
  return phase("bundle-verify", () => verifyPreparedOperation(...args));
}
function verifyPreparedOperation(directory) {
  const bytes = readBounded(join(directory, "manifest.json"));
  const manifest = validateManifest(JSON.parse(bytes.toString("utf8")));
  const expected = [
    "manifest.json",
    "SHA256SUMS",
    ...manifest.packages.map((pkg) => pkg.filename),
  ].sort();
  if (!isDeepStrictEqual(readdirSync(directory).sort(), expected))
    invalid("Artifact directory contains unexpected files.");
  for (const pkg of manifest.packages) {
    const bytes = readBounded(join(directory, pkg.filename), MAX_TOTAL);
    if (hash(bytes) !== pkg.sha256 || integrity(bytes) !== pkg.integrity)
      invalid("Artifact checksum verification failed.");
  }
  if (readBounded(join(directory, "SHA256SUMS")).toString("utf8") !== sums(manifest, bytes))
    invalid("Artifact checksum manifest verification failed.");
  return manifest;
}
function installedFiles(directory, prefix = "", budget = { count: 0 }) {
  if (prefix.split("/").length > 32) invalid();
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (++budget.count > MAX_FILES) invalid();
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory())
      result.push(...installedFiles(join(directory, entry.name), path, budget));
    else if (entry.isFile()) result.push(path);
    else invalid("Installed package contains an unsupported file type.");
  }
  return result.sort();
}
export function verifyInstalledContents(directory, manifest) {
  validateManifest(manifest);
  for (const pkg of manifest.packages) {
    const home = join(directory, "node_modules", pkg.name);
    if (lstatSync(home).isSymbolicLink())
      invalid("Installed package must not link to a workspace.");
    if (!isDeepStrictEqual(installedFiles(home), pkg.files.map((file) => file.path).sort()))
      invalid("Installed package file list differs from the prepared artifact.");
    for (const file of pkg.files) {
      const bytes = readBounded(join(home, file.path));
      if (bytes.length !== file.size || hash(bytes) !== file.sha256)
        invalid("Installed package content verification failed.");
    }
    const metadata = json(join(home, "package.json"));
    if (
      metadata.name !== pkg.name ||
      metadata.version !== manifest.build.version ||
      !isDeepStrictEqual(metadata.outpostBuild, manifest.build) ||
      metadata.private !== true ||
      metadata.publishConfig !== undefined ||
      metadata.scripts !== undefined
    )
      invalid("Installed package metadata differs from the prepared build.");
    if (!isDeepStrictEqual(metadata.dependencies, COHORT) || metadata.devDependencies !== undefined)
      invalid("Installed dependency graph differs from prepared graph.");
    for (const section of [
      "dependencies",
      "optionalDependencies",
      "peerDependencies",
      "devDependencies",
    ]) {
      for (const [name, version] of Object.entries(metadata[section] ?? {})) {
        if (
          name.startsWith("@outpost/") &&
          (!packages.some((candidate) => candidate.name === name) ||
            version !== manifest.build.version)
        )
          invalid("Installed internal dependencies must match the exact build version.");
      }
    }
  }
  const lock = json(join(directory, "package-lock.json"));
  for (const [path, expected] of Object.entries(manifest.runtime)) {
    if (!isDeepStrictEqual(lock.packages[path], expected))
      invalid("Runtime dependency lock differs from prepared graph.");
    const metadata = json(join(directory, path, "package.json"));
    if (metadata.version !== expected.version)
      invalid("Installed runtime version differs from lock.");
  }
  verifyInstalledRuntime(join(directory, "node_modules", packages[0].name));
}
export function installPrepared(...args) {
  return phase("consumer-install", () => installPreparedOperation(...args));
}
function installPreparedOperation(bundle, destination, expectedSha) {
  const manifest = verifyPrepared(bundle);
  if (manifest.build.sourceSha !== expectedSha)
    invalid("Bundle does not match the approved source SHA.");
  toolchain();
  const directory = createDestination(
    destination,
    resolve(dirname(fileURLToPath(import.meta.url)), "..")
  );
  try {
    mkdirSync(join(directory, "artifacts"));
    manifest.packages.map((pkg) => {
      const target = join(directory, "artifacts", pkg.filename);
      copyFileSync(join(bundle, pkg.filename), target);
      return target;
    });
    const pkg = manifest.packages[0];
    const dependency = `file:artifacts/${pkg.filename}`;
    writeFileSync(
      join(directory, "package.json"),
      encode({ ...CONSUMER, dependencies: { [pkg.name]: dependency } })
    );
    writeFileSync(
      join(directory, "package-lock.json"),
      encode({
        name: CONSUMER.name,
        version: CONSUMER.version,
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": {
            name: CONSUMER.name,
            version: CONSUMER.version,
            dependencies: { [pkg.name]: dependency },
          },
          [`node_modules/${pkg.name}`]: {
            version: manifest.build.version,
            resolved: dependency,
            integrity: pkg.integrity,
            dependencies: COHORT,
            bin: { outpost: "dist/cli.js" },
            engines: { node: REQUIREMENTS.node },
          },
          ...manifest.runtime,
        },
      })
    );
    phase("consumer-dependencies", () =>
      invoke(["ci", "--ignore-scripts", "--no-audit", "--no-fund"], directory)
    );
    phase("installed-bytes", () => verifyInstalledContents(directory, manifest));
    const cli = join(directory, "node_modules", "@abijith-suresh", "outpost", "dist", "cli.js");
    const run = (args) =>
      execFileSync(process.execPath, [cli, ...args], {
        cwd: directory,
        encoding: "utf8",
        windowsHide: true,
        timeout: 10000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, OUTPOST_HOME: "invalid-relative-home" },
        stdio: ["ignore", "pipe", "pipe"],
      });
    // Offline identity is inert JSON shipped in the verified package, never a process or network probe.
    const info = json(
      join(directory, "node_modules", packages[0].name, "dist", "build-receipt.json")
    );
    if (!isDeepStrictEqual(info, manifest.build)) invalid("Installed build receipt differs.");
    phase("installed-version", () => {
      if (run(["--version"]).trim() !== manifest.build.version)
        invalid("Installed version verification failed.");
    });
    const binDirectory = join(directory, "node_modules", ".bin");
    const executable = join(binDirectory, process.platform === "win32" ? "outpost.cmd" : "outpost");
    if (!existsSync(executable)) invalid("Installed CLI launcher is missing.");
    return {
      directory,
      executable,
      cli,
      binDirectory,
      version: manifest.build.version,
      build: manifest.build,
    };
  } catch (error) {
    if (!preserveFixture(error)) removeOwned(directory);
    throw new Error("Prerelease installation failed; its partial directory was removed.", {
      cause: error,
    });
  }
}

/** Inspect source bytes without conversion filters, status refresh or index writes. */
export function sourceFingerprint(root) {
  const digest = createHash("sha256");
  const add = (value) => digest.update(`${JSON.stringify(value)}\n`);
  let total = 0;
  const inspect = (file, label, allowMissing = false) => {
    let before;
    try {
      before = lstatSync(file, { bigint: true });
    } catch (error) {
      if (allowMissing && error.code === "ENOENT") {
        add([label, "absent"]);
        return;
      }
      throw error;
    }
    if (!before.isFile() || before.isSymbolicLink())
      invalid("Source fingerprint requires regular files and unaliased directories.");
    total += Number(before.size);
    if (total > MAX_TOTAL) invalid("Source fingerprint exceeds its content bound.");
    const bytes = readBounded(file);
    const after = lstatSync(file, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs
    )
      invalid("Source changed during fingerprint inspection.");
    add([
      label,
      String(before.dev),
      String(before.ino),
      String(before.mode),
      String(before.mtimeNs),
      hash(bytes),
    ]);
  };
  const directory = (path, label) => {
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink())
      invalid("Source fingerprint requires unaliased directories.");
    add([label, String(stat.dev), String(stat.ino), realpathSync.native(path)]);
  };
  directory(root, "source-root");
  const top = git(root, ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  if (realpathSync.native(top) !== realpathSync.native(root))
    invalid("Preparation must run from the bound repository root.");
  add(git(root, ["rev-parse", "HEAD"], { encoding: "utf8" }));
  add(
    git(root, ["for-each-ref", "--format=%(refname) %(objectname) %(symref)"], { encoding: "utf8" })
  );
  for (const name of ["HEAD", "index", "packed-refs"]) {
    const path = git(root, ["rev-parse", "--path-format=absolute", "--git-path", name], {
      encoding: "utf8",
    }).trim();
    inspect(path, `git:${name}`, true);
  }
  // Reading a split index through Git can freshen sharedindex.* even with
  // optional locks disabled. Inspect its storage directly, never via ls-files.
  const indexPath = git(root, ["rev-parse", "--path-format=absolute", "--git-path", "index"], {
    encoding: "utf8",
  }).trim();
  const metadata = readdirSync(dirname(indexPath));
  if (metadata.length > MAX_FILES) invalid("Source metadata exceeds its entry bound.");
  for (const name of metadata.filter((name) => /^sharedindex\.[a-f0-9]{40}$/.test(name)).sort())
    inspect(join(dirname(indexPath), name), `git:${name}`);
  const committed = git(root, ["ls-tree", "-rz", "--name-only", "HEAD"])
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  const selected = new Set(committed);
  const generated = new Set(["node_modules", "dist", "coverage", ".astro"]);
  let entries = 0;
  const walk = (path, prefix = "", depth = 0) => {
    if (depth > 32) invalid("Source fingerprint exceeds its depth bound.");
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (++entries > MAX_FILES) invalid("Source fingerprint exceeds its entry bound.");
      if (entry.name === ".git" || (entry.isDirectory() && generated.has(entry.name))) continue;
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(path, entry.name), name, depth + 1);
      else selected.add(name);
    }
  };
  walk(root);
  const files = [...selected].sort();
  if (files.length > MAX_FILES) invalid("Source fingerprint exceeds its file bound.");
  const parents = new Set();
  for (const file of files) {
    if (!safePath(file)) invalid("Unsupported source fingerprint path.");
    const parts = file.split("/");
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join("/");
      if (!parents.has(parent)) {
        directory(join(root, parent), parent);
        parents.add(parent);
      }
    }
    inspect(join(root, file), file, true);
  }
  return digest.digest("hex");
}

export async function preparePrerelease(root, destination, input, options = {}) {
  const identity = validateBuildIdentity(input);
  if (
    ![undefined, false, "false"].includes(options.publish) ||
    (process.env.OUTPOST_PRERELEASE_PUBLISH_REQUESTED &&
      process.env.OUTPOST_PRERELEASE_PUBLISH_REQUESTED !== "false")
  )
    invalid("Publication is disabled.");
  phase("toolchain", toolchain);
  const before = phase("source-before", () => sourceFingerprint(root));
  const directory = phase("destination", () => createDestination(destination, root));
  let temporary;
  let preserve = false;
  try {
    temporary = own(mkdtempSync(join(tmpdir(), "outpost-prerelease-")));
    const snapshot = join(temporary, "source");
    mkdirSync(snapshot);
    snapshotCommit(root, snapshot, identity.sourceSha);
    const { manifests, runtime } = phase("source-manifest", () => validateRepository(snapshot));
    if (manifests[0].version !== identity.sourceVersion)
      invalid("Build source version differs from the selected commit.");
    phase("snapshot-install", () =>
      withNpmInstallDiagnostics(temporary, (diagnosticArgs) =>
        invoke(["ci", "--ignore-scripts", "--no-audit", "--no-fund", ...diagnosticArgs], snapshot)
      )
    );
    const sourceMetadata = manifests[0];
    sourceMetadata.version = identity.version;
    sourceMetadata.outpostBuild = identity;
    writeFileSync(join(snapshot, "apps/cli/package.json"), encode(sourceMetadata));
    phase("build", () => invoke(["run", "build", "--workspace", packages[0].name], snapshot));
    writeFileSync(join(snapshot, "apps/cli/dist/build-receipt.json"), encode(identity));
    const prepared = [];
    for (const pkg of packages) {
      const [listing] = phase("package-list", () =>
        JSON.parse(
          invoke(
            ["pack", "--dry-run", "--json", "--ignore-scripts", "--workspace", pkg.name],
            snapshot
          )
        )
      );
      if (
        listing.name !== pkg.name ||
        !Array.isArray(listing.files) ||
        listing.files.length > MAX_FILES
      )
        invalid();
      const stage = phase("package-stage", () => {
        const stage = join(temporary, `package-${prepared.length}`);
        mkdirSync(stage);
        for (const file of listing.files) {
          if (!publicPath(file.path)) invalid("Public package includes an unsupported path.");
          const source = join(snapshot, pkg.directory, file.path);
          const bytes = readBounded(source);
          mkdirSync(dirname(join(stage, file.path)), { recursive: true });
          writeFileSync(join(stage, file.path), bytes);
          chmodSync(join(stage, file.path), lstatSync(source).mode & 0o777);
        }
        const metadata = json(join(stage, "package.json"));
        metadata.version = identity.version;
        metadata.outpostBuild = identity;
        metadata.private = true;
        delete metadata.publishConfig;
        delete metadata.devDependencies;
        delete metadata.scripts;
        for (const section of [
          "dependencies",
          "optionalDependencies",
          "peerDependencies",
          "devDependencies",
        ]) {
          for (const name of Object.keys(metadata[section] ?? {}))
            if (packages.some((item) => item.name === name))
              metadata[section][name] = identity.version;
        }
        writeFileSync(join(stage, "package.json"), encode(metadata));
        return stage;
      });
      const [packed] = phase("package-pack", () =>
        JSON.parse(
          invoke(["pack", "--json", "--ignore-scripts", "--pack-destination", directory], stage)
        )
      );
      if (
        packed.name !== pkg.name ||
        packed.version !== identity.version ||
        !/^[a-zA-Z0-9._-]{1,200}\.tgz$/.test(packed.filename) ||
        !Array.isArray(packed.files)
      )
        invalid();
      const bytes = readBounded(join(directory, packed.filename), MAX_TOTAL);
      if (packed.integrity !== integrity(bytes)) invalid();
      const files = packed.files
        .map((file) => {
          if (!publicPath(file.path)) invalid();
          const bytes = readBounded(join(stage, file.path));
          return { path: file.path, size: bytes.length, sha256: hash(bytes) };
        })
        .sort((a, b) => a.path.localeCompare(b.path));
      prepared.push({
        name: pkg.name,
        version: identity.version,
        filename: packed.filename,
        sha256: hash(bytes),
        integrity: integrity(bytes),
        files,
      });
    }
    const { manifest, bytes } = phase("manifest-write", () => {
      const manifest = validateManifest({
        schemaVersion: 1,
        build: identity,
        tag: identity.channel,
        publication: "disabled",
        requirements: REQUIREMENTS,
        runtime,
        packages: prepared,
      });
      const bytes = Buffer.from(encode(manifest));
      writeFileSync(join(directory, "manifest.json"), bytes);
      writeFileSync(join(directory, "SHA256SUMS"), sums(manifest, bytes));
      return { manifest, bytes };
    });
    verifyPrepared(directory);
    const installation = installPrepared(
      directory,
      join(temporary, "consumer install é"),
      identity.sourceSha
    );
    await phase("lifecycle", () => options.checkInstalled?.(installation, manifest));
    phase("source-after", () => {
      if (sourceFingerprint(root) !== before) invalid("Preparation changed the source checkout.");
    });
    return { directory, manifestSha256: hash(bytes), manifest };
  } catch (error) {
    preserve = preserveFixture(error);
    if (!preserve) phase("artifact-cleanup", () => removeOwned(directory));
    throw new Error("Prerelease preparation failed; its partial artifact directory was removed.", {
      cause: error,
    });
  } finally {
    if (temporary && !preserve) phase("scratch-cleanup", () => removeOwned(temporary));
    phase("source-finalizer", () => {
      if (sourceFingerprint(root) !== before) {
        if (existsSync(directory) && !preserve) removeOwned(directory);
        invalid("Preparation changed the source checkout; the output was removed.");
      }
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void (async () => {
    try {
      const values = {};
      const args = process.argv.slice(2);
      for (let i = 0; i < args.length; i++) {
        const name = args[i];
        if (name === "--dispatch" && values[name] === undefined) {
          values[name] = true;
          continue;
        }
        if (
          !["--output", "--channel", "--source-sha", "--date", "--run-id", "--attempt"].includes(
            name
          ) ||
          Object.hasOwn(values, name) ||
          !args[i + 1] ||
          args[i + 1].startsWith("--")
        )
          invalid("Invalid preparation arguments.");
        values[name] = args[++i];
      }
      if (!values["--output"]) invalid("Supply --output with a new absolute artifact directory.");
      const root = process.cwd();
      if (
        !/^[a-f0-9]{40}$/.test(values["--source-sha"] ?? "") ||
        /^0+$/.test(values["--source-sha"])
      )
        invalid("Supply a full source commit SHA.");
      const sourceVersion = phase(
        "source-identity",
        () =>
          JSON.parse(
            git(root, ["show", `${values["--source-sha"]}:apps/cli/package.json`], {
              encoding: "utf8",
            })
          ).version
      );
      const identity = makeBuildIdentity({
        sourceSha: values["--source-sha"],
        sourceVersion,
        channel: values["--channel"],
        date: values["--date"],
        runId: values["--run-id"],
        attempt: values["--attempt"],
      });
      if (
        process.env.OUTPOST_PRERELEASE_PUBLISH_REQUESTED &&
        process.env.OUTPOST_PRERELEASE_PUBLISH_REQUESTED !== "false"
      )
        invalid("Publication is disabled: no owner-controlled publication gate is configured.");
      if (values["--dispatch"]) {
        validateDispatch({
          eventName: process.env.GITHUB_EVENT_NAME,
          repository: process.env.GITHUB_REPOSITORY,
          ref: process.env.GITHUB_REF,
          sourceSha: process.env.GITHUB_SHA,
          checkedOutSha: git(root, ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
          identity,
          publishRequested: process.env.OUTPOST_PRERELEASE_PUBLISH_REQUESTED,
        });
        git(root, ["merge-base", "--is-ancestor", identity.sourceSha, "origin/main"]);
      }
      const { checkInstalledPrerelease } = await import("./check-prerelease.mjs");
      const result = await preparePrerelease(root, values["--output"], identity, {
        checkInstalled: (installation, manifest) =>
          checkInstalledPrerelease(installation, manifest),
      });
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } catch (error) {
      preparationDiagnostic("prepare-cli", "failure", error);
      process.stderr.write(
        "Prerelease preparation failed. Publication remains disabled; inspect the selected source, arguments, pinned toolchain and registry/cache availability.\n"
      );
      process.exitCode = 1;
    }
  })();
}
