import { describe, expect, it } from "vitest";

import { createTempDir, existsSync, path, setupAfterEach } from "./helpers.ts";

setupAfterEach();

describe.sequential("createTempDir", () => {
  let previousTempDir: string | undefined;

  it("creates unique directories with the requested prefix", () => {
    const firstTempDir = createTempDir("outpost-helper-");
    const secondTempDir = createTempDir("outpost-helper-");

    previousTempDir = firstTempDir;

    expect(firstTempDir).not.toBe(secondTempDir);
    expect(path.basename(firstTempDir)).toMatch(/^outpost-helper-/);
    expect(path.basename(secondTempDir)).toMatch(/^outpost-helper-/);
    expect(existsSync(firstTempDir)).toBe(true);
    expect(existsSync(secondTempDir)).toBe(true);
  });

  it("registers created directories for cleanup", () => {
    expect(previousTempDir).toBeDefined();
    if (!previousTempDir) {
      throw new Error("Expected the previous test to create a temp directory");
    }
    expect(existsSync(previousTempDir)).toBe(false);
  });
});
