import { createRequire } from "node:module";
import os from "node:os";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, vi } from "vitest";

import { runCli } from "../src/index.ts";
import type { RepoRecord } from "../src/config.js";

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
  writeFileSync,
  runCli,
};

export function sanitizeRemoteUrl(remoteUrl: string): string {
  return remoteUrl
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
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
  const timestamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const tempRepo = options?.repoName
    ? path.join(
        os.tmpdir(),
        `outpost-create-repo-${timestamp}`,
        options.repoName,
      )
    : path.join(os.tmpdir(), `outpost-create-repo-${timestamp}`);
  const tempRemote = path.join(
    os.tmpdir(),
    `outpost-create-remote-${timestamp}.git`,
  );
  const defaultBranch = options?.defaultBranch ?? "main";

  mkdirSync(tempRepo, { recursive: true });
  await initBareGitRepo(tempRemote);
  await initGitRepo(tempRepo);
  await configureGitIdentity(tempRepo);
  await addGitRemote(tempRepo, "origin", tempRemote);
  await commitFile(tempRepo, "README.md", `# ${timestamp}\n`, "initial");

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
  const json = JSON.stringify({ version: 1, repos }, null, 2);
  writeFileSync(registryPath, `${json}\n`);
}

export function readRegistry(tempHome: string): {
  version: number;
  repos: RepoRecord[];
} {
  const registryPath = path.join(tempHome, "repos.json");
  return JSON.parse(readFileSync(registryPath, "utf8"));
}

export function setupAfterEach(): void {
  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...ORIGINAL_ENV };
  });
}
