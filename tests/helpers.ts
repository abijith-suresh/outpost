import { createRequire } from "node:module";
import os from "node:os";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, vi } from "vitest";

import { runCli } from "../src/index.ts";
import type { RepoRecord } from "../src/config.js";
import {
  encodeManagedPathSegment,
  getFileManagedPathSegments,
} from "../src/remote-identity.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };
const ORIGINAL_ENV = { ...process.env };

export {
  version,
  ORIGINAL_ENV,
  os,
  path,
  existsSync,
  mkdirSync,
  readFileSync,
  runCli,
  writeFileSync,
};

export function localRepoId(remotePath: string): string {
  const realPath = realpathSync(remotePath);
  const canonicalPath = realPath.endsWith(".git")
    ? realPath.slice(0, -4)
    : realPath;
  return pathToFileURL(canonicalPath).href;
}

export function localManagedRepoPath(
  tempHome: string,
  remotePathOrId: string,
): string {
  const id = remotePathOrId.startsWith("file://")
    ? remotePathOrId
    : localRepoId(remotePathOrId);
  const segments = getFileManagedPathSegments(id).map(encodeManagedPathSegment);
  const repoName = segments.pop() as string;

  return path.join(tempHome, "repos", ...segments, `${repoName}.git`);
}

export function localTransportUrl(remotePath: string): string {
  return pathToFileURL(realpathSync(remotePath)).href;
}

export function makeRepoRecord(repo: {
  id: string;
  managedRepoPath: string;
  name?: string;
  remoteName?: string;
  remoteUrl?: string;
  sourceRepoPath?: string;
  importedAt?: string;
  lastFetchedAt?: string;
}) {
  return {
    id: repo.id,
    importedAt: repo.importedAt ?? "2026-01-01T00:00:00.000Z",
    lastFetchedAt: repo.lastFetchedAt ?? "2026-01-01T00:00:00.000Z",
    managedRepoPath: repo.managedRepoPath,
    name: repo.name ?? repo.id,
    remoteName: repo.remoteName ?? "origin",
    remoteUrl: repo.remoteUrl ?? `https://example.com/${repo.id}.git`,
    sourceRepoPath: repo.sourceRepoPath ?? `/tmp/${repo.id}`,
  };
}

export async function initGitRepo(repoPath: string) {
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["init"], { cwd: repoPath });
}

export async function initBareGitRepo(repoPath: string) {
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["init", "--bare", repoPath]);
}

export async function addGitRemote(
  repoPath: string,
  remoteName: string,
  remotePath: string,
) {
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["remote", "add", remoteName, remotePath], {
    cwd: repoPath,
  });
}

export async function configureGitIdentity(repoPath: string) {
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["config", "user.name", "Outpost Test"], {
    cwd: repoPath,
  });
  execFileSync("git", ["config", "user.email", "outpost@example.com"], {
    cwd: repoPath,
  });
}

export async function commitFile(
  repoPath: string,
  fileName: string,
  contents: string,
  message: string,
) {
  const { execFileSync } = await import("node:child_process");
  writeFileSync(path.join(repoPath, fileName), contents);
  execFileSync("git", ["add", fileName], { cwd: repoPath });
  execFileSync("git", ["commit", "-m", message], { cwd: repoPath });
}

export async function pushBranch(
  repoPath: string,
  remoteName: string,
  branchName: string,
  extraArgs: ReadonlyArray<string> = [],
) {
  const { execFileSync } = await import("node:child_process");
  execFileSync(
    "git",
    ["push", ...extraArgs, remoteName, `HEAD:refs/heads/${branchName}`],
    { cwd: repoPath },
  );
}

export async function setBareRepoHead(repoPath: string, branchName: string) {
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["symbolic-ref", "HEAD", `refs/heads/${branchName}`], {
    cwd: repoPath,
  });
}

export async function createManagedRepoFixture(options?: {
  defaultBranch?: string;
  repoName?: string;
}) {
  const tempRepoRoot = createTempDir("outpost-create-repo-");
  const tempRepo = options?.repoName
    ? path.join(tempRepoRoot, options.repoName)
    : tempRepoRoot;
  const tempRemoteRoot = createTempDir("outpost-create-remote-");
  const tempRemote = path.join(
    tempRemoteRoot,
    `${path.basename(tempRepo)}.git`,
  );
  const defaultBranch = options?.defaultBranch ?? "main";

  mkdirSync(tempRepo, { recursive: true });
  await initBareGitRepo(tempRemote);
  await initGitRepo(tempRepo);
  await configureGitIdentity(tempRepo);
  await addGitRemote(tempRepo, "origin", tempRemote);
  await commitFile(
    tempRepo,
    "README.md",
    `# ${path.basename(tempRepoRoot)}\n`,
    "initial",
  );

  if (defaultBranch !== "master") {
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["branch", "-M", defaultBranch], { cwd: tempRepo });
  }

  await pushBranch(tempRepo, "origin", defaultBranch, ["-u"]);
  await setBareRepoHead(tempRemote, defaultBranch);

  return {
    defaultBranch,
    tempRemote,
    tempRepo,
  };
}

export async function currentBranch(repoPath: string) {
  const { execFileSync } = await import("node:child_process");
  return execFileSync("git", ["branch", "--show-current"], {
    cwd: repoPath,
    encoding: "utf8",
  }).trim();
}

export async function currentCommit(repoPath: string) {
  const { execFileSync } = await import("node:child_process");
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoPath,
    encoding: "utf8",
  }).trim();
}

export function restoreTtyProperty(
  stream: NodeJS.ReadStream | NodeJS.WriteStream,
  descriptor: PropertyDescriptor | undefined,
) {
  if (descriptor) {
    Object.defineProperty(stream, "isTTY", descriptor);
    return;
  }

  Reflect.deleteProperty(stream, "isTTY");
}

export function writeRegistry(tempHome: string, repos: RepoRecord[]): void {
  const registryPath = path.join(tempHome, "repos.json");
  const json = JSON.stringify({ repos }, null, 2);
  writeFileSync(registryPath, `${json}\n`);
}

export function readRegistry(tempHome: string): {
  repos: RepoRecord[];
} {
  const registryPath = path.join(tempHome, "repos.json");
  return JSON.parse(readFileSync(registryPath, "utf8"));
}

const tempDirsKey = "__outpost_temp_dirs__";

function getTempDirs(): Set<string> {
  if (!(globalThis as Record<string, unknown>)[tempDirsKey]) {
    (globalThis as Record<string, unknown>)[tempDirsKey] = new Set<string>();
  }
  return (globalThis as Record<string, unknown>)[tempDirsKey] as Set<string>;
}

export function trackTempDir(dir: string): string {
  getTempDirs().add(dir);
  return dir;
}

export function createTempDir(prefix = "outpost-test-"): string {
  return trackTempDir(mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function setupAfterEach(): void {
  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...ORIGINAL_ENV };
    const dirs = getTempDirs();
    for (const dir of dirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore cleanup failures
      }
    }
    dirs.clear();
  });
}
