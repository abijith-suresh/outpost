import { createHash } from "node:crypto";
import { readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vitest";
import { CONTRACT_VERSION, parseCommandInput, requireCommand } from "../src/command-spec.ts";
import { collectDiagnostics } from "../src/commands/repo-mirror.ts";
import { DescribeResultSchema, describeCommand, ErrorSchema } from "../src/machine-contract.ts";
import { ResultSchemas } from "../src/result-schemas.ts";
import {
  createManagedRepoFixture,
  createTempDir,
  existsSync,
  mkdirSync,
  path,
  readRegistry,
  runCli,
  setupAfterEach,
  version,
  writeFileSync,
  writeRegistry,
} from "./helpers.ts";

setupAfterEach();

function snapshot(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (directory: string) => {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      if (item.isDirectory()) walk(file);
      else
        files[path.relative(root, file)] = createHash("sha256")
          .update(readFileSync(file))
          .digest("hex");
    }
  };
  walk(root);
  return files;
}

function capture() {
  const info = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  return async (args: string[], expected = 0) => {
    info.mockClear();
    error.mockClear();
    expect(await runCli([...args, "--json"])).toBe(expected);
    const isError = error.mock.calls.length > 0;
    expect(isError ? info : error).not.toHaveBeenCalled();
    const calls = isError ? error.mock.calls : info.mock.calls;
    expect(calls).toHaveLength(1);
    const output = JSON.parse(String(calls[0][0]));
    if (isError) Schema.decodeUnknownSync(ErrorSchema)(output.error);
    else if (output.command === "describe")
      Schema.decodeUnknownSync(DescribeResultSchema)(output.data);
    else {
      const schema = ResultSchemas[output.command as keyof typeof ResultSchemas];
      expect(schema).toBeDefined();
      Schema.decodeUnknownSync(schema)(output.data);
    }
    const jsonSchema = describeCommand(requireCommand(output.command.split(" "))).outputSchema;
    if (jsonSchema) {
      const validate = new Ajv2020({ strict: true }).compile(jsonSchema);
      expect(validate(output), JSON.stringify(validate.errors)).toBe(true);
      if (!isError) expect(validate({ ...output, exitCode: 9 })).toBe(false);
    }
    return output;
  };
}

