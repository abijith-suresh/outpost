import { createHash } from "node:crypto";

import type { PlatformError } from "@effect/platform/Error";
import * as FileSystem from "@effect/platform/FileSystem";
import * as Path from "@effect/platform/Path";
import { Effect, Either, Schema } from "effect";

import type { OutpostConfig } from "./config.js";
import { loadConfig } from "./config.js";
import { PathSafetyError, resolvePathWithinRoot } from "./path-safety.js";
import { writeTextFileAtomic } from "./store.js";
import type { Manifest } from "./workspace-manifest.js";
import {
  resolveWorkspacePath,
  resolveWorktreePath,
} from "./workspace-manifest.js";

export type AgentsOwnership = "missing" | "generated" | "modified" | "foreign";

export class AgentsError extends Schema.TaggedError<AgentsError>()(
  "AgentsError",
  {
    message: Schema.String,
  },
) {}

export const AGENTS_MARKER_PREFIX = "<!-- outpost:workspace-agents sha256=";

export function computeSha256(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

function jsonEncode(value: string): string {
  return JSON.stringify(value);
}

function resolveAgentsMarkdownWorkspaceDir(
  manifest: Manifest,
  config: OutpostConfig,
): Effect.Effect<string, AgentsError, FileSystem.FileSystem | Path.Path> {
  return resolveWorkspacePath(
    config.worktreesRoot,
    manifest.workspacePath,
  ).pipe(
    Effect.mapError((error) => new AgentsError({ message: error.message })),
  );
}

export function renderAgentsMarkdown(
  manifest: Manifest,
  config: OutpostConfig,
): Effect.Effect<string, AgentsError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const p = yield* Path.Path;
    const workspaceDir = yield* resolveAgentsMarkdownWorkspaceDir(
      manifest,
      config,
    );

    const repoBlocks: Array<string> = [];

    for (let i = 0; i < manifest.repositories.length; i++) {
      const repo = manifest.repositories[i];
      const worktreeDir = yield* resolveWorktreePath(
        workspaceDir,
        repo.worktreePath,
      ).pipe(
        Effect.mapError((error) => new AgentsError({ message: error.message })),
      );
      const relativeWorktree = (
        p.relative(workspaceDir, worktreeDir) || "."
      ).replace(/\\/g, "/");

      repoBlocks.push(
        [
          `### Repository ${i + 1}`,
          "",
          "```",
          `    name: ${jsonEncode(repo.name)}`,
          `    id: ${jsonEncode(repo.id)}`,
          `    worktree: ${jsonEncode(`./${relativeWorktree}`)}`,
          `    expectedBranch: ${jsonEncode(manifest.branch)}`,
          `    baseBranch: ${jsonEncode(repo.base)}`,
          "```",
        ].join("\n"),
      );
    }

    let body = "";
    body += "# Outpost Workspace\n";
    body += "\n";
    body +=
      "This directory coordinates one ticket workspace. It is not a Git repository.\n";
    body += "\n";
    body += "## Working Rules\n";
    body += "\n";
    body += "- Each listed child directory is an independent Git worktree.\n";
    body +=
      "- Run Git, build, test, and commit commands inside the relevant worktree.\n";
    body += "- Read that worktree's own AGENTS.md before modifying it.\n";
    body +=
      "- Verify the current branch before committing; branch values below are creation-time expectations.\n";
    body += "- Do not modify Outpost-managed Git metadata.\n";
    body += "\n";
    body += "## Workspace\n";
    body += "\n";
    body += "```\n";
    body += `    ticket: ${jsonEncode(manifest.ticket)}\n`;
    body += `    expectedBranch: ${jsonEncode(manifest.branch)}\n`;
    body += "```\n";
    body += "\n";
    body += "## Repositories\n";
    body += "\n";
    body += repoBlocks.join("\n\n");
    body += "\n";

    const bodyHash = computeSha256(body);
    const marker = `${AGENTS_MARKER_PREFIX}${bodyHash} -->`;

    return `${marker}\n${body}`;
  });
}

