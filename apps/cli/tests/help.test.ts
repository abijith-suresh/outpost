import { describe, expect, it, vi } from "vitest";

import { ALL_COMMANDS } from "../src/command-spec.ts";
import {
  createManagedRepoFixture,
  createTempDir,
  existsSync,
  makeRepoRecord,
  path,
  readRegistry,
  runCli,
  setupAfterEach,
  version,
  writeRegistry,
} from "./helpers.ts";

setupAfterEach();

describe("run", () => {
  it("prints help with no arguments", async () => {
    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const exitCode = await runCli([]);

    expect(exitCode).toBe(0);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy.mock.calls[0]?.[0]).toContain("Usage:");
    expect(infoSpy.mock.calls[0]?.[0]).toContain(
      "repo add <path> [--remote <name>] [--json]",
    );
    expect(infoSpy.mock.calls[0]?.[0]).toContain("repo fetch --all [--json]");
    expect(infoSpy.mock.calls[0]?.[0]).toContain("repo remove <id> [--json]");
    expect(infoSpy.mock.calls[0]?.[0]).toContain(
      "workspace remove <ticket> [--json]",
    );
    expect(infoSpy.mock.calls[0]?.[0]).not.toContain("[--json] [--json]");
  });

  it("prints help for the help command", async () => {
    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["help"]);

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

  it("prints the current version when --version follows repo list", async () => {
    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["repo", "list", "--version"]);

    expect(exitCode).toBe(0);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledWith(version);
  });

  it("prints the current version when --version precedes repo list", async () => {
    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["--version", "repo", "list"]);

    expect(exitCode).toBe(0);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledWith(version);
  });

  it("prints the current version instead of doctor json output", async () => {
    const tempHome = createTempDir("outpost-test-");
    process.env.OUTPOST_HOME = tempHome;

    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["doctor", "--json", "--version"]);

    expect(exitCode).toBe(0);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledWith(version);
  });

  it("prints help for a top-level --help flag", async () => {
    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["--help"]);

    expect(exitCode).toBe(0);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy.mock.calls[0]?.[0]).toContain("Usage:");
    expect(infoSpy.mock.calls[0]?.[0]).toContain("Global options:");
  });

  it("prints command-level help when repo add includes --help", async () => {
    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["repo", "add", "--help"]);

    expect(exitCode).toBe(0);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy.mock.calls[0]?.[0]).toContain("Usage:");
    expect(infoSpy.mock.calls[0]?.[0]).toContain(
      "outpost repo add <path> [--remote <name>] [--json]",
    );
    expect(infoSpy.mock.calls[0]?.[0]).toContain("Arguments:");
    expect(infoSpy.mock.calls[0]?.[0]).toContain(
      "<path>  Local repository path (required)",
    );
    expect(infoSpy.mock.calls[0]?.[0]).toContain("Options:");
    expect(infoSpy.mock.calls[0]?.[0]).toContain(
      "--remote <name>  Remote name (defaults to origin)",
    );
  });

  it("prints command-level help when repo list includes --help", async () => {
    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["repo", "list", "--help"]);

    expect(exitCode).toBe(0);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy.mock.calls[0]?.[0]).toContain("Usage:");
    expect(infoSpy.mock.calls[0]?.[0]).toContain("outpost repo list [--json]");
  });

  it("prints command-level help when repo fetch includes --help", async () => {
    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["repo", "fetch", "--help"]);

    expect(exitCode).toBe(0);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy.mock.calls[0]?.[0]).toContain("Usage:");
    expect(infoSpy.mock.calls[0]?.[0]).toContain(
      "outpost repo fetch --all [--json]",
    );
  });

  it("prints command-level help when doctor includes --help", async () => {
    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["doctor", "--help"]);

    expect(exitCode).toBe(0);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy.mock.calls[0]?.[0]).toContain("Usage:");
    expect(infoSpy.mock.calls[0]?.[0]).toContain("outpost doctor [--json]");
  });

  it("prints help instead of json when repo add includes --json and --help", async () => {
    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["repo", "add", "--json", "--help"]);

    expect(exitCode).toBe(0);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy.mock.calls[0]?.[0]).toContain("Usage:");
    expect(infoSpy.mock.calls[0]?.[0]).toContain(
      "outpost repo add <path> [--remote <name>] [--json]",
    );
    expect(infoSpy.mock.calls[0]?.[0]).not.toContain('"command":');
  });

  it("prints command-level help through the help command", async () => {
    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["help", "workspace", "remove"]);

    expect(exitCode).toBe(0);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy.mock.calls[0]?.[0]).toContain(
      "outpost workspace remove <ticket> [--json]",
    );
    expect(infoSpy.mock.calls[0]?.[0]).toContain(
      "<ticket>  Ticket workspace identifier (required)",
    );
    expect(infoSpy.mock.calls[0]?.[0]).toContain("interactive: yes");
  });

  it("returns a JSON error for an unknown help target", async () => {
    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["help", "wat", "--json"]);

    expect(exitCode).toBe(1);
    expect(infoSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(errorSpy.mock.calls[0]?.[0]))).toEqual({
      ok: false,
      command: "help",
      error: {
        code: "INVALID_ARGUMENT",
        message: "Unknown command: wat",
      },
      exitCode: 1,
    });
  });

  it("lists each registered command exactly once in top-level help", async () => {
    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["--help"]);

    expect(exitCode).toBe(0);
    const helpText = String(infoSpy.mock.calls[0]?.[0]);

    for (const command of ALL_COMMANDS) {
      const commandPath = command.path.join(" ");
      const escapedCommandPath = commandPath.replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&",
      );
      const matches = helpText.match(
        new RegExp(`^  ${escapedCommandPath}(?: |$)`, "gm"),
      );
      expect(matches, commandPath).toHaveLength(1);
    }
  });

  it("describes the command surface as JSON in registry order", async () => {
    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["describe", "--json"]);

    expect(exitCode).toBe(0);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledTimes(1);

    const envelope = JSON.parse(String(infoSpy.mock.calls[0]?.[0]));
    expect(envelope).toEqual({
      ok: true,
      command: "describe",
      data: {
        commands: ALL_COMMANDS.map((command) => ({
          path: command.path,
          usage: command.path.join(" "),
          description: command.description,
          mutation: command.mutation,
          interactive: command.interactive,
          json: command.json,
          dryRun: command.dryRun,
        })),
      },
      exitCode: 0,
    });
  });

  it("describes one command as JSON with arguments and options", async () => {
    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["describe", "repo", "add", "--json"]);

    expect(exitCode).toBe(0);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(infoSpy.mock.calls[0]?.[0]))).toEqual({
      ok: true,
      command: "describe",
      data: {
        path: ["repo", "add"],
        usage: "repo add",
        description: "Validate a local repository for Outpost registration",
        arguments: [
          {
            name: "path",
            description: "Local repository path",
            required: true,
          },
        ],
        options: [
          {
            name: "--remote",
            valueName: "name",
            description: "Remote name (defaults to origin)",
            required: false,
          },
        ],
        mutation: true,
        interactive: false,
        json: true,
        dryRun: false,
      },
      exitCode: 0,
    });
  });

  it("returns a JSON error for an unknown describe target", async () => {
    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["describe", "wat", "--json"]);

    expect(exitCode).toBe(1);
    expect(infoSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(errorSpy.mock.calls[0]?.[0]))).toEqual({
      ok: false,
      command: "describe",
      error: {
        code: "INVALID_ARGUMENT",
        message: "Unknown command: wat",
      },
      exitCode: 1,
    });
  });

  it.each(["--help", "--version"])(
    "rejects duplicate global option %s before short-circuiting",
    async (option) => {
      const infoSpy = vi
        .spyOn(console, "log")
        .mockImplementation(() => undefined);
      const errorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);

      const exitCode = await runCli([option, option]);

      expect(exitCode).toBe(1);
      expect(infoSpy).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(
        `Usage: outpost <command> [options]\n${option} may only be provided once.`,
      );
    },
  );

  it("returns an exact JSON error for duplicate --json", async () => {
    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["doctor", "--json", "--json"]);

    expect(exitCode).toBe(1);
    expect(infoSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(errorSpy.mock.calls[0]?.[0]))).toEqual({
      ok: false,
      command: "doctor",
      error: {
        code: "INVALID_ARGUMENT",
        message:
          "Usage: outpost <command> [options]\n--json may only be provided once.",
      },
      exitCode: 1,
    });
  });

  it("rejects duplicate --json before repo remove side effects", async () => {
    const tempHome = createTempDir("outpost-test-");
    process.env.OUTPOST_HOME = tempHome;

    await runCli(["init"]);

    const alpha = await createManagedRepoFixture({ defaultBranch: "main" });
    await runCli(["repo", "add", alpha.tempRepo]);

    const registry = readRegistry(tempHome);
    const repo = registry.repos[0];
    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const exitCode = await runCli([
      "repo",
      "remove",
      repo.id,
      "--json",
      "--json",
    ]);

    expect(exitCode).toBe(1);
    expect(infoSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(errorSpy.mock.calls[0]?.[0]))).toEqual({
      ok: false,
      command: "repo remove",
      error: {
        code: "INVALID_ARGUMENT",
        message:
          "Usage: outpost <command> [options]\n--json may only be provided once.",
      },
      exitCode: 1,
    });
    expect(readRegistry(tempHome).repos).toEqual(registry.repos);
    expect(existsSync(repo.managedRepoPath)).toBe(true);
  });

  it("rejects unknown targets for the help command", async () => {
    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["help", "unexpected"]);

    expect(exitCode).toBe(1);
    expect(infoSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith("Unknown command: unexpected");
  });

  it("returns an exact JSON error for an unknown help target", async () => {
    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["help", "unexpected", "--json"]);

    expect(exitCode).toBe(1);
    expect(infoSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(errorSpy.mock.calls[0]?.[0]))).toEqual({
      ok: false,
      command: "help",
      error: {
        code: "INVALID_ARGUMENT",
        message: "Unknown command: unexpected",
      },
      exitCode: 1,
    });
  });

  it("returns an exact JSON error for an unknown command", async () => {
    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["wat", "--json"]);

    expect(exitCode).toBe(1);
    expect(infoSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(errorSpy.mock.calls[0]?.[0]))).toEqual({
      ok: false,
      command: null,
      error: {
        code: "UNKNOWN_COMMAND",
        message: "Unknown command: wat",
      },
      exitCode: 1,
    });
  });

  it("returns an exact JSON error for known-command usage failures", async () => {
    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["doctor", "unexpected", "--json"]);

    expect(exitCode).toBe(1);
    expect(infoSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(errorSpy.mock.calls[0]?.[0]))).toEqual({
      ok: false,
      command: "doctor",
      error: {
        code: "INVALID_ARGUMENT",
        message: "Usage: outpost doctor [--json]",
      },
      exitCode: 1,
    });
  });

  it("returns an exact JSON error for known-command state failures", async () => {
    const tempHome = createTempDir("outpost-test-");
    process.env.OUTPOST_HOME = tempHome;
    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["repo", "show", "alpha", "--json"]);

    expect(exitCode).toBe(1);
    expect(infoSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(errorSpy.mock.calls[0]?.[0]))).toEqual({
      ok: false,
      command: "repo show",
      error: {
        code: "REPO_SHOW_FAILED",
        message: `Outpost is not initialized at ${tempHome}`,
      },
      exitCode: 1,
    });
  });

  it("returns an exact JSON success envelope on stdout only", async () => {
    const tempHome = createTempDir("outpost-test-");
    process.env.OUTPOST_HOME = tempHome;
    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["doctor", "--json"]);

    expect(exitCode).toBe(0);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(infoSpy.mock.calls[0]?.[0]))).toEqual({
      ok: true,
      command: "doctor",
      data: {
        cwd: process.cwd(),
        initialized: false,
        missingRepoCount: 0,
        missingRepos: [],
        node: process.version,
        outpostHome: tempHome,
        platform: process.platform,
        diagnostics: [],
        status: "not-initialized",
      },
      exitCode: 0,
    });
  });

  it("returns an exact JSON partial envelope on stdout only", async () => {
    const tempHome = createTempDir("outpost-test-");
    process.env.OUTPOST_HOME = tempHome;
    await runCli(["init"]);

    const repo = makeRepoRecord({
      id: "missing",
      managedRepoPath: path.join(tempHome, "repos", "missing.git"),
    });
    writeRegistry(tempHome, [repo]);

    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["repo", "fetch", "--all", "--json"]);

    expect(exitCode).toBe(1);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(infoSpy.mock.calls[0]?.[0]))).toEqual({
      ok: false,
      command: "repo fetch",
      data: {
        failedCount: 1,
        fetchedCount: 0,
        repoCount: 1,
        results: [
          {
            error: expect.any(String),
            fetchStatus: "failed",
            id: repo.id,
            lastFetchedAt: repo.lastFetchedAt,
            managedRepoPath: repo.managedRepoPath,
            name: repo.name,
            remoteName: repo.remoteName,
            remoteUrl: repo.remoteUrl,
            sourceRepoPath: repo.sourceRepoPath,
          },
        ],
      },
      exitCode: 1,
    });
  });

  it("rejects unexpected positional argument for doctor", async () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["doctor", "unexpected"]);

    expect(exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith("Usage: outpost doctor [--json]");
  });

  it("rejects unexpected positional argument for init", async () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["init", "unexpected"]);

    expect(exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith("Usage: outpost init [--json]");
  });

  it("rejects unexpected positional argument for repo list", async () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["repo", "list", "unexpected"]);

    expect(exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith("Usage: outpost repo list [--json]");
  });

  it("rejects unexpected positional argument for workspace list", async () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["workspace", "list", "unexpected"]);

    expect(exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      "Usage: outpost workspace list [--json]",
    );
  });

  it("prints help when both --help and --version are present", async () => {
    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["--help", "--version"]);

    expect(exitCode).toBe(0);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy.mock.calls[0]?.[0]).toContain("Usage:");
    expect(infoSpy.mock.calls[0]?.[0]).toContain("Global options:");
    expect(infoSpy.mock.calls[0]?.[0]).not.toBe(version);
  });
});
