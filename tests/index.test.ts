import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../src/index.ts";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

const ORIGINAL_ENV = { ...process.env };

function sanitizeRemoteUrl(remoteUrl: string): string {
  return remoteUrl
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...ORIGINAL_ENV };
});

describe("run", () => {
  it("prints help with no arguments", async () => {
    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const exitCode = await runCli([]);

    expect(exitCode).toBe(0);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy.mock.calls[0]?.[0]).toContain("Usage:");
  });

  it("prints the current version", async () => {
    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["--version"]);

    expect(exitCode).toBe(0);
    expect(infoSpy).toHaveBeenCalledWith(version);
  });

  it("prints doctor output", async () => {
    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["doctor"]);

    expect(exitCode).toBe(0);
    expect(infoSpy).toHaveBeenNthCalledWith(1, "outpost doctor");
    expect(infoSpy).toHaveBeenNthCalledWith(2, "status: ok");
  });

  it("prints doctor output as json", async () => {
    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["doctor", "--json"]);

    expect(exitCode).toBe(0);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy.mock.calls[0]?.[0]).toContain('"command": "doctor"');
  });

  it("initializes outpost home and worktrees root", async () => {
    const tempHome = path.join(os.tmpdir(), `outpost-test-${Date.now()}`);
    process.env.OUTPOST_HOME = tempHome;

    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["init"]);

    expect(exitCode).toBe(0);
    expect(infoSpy).toHaveBeenNthCalledWith(1, "outpost init");
    expect(infoSpy).toHaveBeenNthCalledWith(2, `outpost home: ${tempHome}`);
    expect(infoSpy).toHaveBeenNthCalledWith(
      3,
      `repos root: ${path.join(tempHome, "repos")}`,
    );
    expect(infoSpy).toHaveBeenNthCalledWith(
      4,
      `worktrees root: ${path.join(tempHome, "worktrees")}`,
    );
  });

  it("imports the current repo into the managed bare repo store", async () => {
    const tempHome = path.join(os.tmpdir(), `outpost-test-${Date.now()}`);
    const tempRepo = path.join(os.tmpdir(), `outpost-repo-${Date.now()}`);
    const tempRemote = path.join(
      os.tmpdir(),
      `outpost-remote-${Date.now()}.git`,
    );
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    const { mkdirSync } = await import("node:fs");
    mkdirSync(tempRepo, { recursive: true });

    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["init", "--bare", tempRemote]);
    execFileSync("git", ["init"], { cwd: tempRepo });
    execFileSync("git", ["remote", "add", "origin", tempRemote], {
      cwd: tempRepo,
    });

    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["repo", "add", tempRepo]);
    const expectedManagedRepoPath = path.join(
      tempHome,
      "repos",
      `${sanitizeRemoteUrl(tempRemote)}.git`,
    );

    expect(exitCode).toBe(0);
    expect(infoSpy).toHaveBeenNthCalledWith(1, "outpost repo add");
    expect(infoSpy).toHaveBeenNthCalledWith(2, `source repo path: ${tempRepo}`);
    expect(infoSpy).toHaveBeenNthCalledWith(3, "remote name: origin");
    expect(infoSpy).toHaveBeenNthCalledWith(4, `remote url: ${tempRemote}`);
    expect(infoSpy).toHaveBeenNthCalledWith(
      5,
      `repo name: ${path.basename(tempRepo)}`,
    );
    expect(infoSpy).toHaveBeenNthCalledWith(
      6,
      `managed repo path: ${expectedManagedRepoPath}`,
    );
    expect(infoSpy).toHaveBeenNthCalledWith(7, "action: cloned");
    expect(infoSpy).toHaveBeenNthCalledWith(8, "ready: true");
  });

  it("returns an error when repo add is run before init", async () => {
    const tempHome = path.join(os.tmpdir(), `outpost-test-${Date.now()}`);
    const tempRepo = path.join(os.tmpdir(), `outpost-repo-${Date.now()}`);
    process.env.OUTPOST_HOME = tempHome;

    const { mkdirSync } = await import("node:fs");
    mkdirSync(tempRepo, { recursive: true });

    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["repo", "add", tempRepo]);

    expect(exitCode).toBe(1);
    expect(errorSpy).toHaveBeenNthCalledWith(
      1,
      `Unknown command: Outpost is not initialized at ${tempHome}`,
    );
  });

  it("prints repo add output as json", async () => {
    const tempHome = path.join(os.tmpdir(), `outpost-test-${Date.now()}`);
    const tempRepo = path.join(os.tmpdir(), `outpost-repo-${Date.now()}`);
    const tempRemote = path.join(
      os.tmpdir(),
      `outpost-remote-${Date.now()}.git`,
    );
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    const { mkdirSync } = await import("node:fs");
    mkdirSync(tempRepo, { recursive: true });

    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["init", "--bare", tempRemote]);
    execFileSync("git", ["init"], { cwd: tempRepo });
    execFileSync("git", ["remote", "add", "origin", tempRemote], {
      cwd: tempRepo,
    });

    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["repo", "add", tempRepo, "--json"]);

    expect(exitCode).toBe(0);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy.mock.calls[0]?.[0]).toContain('"command": "repo add"');
    expect(infoSpy.mock.calls[0]?.[0]).toContain('"action": "cloned"');
    expect(infoSpy.mock.calls[0]?.[0]).toContain('"ready": true');
  });

  it("returns an error when repo add finds multiple remotes", async () => {
    const tempHome = path.join(os.tmpdir(), `outpost-test-${Date.now()}`);
    const tempRepo = path.join(os.tmpdir(), `outpost-repo-${Date.now()}`);
    const tempOriginRemote = path.join(
      os.tmpdir(),
      `outpost-origin-remote-${Date.now()}.git`,
    );
    const tempUpstreamRemote = path.join(
      os.tmpdir(),
      `outpost-upstream-remote-${Date.now()}.git`,
    );
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    const { mkdirSync } = await import("node:fs");
    mkdirSync(tempRepo, { recursive: true });

    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["init", "--bare", tempOriginRemote]);
    execFileSync("git", ["init", "--bare", tempUpstreamRemote]);
    execFileSync("git", ["init"], { cwd: tempRepo });
    execFileSync("git", ["remote", "add", "origin", tempOriginRemote], {
      cwd: tempRepo,
    });
    execFileSync("git", ["remote", "add", "upstream", tempUpstreamRemote], {
      cwd: tempRepo,
    });

    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["repo", "add", tempRepo]);

    expect(exitCode).toBe(1);
    expect(errorSpy).toHaveBeenNthCalledWith(
      1,
      "Unknown command: Repository has multiple remotes (origin, upstream). Remote selection is not implemented yet.",
    );
  });

  it("prints demo list output", async () => {
    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["demo", "list"]);

    expect(exitCode).toBe(0);
    expect(infoSpy).toHaveBeenNthCalledWith(1, "outpost demo list");
    expect(infoSpy).toHaveBeenNthCalledWith(
      2,
      "- workspace-bootstrap: Workspace bootstrap [ready]",
    );
    expect(infoSpy).toHaveBeenNthCalledWith(
      3,
      "- effect-foundation: Effect foundation [ready]",
    );
  });

  it("returns an error for unknown commands", async () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["wat"]);

    expect(exitCode).toBe(1);
    expect(errorSpy).toHaveBeenNthCalledWith(1, "Unknown command: wat");
  });
});
