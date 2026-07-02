import { Effect, Exit, Schema } from "effect";
import { describe, expect, it, vi } from "vitest";

import * as CreatePrompt from "../src/commands/create-prompt.ts";
import { RepoRegistrySchema } from "../src/config.ts";
import { ManifestSchema } from "../src/workspace-manifest.ts";
import {
  createTempDir,
  existsSync,
  mkdirSync,
  path,
  readFileSync,
  runCli,
  setupAfterEach,
  writeFileSync,
  writeRegistry,
} from "./helpers.ts";

setupAfterEach();

const validRepo = {
  id: "example.com/group/repo",
  importedAt: "2026-01-01T00:00:00.000Z",
  lastFetchedAt: "2026-01-01T00:00:00.000Z",
  managedRepoPath: "/tmp/Outpost Repos/repo.git",
  name: "repo",
  remoteName: "origin",
  remoteUrl: "https://example.com/group/repo.git",
  sourceRepoPath: "/tmp/Source Repos/repo",
};

const validManifest = {
  ticket: "工单-123",
  type: "feat",
  branch: "feat/工单-123",
  createdAt: "2026-01-01T00:00:00.000Z",
  workspacePath: "工单-123",
  repositories: [
    {
      id: "example.com/group/repo",
      name: "repo",
      base: "main",
      managedPath: "example.com/group/repo.git",
      worktreePath: "repo",
    },
  ],
};

async function getSchemaFailure(
  schema: Schema.Schema.AnyNoContext,
  value: unknown,
): Promise<string> {
  const exit = await Effect.runPromise(
    Effect.exit(Schema.decodeUnknown(schema)(value)),
  );
  expect(Exit.isFailure(exit)).toBe(true);

  return Exit.isFailure(exit) ? exit.cause.toString() : "";
}

describe("semantic identifier schemas", () => {
  it.each([
    ["id", "\u0000"],
    ["name", "repo\nname"],
    ["remoteName", "origin\u007f"],
  ])(
    "rejects control characters in persisted repo %s",
    async (field, value) => {
      const message = await getSchemaFailure(RepoRegistrySchema, {
        repos: [{ ...validRepo, [field]: value }],
      });

      expect(message).toContain(`["${field}"]`);
      expect(message).toContain("may not contain ASCII control characters.");
    },
  );

  it.each([
    ["ticket", "BAD\nTICKET"],
    ["type", "feat\t"],
    ["branch", "feat/BAD\u001b"],
  ])(
    "rejects control characters in persisted manifest %s",
    async (field, value) => {
      const message = await getSchemaFailure(ManifestSchema, {
        ...validManifest,
        [field]: value,
      });

      expect(message).toContain(`["${field}"]`);
      expect(message).toContain("may not contain ASCII control characters.");
    },
  );

  it.each([
    ["id", "repo\u0000"],
    ["name", "repo\rname"],
    ["base", "main\u007f"],
  ])(
    "rejects control characters in persisted manifest repository %s",
    async (field, value) => {
      const message = await getSchemaFailure(ManifestSchema, {
        ...validManifest,
        repositories: [
          {
            ...validManifest.repositories[0],
            [field]: value,
          },
        ],
      });

      expect(message).toContain(`["${field}"]`);
      expect(message).toContain("may not contain ASCII control characters.");
    },
  );

  it("rejects empty persisted semantic identifiers", async () => {
    const registryMessage = await getSchemaFailure(RepoRegistrySchema, {
      repos: [{ ...validRepo, id: "" }],
    });
    const manifestMessage = await getSchemaFailure(ManifestSchema, {
      ...validManifest,
      ticket: "",
    });

    expect(registryMessage).toContain('["id"]');
    expect(registryMessage).toContain("repository id may not be empty.");
    expect(manifestMessage).toContain('["ticket"]');
    expect(manifestMessage).toContain("ticket may not be empty.");
  });

  it("preserves Unicode identifiers and paths containing spaces", async () => {
    await expect(
      Effect.runPromise(
        Schema.decodeUnknown(RepoRegistrySchema)({
          repos: [
            {
              ...validRepo,
              id: "example.com/組織/リポジトリ",
              name: "リポジトリ",
            },
          ],
        }),
      ),
    ).resolves.toBeDefined();

    await expect(
      Effect.runPromise(Schema.decodeUnknown(ManifestSchema)(validManifest)),
    ).resolves.toEqual(validManifest);
  });
});

describe("interactive semantic identifier boundaries", () => {
  it("re-prompts instead of trimming control characters", async () => {
    const ask = vi
      .fn<(question: string) => Promise<string>>()
      .mockResolvedValueOnce("BAD\t")
      .mockResolvedValueOnce("TICKET-1")
      .mockResolvedValueOnce("feat")
      .mockResolvedValueOnce("alpha\u001b")
      .mockResolvedValueOnce("alpha");
    const log = vi.fn();

    const result = await CreatePrompt.promptForMissingCreateArgs(
      {
        ticket: undefined,
        type: undefined,
        repoIds: [],
        base: undefined,
        availableRepos: [{ id: "alpha", name: "alpha" }],
      },
      { ask, log },
    );

    expect(result).toEqual({
      ticket: "TICKET-1",
      type: "feat",
      repoIds: ["alpha"],
      base: undefined,
    });
    expect(log).toHaveBeenCalledWith(
      "Ticket id may not contain ASCII control characters.",
    );
    expect(log).toHaveBeenCalledWith(
      "Repo ids may not contain ASCII control characters.",
    );
  });
});