describe("agent command contract", () => {
  it("reports installed and contract versions, schemas, network and retry policies", async () => {
    const run = capture();
    const all = await run(["describe"]);
    expect(all.data.contractVersion).toBe(CONTRACT_VERSION);
    expect(all.data.cliVersion).toBe(version);
    const create = await run(["describe", "create"]);
    expect(create.data).toMatchObject({
      network: "explicit",
      retry: "inspect-before-retry",
      dryRunPolicy: { locks: false, mutations: false },
    });
    expect(create.data.inputSchema.properties.options.required).toEqual(["--ticket", "--type"]);
    const result = create.data.outputSchema.anyOf.find(
      (variant: { properties: { ok: { enum: boolean[] } } }) => variant.properties.ok.enum[0]
    );
    expect(result.properties.data.properties.worktrees.items.properties.path.type).toBe("string");
    expect((await run(["describe", "repo", "fetch"])).data.network).toBe("explicit");
    expect((await run(["describe", "guidance", "preview"])).data.network).toBe("none");
  });

  it("validates the registry's shape and accepts options before positional arguments", async () => {
    const spec = requireCommand(["repo", "add"]);
    expect(parseCommandInput(spec, ["--remote", "origin", "/repo"])).toEqual({
      arguments: { path: ["/repo"] },
      options: { "--remote": ["origin"] },
    });
    expect(() => parseCommandInput(spec, ["/repo", "--remote", "x", "--remote", "y"])).toThrow(
      "only be provided once"
    );
    const home = createTempDir();
    process.env.OUTPOST_HOME = home;
    const run = capture();
    await run(["init"]);
    const invalid = await run(["repo", "add", "/repo", "--unknown"], 1);
    expect(invalid.error).toMatchObject({
      code: "INVALID_ARGUMENT",
      reason: "invalid-arguments",
      retryable: false,
    });
    expect(existsSync(path.join(home, ".mutation.lock"))).toBe(false);
  });

  it("schemas actual lifecycle outputs and previews without writing or acquiring held locks", async () => {
    const home = createTempDir();
    process.env.OUTPOST_HOME = home;
    const run = capture();
    await run(["doctor"]);
    await run(["init"]);
    const source = await createManagedRepoFixture({ defaultBranch: "main" });
    await run(["repo", "add", "--remote", "origin", source.tempRepo]);
    const repo = readRegistry(home).repos[0];
    await run(["repo", "list"]);
    await run(["repo", "show", repo.id]);
    await run(["repo", "fetch", "--all"]);
    const create = ["create", "--ticket", "AGENT", "--type", "feat", "--repo", repo.id];
    await run([...create, "--dry-run"]);
    await run(create);
    await run(["workspace", "list"]);
    await run(["workspace", "show", "AGENT"]);
    expect((await run(["workspace", "resume", "AGENT"])).data.status).toBe("ready");
    const agents = path.join(home, "worktrees", "AGENT", "AGENTS.md");
    const original = readFileSync(agents, "utf8");
    writeFileSync(agents, `${original}\nLocal guidance\n`);
    writeFileSync(path.join(home, ".mutation.lock"), "held by test");
    writeFileSync(path.join(home, "workspaces", ".agent.lock"), "held by test");
    const before = snapshot(home);
    expect(await run(["workspace", "resume", "AGENT"], 1)).toMatchObject({
      ok: false,
      command: "workspace resume",
      data: { status: "not-ready", resumable: false },
      exitCode: 1,
    });
    expect(snapshot(home)).toEqual(before);
    const preview = await run(["workspace", "remove", "--dry-run", "AGENT"]);
    expect(preview.data).toMatchObject({
      status: "preview",
      dryRun: true,
      approvalRequired: true,
      agentsOwnership: "modified",
    });
    expect(snapshot(home)).toEqual(before);
    expect((await run(["workspace", "remove", "AGENT"], 1)).error).toMatchObject({
      code: "WORKSPACE_REMOVE_FAILED",
      reason: "lock-held",
      retryable: true,
    });
    rmSync(path.join(home, ".mutation.lock"));
    rmSync(path.join(home, "workspaces", ".agent.lock"));
    expect((await run(["workspace", "remove", "AGENT"], 1)).error.reason).toBe("approval-needed");
    writeFileSync(agents, original);
    const worktree = path.join(home, "worktrees", "AGENT", repo.name);
    writeFileSync(path.join(worktree, "local.txt"), "work in progress");
    const dirtyBefore = snapshot(home);
    expect((await run(["workspace", "remove", "AGENT", "--dry-run"], 1)).error.reason).toBe(
      "dirty-worktree"
    );
    expect(snapshot(home)).toEqual(dirtyBefore);
    expect((await run(["repo", "remove", repo.id, "--dry-run"], 1)).error.reason).toBe(
      "repo-in-use"
    );
    rmSync(path.join(worktree, "local.txt"));
    await run(["workspace", "remove", "AGENT"]);
    writeFileSync(path.join(home, ".mutation.lock"), "held by test");
    const repoBefore = snapshot(home);
    expect((await run(["repo", "remove", "--dry-run", repo.id])).data.dryRun).toBe(true);
    expect(snapshot(home)).toEqual(repoBefore);
    rmSync(path.join(home, ".mutation.lock"));
    rmSync(repo.managedRepoPath, { recursive: true });
    const partial = await run(["repo", "fetch", "--all"], 1);
    expect(partial).toMatchObject({
      ok: false,
      data: { failedCount: 1, results: [{ fetchStatus: "failed" }] },
    });
    await run(["repo", "remove", repo.id]);
    expect((await run(["repo", "show", repo.id], 1)).error.reason).toBe("repo-missing");
    expect((await run(["workspace", "show", "AGENT"], 1)).error.reason).toBe("workspace-missing");
  });

  it("classifies invalid Git branch and explicit remote selections as argument errors", async () => {
    const home = createTempDir();
    process.env.OUTPOST_HOME = home;
    const run = capture();
    await run(["init"]);
    const source = await createManagedRepoFixture({ defaultBranch: "main" });
    await run(["repo", "add", source.tempRepo]);
    const repo = readRegistry(home).repos[0];
    const branch = await run(
      ["create", "--ticket", "bad..ticket", "--type", "fix", "--repo", repo.id],
      1
    );
    expect(branch.error).toMatchObject({
      code: "CREATE_FAILED",
      reason: "invalid-arguments",
      retryable: false,
      action: expect.any(String),
    });
    const remote = await run(["repo", "add", source.tempRepo, "--remote", "absent"], 1);
    expect(remote.error).toMatchObject({
      code: "REPO_ADD_FAILED",
      reason: "invalid-arguments",
      retryable: false,
      action: expect.any(String),
    });
  });

  it.each(["create preview", "fetch"])(
    "distinguishes a missing mirror from foreign/corrupt state in %s",
    async (operation) => {
      const home = createTempDir();
      process.env.OUTPOST_HOME = home;
      const run = capture();
      await run(["init"]);
      const source = await createManagedRepoFixture({ defaultBranch: "main" });
      await run(["repo", "add", source.tempRepo]);
      const repo = readRegistry(home).repos[0];
      renameSync(repo.managedRepoPath, `${repo.managedRepoPath}.preserved`);
      const invoke = async () =>
        operation === "fetch"
          ? (await run(["repo", "fetch", "--all"], 1)).data.results[0]
          : (
              await run(
                ["create", "--ticket", "MISSING", "--type", "fix", "--repo", repo.id, "--dry-run"],
                1
              )
            ).error;
      expect(await invoke()).toMatchObject({
        reason: "repo-missing",
        retryable: false,
        action: expect.any(String),
      });
      mkdirSync(repo.managedRepoPath);
      writeFileSync(path.join(repo.managedRepoPath, "sentinel"), "Foreign content");
      expect(await invoke()).toMatchObject({ reason: "invalid-state", retryable: false });
      expect(readFileSync(path.join(repo.managedRepoPath, "sentinel"), "utf8")).toBe(
        "Foreign content"
      );
      const foreign = createTempDir();
      writeFileSync(path.join(foreign, "sentinel"), "Unrelated files");
      writeRegistry(home, [{ ...repo, managedRepoPath: foreign }]);
      expect(await invoke()).toMatchObject({ reason: "invalid-state", retryable: false });
      expect(readFileSync(path.join(foreign, "sentinel"), "utf8")).toBe("Unrelated files");
    }
  );

  it("bounds tiny and long diagnostic lines with explicit metadata for both streams", () => {
    const tiny = collectDiagnostics({
      stdout: { text: "x\n".repeat(131072), truncated: true },
      stderr: { text: "y\n".repeat(131072), truncated: false },
    });
    expect(tiny.diagnostics).toHaveLength(80);
    expect(tiny.diagnosticTruncation).toMatchObject({
      truncated: true,
      omittedLineCount: 262064,
      capturedOutputTruncated: true,
    });
    expect(JSON.stringify(tiny).length).toBeLessThan(5000);
    const long = collectDiagnostics({
      stdout: { text: "x".repeat(250000), truncated: false },
      stderr: { text: "y".repeat(250000), truncated: false },
    });
    expect(long.diagnostics.reduce((size, item) => size + item.line.length, 0)).toBe(16384);
    expect(long.diagnosticTruncation.truncated).toBe(true);
  });
});
