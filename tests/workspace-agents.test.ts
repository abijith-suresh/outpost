import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

import * as FileSystem from "@effect/platform/FileSystem";
import { NodeContext } from "@effect/platform-node";
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import type { OutpostConfig } from "../src/config.js";
import {
  AGENTS_MARKER_PREFIX,
  classifyAgentsOwnership,
  computeSha256,
  deleteAgentsIfExists,
  generateAgentsMarkdown,
  getAgentsBodyHash,
  renderAgentsMarkdown,
  validateAgentsFingerprint,
  writeAgentsMarkdownAtomic,
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

function setupWorkspaceDir(tempHome: string): string {
  const config = makeConfig(tempHome);
  mkdirSync(config.worktreesRoot, { recursive: true });
  const workspaceDir = path.join(config.worktreesRoot, "TICKET-123");
  mkdirSync(workspaceDir, { recursive: true });
  return workspaceDir;
}

function setupConfigDir(tempHome: string): void {
  const config = makeConfig(tempHome);
  mkdirSync(tempHome, { recursive: true });
  writeFileSync(
    path.join(tempHome, "config.json"),
    JSON.stringify(config, null, 2) + "\n",
  );
  mkdirSync(config.worktreesRoot, { recursive: true });
  mkdirSync(path.join(config.worktreesRoot, "TICKET-123"), { recursive: true });
}

// ---------------------------------------------------------------------------
// Rendering tests
// ---------------------------------------------------------------------------
describe("renderAgentsMarkdown", () => {
  it("renders deterministically with single repo", async () => {
    const tempHome = createTempDir("outpost-agents-render-");
    const config = makeConfig(tempHome);
    mkdirSync(config.worktreesRoot, { recursive: true });
    mkdirSync(path.join(config.worktreesRoot, "TICKET-123"), {
      recursive: true,
    });

    const manifest = makeManifest();

    const a = await Effect.runPromise(
      renderAgentsMarkdown(manifest, config).pipe(
        Effect.provide(NodeContext.layer),
      ),
    );
    const b = await Effect.runPromise(
      renderAgentsMarkdown(manifest, config).pipe(
        Effect.provide(NodeContext.layer),
      ),
    );

    expect(a).toBe(b);
    expect(a.startsWith(AGENTS_MARKER_PREFIX)).toBe(true);
  });

  it("renders deterministically with multiple repos", async () => {
    const tempHome = createTempDir("outpost-agents-render-");
    const config = makeConfig(tempHome);
    mkdirSync(config.worktreesRoot, { recursive: true });
    mkdirSync(path.join(config.worktreesRoot, "TICKET-123"), {
      recursive: true,
    });

    const manifest = makeManifest({
      repositories: [
        {
          id: "github.com/example/api",
          name: "api",
          base: "main",
          managedPath: "repos/example/api.git",
          worktreePath: "api",
        },
        {
          id: "github.com/example/frontend",
          name: "frontend",
          base: "develop",
          managedPath: "repos/example/frontend.git",
          worktreePath: "frontend",
        },
      ],
    });

    const content = await Effect.runPromise(
      renderAgentsMarkdown(manifest, config).pipe(
        Effect.provide(NodeContext.layer),
      ),
    );

    expect(content).toContain("### Repository 1");
    expect(content).toContain("### Repository 2");
    const idx1 = content.indexOf("### Repository 1");
    const idx2 = content.indexOf("### Repository 2");
    expect(idx1).toBeLessThan(idx2);
  });

  it("dynamic values cannot inject Markdown headings", async () => {
    const tempHome = createTempDir("outpost-agents-render-");
    const config = makeConfig(tempHome);
    mkdirSync(config.worktreesRoot, { recursive: true });
    mkdirSync(path.join(config.worktreesRoot, "INJECT"), {
      recursive: true,
    });

    const manifest = makeManifest({
      ticket: "# markdown",
      workspacePath: "INJECT",
    });

    const content = await Effect.runPromise(
      renderAgentsMarkdown(manifest, config).pipe(
        Effect.provide(NodeContext.layer),
      ),
    );

    // JSON encoding means the value is `"# markdown"` with quotes
    expect(content).toContain('"# markdown"');
    // The actual # character is inside quotes, not at line start
    const lines = content.split("\n");
    for (const line of lines) {
      if (
        line.startsWith("#") &&
        !line.startsWith("<!--") &&
        !line.startsWith("```")
      ) {
        // Allow # Outpost Workspace etc. but not user-injected headings
        expect(line).not.toContain("# markdown");
      }
    }
  });

  it("relative paths use forward slash", async () => {
    const tempHome = createTempDir("outpost-agents-render-");
    const config = makeConfig(tempHome);
    mkdirSync(config.worktreesRoot, { recursive: true });
    const workspaceDir = path.join(config.worktreesRoot, "TICKET-123");
    mkdirSync(workspaceDir, { recursive: true });

    const manifest = makeManifest();

    const content = await Effect.runPromise(
      renderAgentsMarkdown(manifest, config).pipe(
        Effect.provide(NodeContext.layer),
      ),
    );

    // The worktree path should use ./ with forward slash
    expect(content).toContain('"./');
  });

  it("no absolute paths appear in output", async () => {
    const tempHome = createTempDir("outpost-agents-render-");
    const config = makeConfig(tempHome);
    mkdirSync(config.worktreesRoot, { recursive: true });
    mkdirSync(path.join(config.worktreesRoot, "TICKET-123"), {
      recursive: true,
    });

    const manifest = makeManifest();

    const content = await Effect.runPromise(
      renderAgentsMarkdown(manifest, config).pipe(
        Effect.provide(NodeContext.layer),
      ),
    );

    const resolvedWorktreesRoot = path.resolve(config.worktreesRoot);
    expect(content).not.toContain(resolvedWorktreesRoot);
    expect(content).not.toContain(config.reposRoot);
  });

  it("marker hash matches body content", async () => {
    const tempHome = createTempDir("outpost-agents-render-");
    const config = makeConfig(tempHome);
    mkdirSync(config.worktreesRoot, { recursive: true });
    mkdirSync(path.join(config.worktreesRoot, "TICKET-123"), {
      recursive: true,
    });

    const manifest = makeManifest();

    const content = await Effect.runPromise(
      renderAgentsMarkdown(manifest, config).pipe(
        Effect.provide(NodeContext.layer),
      ),
    );

    const bodyHash = getAgentsBodyHash(content);
    const firstLine = content.split("\n")[0];
    expect(firstLine).toContain(bodyHash);
  });

  it("output has LF endings and ends with newline", async () => {
    const tempHome = createTempDir("outpost-agents-render-");
    const config = makeConfig(tempHome);
    mkdirSync(config.worktreesRoot, { recursive: true });
    mkdirSync(path.join(config.worktreesRoot, "TICKET-123"), {
      recursive: true,
    });

    const manifest = makeManifest();

    const content = await Effect.runPromise(
      renderAgentsMarkdown(manifest, config).pipe(
        Effect.provide(NodeContext.layer),
      ),
    );

    expect(content).not.toContain("\r\n");
    expect(content.endsWith("\n")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Classification tests
// ---------------------------------------------------------------------------
describe("classifyAgentsOwnership", () => {
  it("missing: file does not exist", async () => {
    const tempHome = createTempDir("outpost-agents-classify-");
    const filePath = path.join(tempHome, "AGENTS.md");

    const result = await Effect.runPromise(
      classifyAgentsOwnership(filePath, "abc").pipe(
        Effect.provide(NodeContext.layer),
      ),
    );

    expect(result).toBe("missing");
  });

  it("generated: correct marker with matching hash", async () => {
    const tempHome = createTempDir("outpost-agents-classify-");
    const filePath = path.join(tempHome, "AGENTS.md");
    const body = "# Outpost Workspace\n";
    const bodyHash = computeSha256(body);
    writeFileSync(filePath, `${AGENTS_MARKER_PREFIX}${bodyHash} -->\n${body}`);

    const result = await Effect.runPromise(
      classifyAgentsOwnership(filePath, bodyHash).pipe(
        Effect.provide(NodeContext.layer),
      ),
    );

    expect(result).toBe("generated");
  });

  it("modified: correct marker prefix but wrong hash", async () => {
    const tempHome = createTempDir("outpost-agents-classify-");
    const filePath = path.join(tempHome, "AGENTS.md");
    writeFileSync(
      filePath,
      `${AGENTS_MARKER_PREFIX}0000000000000000000000000000000000000000000000000000000000000000 -->\n# Outpost Workspace\n`,
    );

    const result = await Effect.runPromise(
      classifyAgentsOwnership(
        filePath,
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ).pipe(Effect.provide(NodeContext.layer)),
    );

    expect(result).toBe("modified");
  });

  it("foreign: file exists but no marker line", async () => {
    const tempHome = createTempDir("outpost-agents-classify-");
    const filePath = path.join(tempHome, "AGENTS.md");
    writeFileSync(filePath, "# Some other content\n");

    const result = await Effect.runPromise(
      classifyAgentsOwnership(filePath, "abc").pipe(
        Effect.provide(NodeContext.layer),
      ),
    );

    expect(result).toBe("foreign");
  });

  it("malformed marker: partial prefix", async () => {
    const tempHome = createTempDir("outpost-agents-classify-");
    const filePath = path.join(tempHome, "AGENTS.md");
    writeFileSync(
      filePath,
      "<!-- outpost:workspace-agents sha256=abc -->\n# content\n",
    );

    const result = await Effect.runPromise(
      classifyAgentsOwnership(filePath, "abc").pipe(
        Effect.provide(NodeContext.layer),
      ),
    );

    expect(result).toBe("foreign");
  });

  it("handles CRLF line endings", async () => {
    const tempHome = createTempDir("outpost-agents-classify-");
    const filePath = path.join(tempHome, "AGENTS.md");
    const body = "# Outpost Workspace\r\n";
    const bodyHash = computeSha256(body);
    writeFileSync(
      filePath,
      `${AGENTS_MARKER_PREFIX}${bodyHash} -->\r\n${body}`,
    );

    const result = await Effect.runPromise(
      classifyAgentsOwnership(filePath, bodyHash).pipe(
        Effect.provide(NodeContext.layer),
      ),
    );

    expect(result).toBe("generated");
  });
});

// ---------------------------------------------------------------------------
// writeAgentsMarkdownAtomic tests
// ---------------------------------------------------------------------------
describe("writeAgentsMarkdownAtomic", () => {
  it("writes file atomically", async () => {
    const tempHome = createTempDir("outpost-agents-write-");
    const workspaceDir = setupWorkspaceDir(tempHome);
    const content = "test content\n";

    await Effect.runPromise(
      writeAgentsMarkdownAtomic(workspaceDir, content).pipe(
        Effect.provide(NodeContext.layer),
      ),
    );

    const filePath = path.join(workspaceDir, "AGENTS.md");
    expect(readFileSync(filePath, "utf8")).toBe(content);
  });

  it("file exists with correct content after write", async () => {
    const tempHome = createTempDir("outpost-agents-write-");
    const workspaceDir = setupWorkspaceDir(tempHome);
    const manifest = makeManifest();
    const config = makeConfig(tempHome);

    const content = await Effect.runPromise(
      renderAgentsMarkdown(manifest, config).pipe(
        Effect.provide(NodeContext.layer),
      ),
    );

    await Effect.runPromise(
      writeAgentsMarkdownAtomic(workspaceDir, content).pipe(
        Effect.provide(NodeContext.layer),
      ),
    );

    const filePath = path.join(workspaceDir, "AGENTS.md");
    expect(readFileSync(filePath, "utf8")).toBe(content);
  });

  it("idempotent: can overwrite existing generated file", async () => {
    const tempHome = createTempDir("outpost-agents-write-");
    const workspaceDir = setupWorkspaceDir(tempHome);
    const content = "first write\n";

    await Effect.runPromise(
      writeAgentsMarkdownAtomic(workspaceDir, content).pipe(
        Effect.provide(NodeContext.layer),
      ),
    );

    const newContent = "second write\n";
    await Effect.runPromise(
      writeAgentsMarkdownAtomic(workspaceDir, newContent).pipe(
        Effect.provide(NodeContext.layer),
      ),
    );

    const filePath = path.join(workspaceDir, "AGENTS.md");
    expect(readFileSync(filePath, "utf8")).toBe(newContent);
  });
});

// ---------------------------------------------------------------------------
// deleteAgentsIfExists tests
// ---------------------------------------------------------------------------
describe("deleteAgentsIfExists", () => {
  it("deletes existing file", async () => {
    const tempHome = createTempDir("outpost-agents-delete-");
    const workspaceDir = setupWorkspaceDir(tempHome);
    const filePath = path.join(workspaceDir, "AGENTS.md");
    writeFileSync(filePath, "test\n");

    await Effect.runPromise(
      deleteAgentsIfExists(workspaceDir).pipe(
        Effect.provide(NodeContext.layer),
      ),
    );

    const { existsSync } = await import("node:fs");
    expect(existsSync(filePath)).toBe(false);
  });

  it("silent success when file does not exist", async () => {
    const tempHome = createTempDir("outpost-agents-delete-");
    const workspaceDir = setupWorkspaceDir(tempHome);

    const exit = await Effect.runPromise(
      Effect.exit(
        deleteAgentsIfExists(workspaceDir).pipe(
          Effect.provide(NodeContext.layer),
        ),
      ),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateAgentsFingerprint tests
// ---------------------------------------------------------------------------
describe("validateAgentsFingerprint", () => {
  it("returns true when hash matches", async () => {
    const tempHome = createTempDir("outpost-agents-validate-");
    const filePath = path.join(tempHome, "AGENTS.md");
    const body = "# test body\n";
    const bodyHash = computeSha256(body);
    writeFileSync(filePath, `${AGENTS_MARKER_PREFIX}${bodyHash} -->\n${body}`);

    const result = await Effect.runPromise(
      validateAgentsFingerprint(filePath, bodyHash).pipe(
        Effect.provide(NodeContext.layer),
      ),
    );

    expect(result).toBe(true);
  });

  it("returns false when hash differs", async () => {
    const tempHome = createTempDir("outpost-agents-validate-");
    const filePath = path.join(tempHome, "AGENTS.md");
    writeFileSync(
      filePath,
      `${AGENTS_MARKER_PREFIX}0000000000000000000000000000000000000000000000000000000000000000 -->\n# test\n`,
    );

    const result = await Effect.runPromise(
      validateAgentsFingerprint(
        filePath,
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ).pipe(Effect.provide(NodeContext.layer)),
    );

    expect(result).toBe(false);
  });

  it("returns true when file missing", async () => {
    const tempHome = createTempDir("outpost-agents-validate-");
    const filePath = path.join(tempHome, "AGENTS.md");

    const result = await Effect.runPromise(
      validateAgentsFingerprint(filePath, "abc").pipe(
        Effect.provide(NodeContext.layer),
      ),
    );

    expect(result).toBe(true);
  });

  it("handles read errors gracefully", async () => {
    const tempHome = createTempDir("outpost-agents-validate-");
    const filePath = path.join(tempHome, "AGENTS.md");
    writeFileSync(filePath, "test\n");

    const exit = await Effect.runPromise(
      Effect.exit(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const failing = {
            ...fs,
            exists: () => Effect.succeed(true),
            readFileString: () =>
              Effect.fail(new Error("read error") as unknown as never),
          };
          return yield* validateAgentsFingerprint(filePath, "abc").pipe(
            Effect.provideService(FileSystem.FileSystem, failing),
          );
        }).pipe(Effect.provide(NodeContext.layer)),
      ),
    );

    // It should never fail, just return false
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// generateAgentsMarkdown tests
// ---------------------------------------------------------------------------
describe("generateAgentsMarkdown", () => {
  it("creates AGENTS.md when missing", async () => {
    const tempHome = createTempDir("outpost-agents-gen-");
    setupConfigDir(tempHome);
    const manifest = makeManifest();
    const config = makeConfig(tempHome);
    const workspaceDir = path.join(config.worktreesRoot, "TICKET-123");

    await Effect.runPromise(
      generateAgentsMarkdown(tempHome, manifest).pipe(
        Effect.provide(NodeContext.layer),
      ),
    );

    const filePath = path.join(workspaceDir, "AGENTS.md");
    const { existsSync } = await import("node:fs");
    expect(existsSync(filePath)).toBe(true);

    const content = readFileSync(filePath, "utf8");
    expect(content.startsWith(AGENTS_MARKER_PREFIX)).toBe(true);
    expect(content).toContain(manifest.ticket);
  });

  it("overwrites own generated file", async () => {
    const tempHome = createTempDir("outpost-agents-gen-");
    setupConfigDir(tempHome);
    const manifest = makeManifest();
    const config = makeConfig(tempHome);
    const workspaceDir = path.join(config.worktreesRoot, "TICKET-123");

    // First generation
    await Effect.runPromise(
      generateAgentsMarkdown(tempHome, manifest).pipe(
        Effect.provide(NodeContext.layer),
      ),
    );

    // Second generation with same manifest should succeed (idempotent)
    await Effect.runPromise(
      generateAgentsMarkdown(tempHome, manifest).pipe(
        Effect.provide(NodeContext.layer),
      ),
    );

    const filePath = path.join(workspaceDir, "AGENTS.md");
    const content = readFileSync(filePath, "utf8");
    expect(content.startsWith(AGENTS_MARKER_PREFIX)).toBe(true);
    expect(content).toContain(manifest.ticket);
  });

  it("fails when foreign file exists", async () => {
    const tempHome = createTempDir("outpost-agents-gen-");
    setupConfigDir(tempHome);
    const config = makeConfig(tempHome);
    const workspaceDir = path.join(config.worktreesRoot, "TICKET-123");
    writeFileSync(path.join(workspaceDir, "AGENTS.md"), "# foreign\n");

    const manifest = makeManifest();

    const exit = await Effect.runPromise(
      Effect.exit(
        generateAgentsMarkdown(tempHome, manifest).pipe(
          Effect.provide(NodeContext.layer),
        ),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
  });
});