describe("semantic identifier command boundaries", () => {
  it.each([
    {
      name: "create ticket",
      argv: [
        "create",
        "--ticket",
        "BAD\nTICKET",
        "--type",
        "feat",
        "--repo",
        "alpha",
      ],
      message: "--ticket may not contain ASCII control characters.",
    },
    {
      name: "create branch type",
      argv: [
        "create",
        "--ticket",
        "TICKET-1",
        "--type",
        "feat\t",
        "--repo",
        "alpha",
      ],
      message: "--type may not contain ASCII control characters.",
    },
    {
      name: "create repository id",
      argv: [
        "create",
        "--ticket",
        "TICKET-1",
        "--type",
        "feat",
        "--repo",
        "alpha\u001b",
      ],
      message: "--repo may not contain ASCII control characters.",
    },
    {
      name: "create base branch",
      argv: [
        "create",
        "--ticket",
        "TICKET-1",
        "--type",
        "feat",
        "--repo",
        "alpha",
        "--base",
        "main\u007f",
      ],
      message: "--base may not contain ASCII control characters.",
    },
    {
      name: "repository remote",
      argv: ["repo", "add", "/tmp/repo", "--remote", "origin\n"],
      message: "--remote may not contain ASCII control characters.",
    },
    {
      name: "repository lookup",
      argv: ["repo", "show", "alpha\t"],
      message: "repo id may not contain ASCII control characters.",
    },
    {
      name: "repository removal",
      argv: ["repo", "remove", "alpha\r"],
      message: "repo id may not contain ASCII control characters.",
    },
    {
      name: "workspace lookup",
      argv: ["workspace", "show", "TICKET\u0000"],
      message: "--ticket may not contain ASCII control characters.",
    },
    {
      name: "workspace removal",
      argv: ["workspace", "remove", "TICKET\u001b"],
      message: "--ticket may not contain ASCII control characters.",
    },
  ])("rejects $name before state access", async ({ argv, message }) => {
    const parent = createTempDir("outpost-semantic-input-");
    const outpostHome = path.join(parent, "not-initialized");
    process.env.OUTPOST_HOME = outpostHome;
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(argv);

    expect(exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(message);
    expect(existsSync(outpostHome)).toBe(false);
  });

  it("corrupt registry identifiers block repository deletion", async () => {
    const outpostHome = createTempDir("outpost-semantic-registry-");
    process.env.OUTPOST_HOME = outpostHome;
    await runCli(["init"]);

    const managedRepoPath = path.join(outpostHome, "repos", "alpha.git");
    mkdirSync(managedRepoPath, { recursive: true });
    writeRegistry(outpostHome, [
      {
        ...validRepo,
        id: "alpha\n",
        managedRepoPath,
      },
    ]);
    const registryPath = path.join(outpostHome, "repos.json");
    const registryBefore = readFileSync(registryPath, "utf8");
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["repo", "remove", "alpha"]);

    expect(exitCode).toBe(1);
    expect(errorSpy.mock.calls[0]?.[0]).toContain("Invalid repo registry");
    expect(errorSpy.mock.calls[0]?.[0]).toContain(
      "repository id may not contain ASCII control characters.",
    );
    expect(existsSync(managedRepoPath)).toBe(true);
    expect(readFileSync(registryPath, "utf8")).toBe(registryBefore);
  });

  it("corrupt manifest identifiers block workspace deletion", async () => {
    const outpostHome = createTempDir("outpost-semantic-manifest-");
    process.env.OUTPOST_HOME = outpostHome;
    await runCli(["init"]);

    const ticket = "TICKET-1";
    const workspacePath = path.join(outpostHome, "worktrees", ticket);
    const manifestPath = path.join(outpostHome, "workspaces", `${ticket}.json`);
    const sentinelPath = path.join(workspacePath, "sentinel.txt");
    mkdirSync(workspacePath, { recursive: true });
    mkdirSync(path.dirname(manifestPath), { recursive: true });
    writeFileSync(sentinelPath, "keep\n");
    writeFileSync(
      manifestPath,
      `${JSON.stringify(
        {
          ...validManifest,
          ticket,
          workspacePath: ticket,
          repositories: [
            {
              ...validManifest.repositories[0],
              base: "main\n",
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["workspace", "remove", ticket]);

    expect(exitCode).toBe(1);
    expect(errorSpy.mock.calls[0]?.[0]).toContain("Invalid manifest");
    expect(errorSpy.mock.calls[0]?.[0]).toContain(
      "base branch may not contain ASCII control characters.",
    );
    expect(readFileSync(sentinelPath, "utf8")).toBe("keep\n");
    expect(existsSync(manifestPath)).toBe(true);
    expect(
      existsSync(path.join(outpostHome, "workspaces", ".ticket-1.lock")),
    ).toBe(false);
  });
});
