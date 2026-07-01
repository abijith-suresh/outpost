import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

import * as FileSystem from "@effect/platform/FileSystem";
import { NodeContext } from "@effect/platform-node";
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import {
  makeAgentsRemovalPrompt,
  type PromptReadline,
} from "../src/commands/workspace-remove-prompt.js";
import type { OutpostConfig } from "../src/config.js";
import {
  AGENTS_MARKER_PREFIX,
  agentsSnapshotsEqual,
  classifyAgentsOwnership,
  computeSha256,
  deleteAgentsIfSnapshotMatches,
  generateAgentsMarkdown,
  getAgentsBodyHash,
  readAgentsSnapshot,
  renderAgentsMarkdown,
  writeAgentsMarkdownExclusive,
} from "../src/workspace-agents.js";
import type { Manifest } from "../src/workspace-manifest.js";
import { createTempDir, path, setupAfterEach } from "./helpers.js";

setupAfterEach();

function makeManifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    ticket: "TICKET-123",
    type: "feature",
    branch: "feat/TICKET-123",
    createdAt: "2026-01-01T00:00:00.000Z",
    workspacePath: "TICKET-123",
    repositories: [
      {
        id: "github.com/example/api",
        name: "api",
        base: "main",
        managedPath: "repos/example/api.git",
        worktreePath: "api",
      },
    ],
    ...overrides,
  };
}

function makeConfig(tempHome: string): OutpostConfig {
  return {
    version: 1,
    outpostHome: tempHome,
    reposRoot: path.join(tempHome, "repos"),
    worktreesRoot: path.join(tempHome, "worktrees"),
  };
}

