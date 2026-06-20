import { createHash, randomUUID } from "node:crypto";
import { link } from "node:fs/promises";

import type { PlatformError } from "@effect/platform/Error";
import * as FileSystem from "@effect/platform/FileSystem";
import * as Path from "@effect/platform/Path";
import { Effect, Schema } from "effect";

import type { OutpostConfig } from "./config.js";
import { loadConfig } from "./config.js";
import { PathSafetyError, resolvePathWithinRoot } from "./path-safety.js";
import type { Manifest } from "./workspace-manifest.js";
import {
  resolveWorkspacePath,
  resolveWorktreePath,
} from "./workspace-manifest.js";

export type AgentsOwnership = "missing" | "generated" | "modified" | "foreign";

export type AgentsSnapshot =
  | { readonly state: "missing" }
  | {
      readonly state: "present";
      readonly bytes: Uint8Array;
      readonly sha256: string;
    };

type PresentAgentsSnapshot = Extract<AgentsSnapshot, { state: "present" }>;

export type AgentsClassification = {
  readonly ownership: AgentsOwnership;
  readonly snapshot: AgentsSnapshot;
};

export type GeneratedAgentsFile = {
  readonly filePath: string;
  readonly snapshot: PresentAgentsSnapshot;
};

export type AgentsDeleteResult = "deleted" | "unchanged-missing" | "mismatch";

export class AgentsError extends Schema.TaggedError<AgentsError>()(
  "AgentsError",
  {
    message: Schema.String,
  },
) {}

export const AGENTS_MARKER_PREFIX = "<!-- outpost:workspace-agents sha256=";

const markerRegex =
  /^<!-- outpost:workspace-agents sha256=([a-f0-9]{64}) -->\r?\n/;

export function computeSha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function jsonEncode(value: string): string {
  return JSON.stringify(value);
}

function presentSnapshot(bytes: Uint8Array): PresentAgentsSnapshot {
  const snapshotBytes = Uint8Array.from(bytes);
  return {
    state: "present",
    bytes: snapshotBytes,
    sha256: computeSha256(snapshotBytes),
  };
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }

  for (let index = 0; index < left.byteLength; index++) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
}

export function agentsSnapshotsEqual(
  left: AgentsSnapshot,
  right: AgentsSnapshot,
): boolean {
  if (left.state !== right.state) {
    return false;
  }

  if (left.state === "missing" || right.state === "missing") {
    return true;
  }

  return bytesEqual(left.bytes, right.bytes);
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

export function readAgentsSnapshot(
  filePath: string,
): Effect.Effect<AgentsSnapshot, PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(filePath);

    if (!exists) {
      return { state: "missing" };
    }

    return presentSnapshot(yield* fs.readFile(filePath));
  });
}

export function classifyAgentsOwnership(
  filePath: string,
): Effect.Effect<AgentsClassification, PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const snapshot = yield* readAgentsSnapshot(filePath);

    if (snapshot.state === "missing") {
      return { ownership: "missing", snapshot };
    }

    const content = new TextDecoder().decode(snapshot.bytes);
    const match = markerRegex.exec(content);

    if (!match?.[1]) {
      return { ownership: "foreign", snapshot };
    }

    return {
      ownership:
        match[1] === getAgentsBodyHash(content) ? "generated" : "modified",
      snapshot,
    };
  });
}

export function writeAgentsMarkdownExclusive(
  workspaceDir: string,
  content: string,
): Effect.Effect<
  GeneratedAgentsFile,
  AgentsError | PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const filePath = yield* getAgentsFilePath(workspaceDir).pipe(
      Effect.mapError((error) => new AgentsError({ message: error.message })),
    );
    const bytes = new TextEncoder().encode(content);
    const temporaryPath = path.join(
      path.dirname(filePath),
      `.${path.basename(filePath)}.${randomUUID()}.tmp`,
    );

    yield* fs.writeFile(temporaryPath, bytes, { flag: "wx" }).pipe(
      Effect.andThen(
        Effect.tryPromise({
          try: () => link(temporaryPath, filePath),
          catch: (error) =>
            new AgentsError({
              message: `Failed to create AGENTS.md at ${filePath} without overwriting an existing file: ${String(error)}`,
            }),
        }),
      ),
      Effect.ensuring(
        fs.remove(temporaryPath, { force: true }).pipe(Effect.ignore),
      ),
    );

    return {
      filePath,
      snapshot: presentSnapshot(bytes),
    };
  });
}

export function generateAgentsMarkdown(
  outpostHome: string,
  manifest: Manifest,
): Effect.Effect<
  GeneratedAgentsFile,
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

    return yield* writeAgentsMarkdownExclusive(workspaceDir, renderedContent);
  });
}

export function deleteAgentsIfSnapshotMatches(
  filePath: string,
  approvedSnapshot: AgentsSnapshot,
): Effect.Effect<AgentsDeleteResult, PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const currentSnapshot = yield* readAgentsSnapshot(filePath);

    if (!agentsSnapshotsEqual(approvedSnapshot, currentSnapshot)) {
      return "mismatch";
    }

    if (currentSnapshot.state === "missing") {
      return "unchanged-missing";
    }

    yield* fs.remove(filePath);
    return "deleted";
  });
}

export function getAgentsBodyHash(content: string): string {
  const firstNewline = content.indexOf("\n");

  if (firstNewline === -1) {
    return computeSha256("");
  }

  return computeSha256(content.slice(firstNewline + 1));
}
