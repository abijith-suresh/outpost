import { readdirSync } from "node:fs";

import * as FileSystem from "@effect/platform/FileSystem";
import { NodeContext } from "@effect/platform-node";
import { Effect, Exit } from "effect";
import { describe, expect, it, vi } from "vitest";

import { writeJsonFileAtomic, writeTextFileAtomic } from "../src/store.ts";
import {
  createTempDir,
  path,
  readFileSync,
  setupAfterEach,
  writeFileSync,
} from "./helpers.ts";

setupAfterEach();

describe("atomic store writes", () => {
  it("writes formatted JSON through a temporary sibling", async () => {
    const tempDirectory = createTempDir("outpost-store-test-");
    const filePath = path.join(tempDirectory, "state.json");

    await Effect.runPromise(
      writeJsonFileAtomic(filePath, { version: 1 }).pipe(
        Effect.provide(NodeContext.layer),
      ),
    );

    expect(readFileSync(filePath, "utf8")).toBe('{\n  "version": 1\n}\n');
  });

  it("keeps the destination and cleans up the temporary file when rename fails", async () => {
    const tempDirectory = createTempDir("outpost-store-test-");
    const filePath = path.join(tempDirectory, "state.txt");
    writeFileSync(filePath, "original\n");

    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const rename = vi.fn((oldPath: string, newPath: string) => {
          void oldPath;
          void newPath;
          return fs.rename(
            path.join(tempDirectory, "missing"),
            path.join(tempDirectory, "also-missing"),
          );
        });
        const failingFileSystem: FileSystem.FileSystem = {
          ...fs,
          rename,
        };

        const result = yield* Effect.exit(
          writeTextFileAtomic(filePath, "updated\n").pipe(
            Effect.provideService(FileSystem.FileSystem, failingFileSystem),
          ),
        );

        return { result, rename };
      }).pipe(Effect.provide(NodeContext.layer)),
    );

    expect(Exit.isFailure(exit.result)).toBe(true);
    expect(exit.rename).toHaveBeenCalledTimes(1);
    expect(path.dirname(exit.rename.mock.calls[0][0])).toBe(tempDirectory);
    expect(exit.rename.mock.calls[0][1]).toBe(filePath);
    expect(readFileSync(filePath, "utf8")).toBe("original\n");
    expect(readdirSync(tempDirectory)).toEqual(["state.txt"]);
  });
});