function setupWorkspace(tempHome: string): {
  config: OutpostConfig;
  workspaceDir: string;
} {
  const config = makeConfig(tempHome);
  const workspaceDir = path.join(config.worktreesRoot, "TICKET-123");
  mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(
    path.join(tempHome, "config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
  );
  return { config, workspaceDir };
}

function managedContent(body: string): string {
  return `${AGENTS_MARKER_PREFIX}${computeSha256(body)} -->\n${body}`;
}

describe("renderAgentsMarkdown", () => {
  it("renders the exact deterministic document", async () => {
    const tempHome = createTempDir("outpost-agents-render-");
    const { config } = setupWorkspace(tempHome);
    const expectedBody = `# Outpost Workspace

This directory coordinates one ticket workspace. It is not a Git repository.

## Working Rules

- Each listed child directory is an independent Git worktree.
- Run Git, build, test, and commit commands inside the relevant worktree.
- Read that worktree's own AGENTS.md before modifying it.
- Verify the current branch before committing; branch values below are creation-time expectations.
- Do not modify Outpost-managed Git metadata.

## Workspace

\`\`\`
    ticket: "TICKET-123"
    expectedBranch: "feat/TICKET-123"
\`\`\`

## Repositories

### Repository 1

\`\`\`
    name: "api"
    id: "github.com/example/api"
    worktree: "./api"
    expectedBranch: "feat/TICKET-123"
    baseBranch: "main"
\`\`\`
`;

    const content = await Effect.runPromise(
      renderAgentsMarkdown(makeManifest(), config).pipe(
        Effect.provide(NodeContext.layer),
      ),
    );

    expect(content).toBe(managedContent(expectedBody));
    expect(getAgentsBodyHash(content)).toBe(computeSha256(expectedBody));
  });

  it("JSON-encodes dynamic values and uses portable relative paths", async () => {
    const tempHome = createTempDir("outpost-agents-render-");
    const { config } = setupWorkspace(tempHome);
    const content = await Effect.runPromise(
      renderAgentsMarkdown(
        makeManifest({
          ticket: "# injected\nheading",
          repositories: [
            {
              id: "github.com/example/api",
              name: 'api"quoted',
              base: "develop",
              managedPath: "repos/example/api.git",
              worktreePath: "api",
            },
          ],
        }),
        config,
      ).pipe(Effect.provide(NodeContext.layer)),
    );

    expect(content).toContain('"# injected\\nheading"');
    expect(content).toContain('"api\\"quoted"');
    expect(content).toContain('"./api"');
    expect(content).not.toContain(config.worktreesRoot);
    expect(content).not.toContain("\r\n");
  });
});

describe("classifyAgentsOwnership", () => {
  it("returns a missing snapshot", async () => {
    const filePath = path.join(
      createTempDir("outpost-agents-classify-"),
      "AGENTS.md",
    );

    const result = await Effect.runPromise(
      classifyAgentsOwnership(filePath).pipe(Effect.provide(NodeContext.layer)),
    );

    expect(result).toEqual({
      ownership: "missing",
      snapshot: { state: "missing" },
    });
  });

  it("recognizes a generated file and retains its exact bytes", async () => {
    const tempHome = createTempDir("outpost-agents-classify-");
    const filePath = path.join(tempHome, "AGENTS.md");
    const content = managedContent("# Outpost Workspace\n");
    writeFileSync(filePath, content);

    const result = await Effect.runPromise(
      classifyAgentsOwnership(filePath).pipe(Effect.provide(NodeContext.layer)),
    );

    expect(result.ownership).toBe("generated");
    expect(result.snapshot.state).toBe("present");
    if (result.snapshot.state === "present") {
      expect(Buffer.from(result.snapshot.bytes)).toEqual(Buffer.from(content));
      expect(result.snapshot.sha256).toBe(computeSha256(content));
    }
  });

  it("recognizes content from an older renderer by its embedded body hash", async () => {
    const tempHome = createTempDir("outpost-agents-classify-");
    const filePath = path.join(tempHome, "AGENTS.md");
    const olderBody =
      "# Outpost Workspace\n\nLegacy renderer without current sections.\n";
    writeFileSync(filePath, managedContent(olderBody));

    const result = await Effect.runPromise(
      classifyAgentsOwnership(filePath).pipe(Effect.provide(NodeContext.layer)),
    );

    expect(result.ownership).toBe("generated");
  });

  it("distinguishes modified, foreign, and CRLF generated content", async () => {
    const tempHome = createTempDir("outpost-agents-classify-");
    const filePath = path.join(tempHome, "AGENTS.md");

    writeFileSync(
      filePath,
      `${AGENTS_MARKER_PREFIX}${"0".repeat(64)} -->\n# changed\n`,
    );
    expect(
      (
        await Effect.runPromise(
          classifyAgentsOwnership(filePath).pipe(
            Effect.provide(NodeContext.layer),
          ),
        )
      ).ownership,
    ).toBe("modified");

    writeFileSync(filePath, "# foreign\n");
    expect(
      (
        await Effect.runPromise(
          classifyAgentsOwnership(filePath).pipe(
            Effect.provide(NodeContext.layer),
          ),
        )
      ).ownership,
    ).toBe("foreign");

    const crlfBody = "# Outpost Workspace\r\n";
    writeFileSync(
      filePath,
      `${AGENTS_MARKER_PREFIX}${computeSha256(crlfBody)} -->\r\n${crlfBody}`,
    );
    expect(
      (
        await Effect.runPromise(
          classifyAgentsOwnership(filePath).pipe(
            Effect.provide(NodeContext.layer),
          ),
        )
      ).ownership,
    ).toBe("generated");
  });
});

describe("exact snapshot deletion", () => {
  it("deletes only when the approved bytes are unchanged", async () => {
    const tempHome = createTempDir("outpost-agents-delete-");
    const filePath = path.join(tempHome, "AGENTS.md");
    writeFileSync(filePath, "# foreign\n");
    const approved = await Effect.runPromise(
      readAgentsSnapshot(filePath).pipe(Effect.provide(NodeContext.layer)),
    );

    const result = await Effect.runPromise(
      deleteAgentsIfSnapshotMatches(filePath, approved).pipe(
        Effect.provide(NodeContext.layer),
      ),
    );

    expect(result).toBe("deleted");
    expect(
      await Effect.runPromise(
        readAgentsSnapshot(filePath).pipe(Effect.provide(NodeContext.layer)),
      ),
    ).toEqual({ state: "missing" });
  });

  it("preserves a different self-consistent generated file", async () => {
    const tempHome = createTempDir("outpost-agents-delete-");
    const filePath = path.join(tempHome, "AGENTS.md");
    const approvedContent = managedContent("# approved\n");
    const replacementContent = managedContent("# replacement\n");
    writeFileSync(filePath, approvedContent);
    const approved = await Effect.runPromise(
      readAgentsSnapshot(filePath).pipe(Effect.provide(NodeContext.layer)),
    );
    writeFileSync(filePath, replacementContent);

    const result = await Effect.runPromise(
      deleteAgentsIfSnapshotMatches(filePath, approved).pipe(
        Effect.provide(NodeContext.layer),
      ),
    );

    expect(result).toBe("mismatch");
    expect(readFileSync(filePath, "utf8")).toBe(replacementContent);
  });

  it("detects a file appearing after a missing snapshot", async () => {
    const tempHome = createTempDir("outpost-agents-delete-");
    const filePath = path.join(tempHome, "AGENTS.md");
    const approved = await Effect.runPromise(
      readAgentsSnapshot(filePath).pipe(Effect.provide(NodeContext.layer)),
    );
    writeFileSync(filePath, "# appeared later\n");

    const current = await Effect.runPromise(
      readAgentsSnapshot(filePath).pipe(Effect.provide(NodeContext.layer)),
    );
    expect(agentsSnapshotsEqual(approved, current)).toBe(false);
    expect(
      await Effect.runPromise(
        deleteAgentsIfSnapshotMatches(filePath, approved).pipe(
          Effect.provide(NodeContext.layer),
        ),
      ),
    ).toBe("mismatch");
    expect(readFileSync(filePath, "utf8")).toBe("# appeared later\n");
  });
});

describe("exclusive generation", () => {
  it("returns the exact snapshot it publishes", async () => {
    const tempHome = createTempDir("outpost-agents-generate-");
    const { workspaceDir } = setupWorkspace(tempHome);

    const generated = await Effect.runPromise(
      generateAgentsMarkdown(tempHome, makeManifest()).pipe(
        Effect.provide(NodeContext.layer),
      ),
    );

    const diskBytes = readFileSync(path.join(workspaceDir, "AGENTS.md"));
    expect(generated.filePath).toBe(path.join(workspaceDir, "AGENTS.md"));
    expect(Buffer.from(generated.snapshot.bytes)).toEqual(diskBytes);
  });

  it("refuses an existing file without overwriting it", async () => {
    const tempHome = createTempDir("outpost-agents-generate-");
    const { workspaceDir } = setupWorkspace(tempHome);
    const filePath = path.join(workspaceDir, "AGENTS.md");
    writeFileSync(filePath, "# foreign\n");

    const exit = await Effect.runPromise(
      Effect.exit(
        writeAgentsMarkdownExclusive(workspaceDir, "generated\n").pipe(
          Effect.provide(NodeContext.layer),
        ),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(readFileSync(filePath, "utf8")).toBe("# foreign\n");
  });

  it("refuses a foreign file created concurrently before publication", async () => {
    const tempHome = createTempDir("outpost-agents-generate-");
    const { workspaceDir } = setupWorkspace(tempHome);
    const agentsPath = path.join(workspaceDir, "AGENTS.md");
    const foreignContent = "# concurrent foreign file\n";

    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        let injected = false;
        const racingFs = {
          ...fs,
          writeFile: (
            filePath: string,
            data: Uint8Array,
            options?: FileSystem.WriteFileOptions,
          ) =>
            fs.writeFile(filePath, data, options).pipe(
              Effect.tap(() => {
                if (!injected && filePath.endsWith(".tmp")) {
                  injected = true;
                  return fs.writeFileString(agentsPath, foreignContent, {
                    flag: "wx",
                  });
                }
                return Effect.void;
              }),
            ),
        };

        return yield* Effect.exit(
          generateAgentsMarkdown(tempHome, makeManifest()).pipe(
            Effect.provideService(FileSystem.FileSystem, racingFs),
          ),
        );
      }).pipe(Effect.provide(NodeContext.layer)),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(readFileSync(agentsPath, "utf8")).toBe(foreignContent);
  });
});

class FakeReadline implements PromptReadline {
  readonly listeners = new Map<"SIGINT" | "close", Array<() => void>>();
  closeCount = 0;

  constructor(
    readonly question: (question: string) => Promise<string>,
    readonly emitCloseOnClose = true,
  ) {}

  once(event: "SIGINT" | "close", listener: () => void): void {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
  }

  close(): void {
    this.closeCount++;
    if (this.emitCloseOnClose) {
      this.emit("close");
    }
  }

  emit(event: "SIGINT" | "close"): void {
    const listeners = this.listeners.get(event) ?? [];
    this.listeners.delete(event);
    for (const listener of listeners) {
      listener();
    }
  }
}

const promptRequest = {
  ticket: "TICKET-123",
  agentsFilePath: "/tmp/TICKET-123/AGENTS.md",
  ownership: "foreign" as const,
};

describe("workspace removal prompt adapter", () => {
  it.each([
    ["empty input", ""],
    ["unrecognized input", "maybe"],
    ["explicit No", "n"],
  ])("settles No for %s and closes once", async (_label, answer) => {
    const readline = new FakeReadline(() => Promise.resolve(answer));
    const prompt = makeAgentsRemovalPrompt({
      createReadline: () => readline,
    });

    await expect(prompt(promptRequest)).resolves.toBe(false);
    expect(readline.closeCount).toBe(1);
  });

  it("settles Yes only for recognized affirmative input", async () => {
    const readline = new FakeReadline(() => Promise.resolve(" YES "));
    const prompt = makeAgentsRemovalPrompt({
      createReadline: () => readline,
    });

    await expect(prompt(promptRequest)).resolves.toBe(true);
    expect(readline.closeCount).toBe(1);
  });

  it("settles No on EOF/close without closing twice", async () => {
    const readline = new FakeReadline(() => new Promise(() => undefined));
    const prompt = makeAgentsRemovalPrompt({
      createReadline: () => readline,
    });
    const result = prompt(promptRequest);

    readline.emit("close");

    await expect(result).resolves.toBe(false);
    expect(readline.closeCount).toBe(0);
  });

  it("settles No on SIGINT and closes once", async () => {
    const readline = new FakeReadline(() => new Promise(() => undefined));
    const prompt = makeAgentsRemovalPrompt({
      createReadline: () => readline,
    });
    const result = prompt(promptRequest);

    readline.emit("SIGINT");

    await expect(result).resolves.toBe(false);
    expect(readline.closeCount).toBe(1);
  });

  it("settles No when question rejects and closes once", async () => {
    const readline = new FakeReadline(() =>
      Promise.reject(new Error("question failed")),
    );
    const prompt = makeAgentsRemovalPrompt({
      createReadline: () => readline,
    });

    await expect(prompt(promptRequest)).resolves.toBe(false);
    expect(readline.closeCount).toBe(1);
  });
});