export function getAgentsFilePath(
  workspaceDir: string,
): Effect.Effect<string, PathSafetyError, Path.Path> {
  return resolvePathWithinRoot(workspaceDir, "AGENTS.md");
}

export function classifyAgentsOwnership(
  filePath: string,
  expectedBodyHash: string,
): Effect.Effect<AgentsOwnership, PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(filePath);

    if (!exists) {
      return "missing";
    }

    const content = yield* fs.readFileString(filePath);
    const markerRegex =
      /^<!-- outpost:workspace-agents sha256=([a-f0-9]{64}) -->\r?\n/;
    const match = markerRegex.exec(content);

    if (!match?.[1]) {
      return "foreign";
    }

    const hash = match[1];
    if (hash === expectedBodyHash) {
      return "generated";
    }

    return "modified";
  });
}

export function writeAgentsMarkdownAtomic(
  workspaceDir: string,
  content: string,
): Effect.Effect<
  void,
  AgentsError | PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const filePath = yield* getAgentsFilePath(workspaceDir).pipe(
      Effect.mapError((error) => new AgentsError({ message: error.message })),
    );

    yield* writeTextFileAtomic(filePath, content).pipe(
      Effect.mapError((error) => new AgentsError({ message: error.message })),
    );
  });
}

export function generateAgentsMarkdown(
  outpostHome: string,
  manifest: Manifest,
): Effect.Effect<
  void,
  AgentsError | PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const config = yield* loadConfig(outpostHome).pipe(
      Effect.mapError((error) => new AgentsError({ message: error.message })),
    );

    const workspaceDir = yield* resolveAgentsMarkdownWorkspaceDir(
      manifest,
      config,
    );

    const renderedContent = yield* renderAgentsMarkdown(manifest, config);

    const agentsFilePath = yield* getAgentsFilePath(workspaceDir).pipe(
      Effect.mapError((error) => new AgentsError({ message: error.message })),
    );

    const body = renderedContent.slice(renderedContent.indexOf("\n") + 1);
    const expectedBodyHash = computeSha256(body);

    const ownership = yield* classifyAgentsOwnership(
      agentsFilePath,
      expectedBodyHash,
    ).pipe(
      Effect.mapError((error) => new AgentsError({ message: error.message })),
    );

    if (ownership === "foreign" || ownership === "modified") {
      return yield* Effect.fail(
        new AgentsError({
          message: `AGENTS.md at ${agentsFilePath} is ${ownership} and cannot be overwritten automatically`,
        }),
      );
    }

    yield* writeAgentsMarkdownAtomic(workspaceDir, renderedContent);
  });
}

export function deleteAgentsIfExists(
  workspaceDir: string,
): Effect.Effect<void, PlatformError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const result = yield* Effect.either(getAgentsFilePath(workspaceDir));

    if (Either.isLeft(result)) {
      return;
    }

    const filePath = result.right;
    const exists = yield* fs.exists(filePath);

    if (exists) {
      yield* fs.remove(filePath, { force: true });
    }
  });
}

export function validateAgentsFingerprint(
  filePath: string,
  expectedBodyHash: string,
): Effect.Effect<boolean, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs
      .exists(filePath)
      .pipe(Effect.orElseSucceed(() => false));

    if (!exists) {
      return true;
    }

    const contentResult = yield* Effect.either(fs.readFileString(filePath));

    if (Either.isLeft(contentResult)) {
      return false;
    }

    const content = contentResult.right;
    const markerRegex =
      /^<!-- outpost:workspace-agents sha256=([a-f0-9]{64}) -->\r?\n/;
    const match = markerRegex.exec(content);

    if (match?.[1] && match[1] === expectedBodyHash) {
      return true;
    }

    return false;
  });
}

export function getAgentsBodyHash(content: string): string {
  const firstNewline = content.indexOf("\n");

  if (firstNewline === -1) {
    return computeSha256("");
  }

  return computeSha256(content.slice(firstNewline + 1));
}
