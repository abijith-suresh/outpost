import { afterEach, describe, expect, it, vi } from "vitest";

import { run } from "../src/index.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("run", () => {
  it("prints help with no arguments", () => {
    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const exitCode = run([]);

    expect(exitCode).toBe(0);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy.mock.calls[0]?.[0]).toContain("Usage:");
  });

  it("prints the current version", () => {
    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const exitCode = run(["--version"]);

    expect(exitCode).toBe(0);
    expect(infoSpy).toHaveBeenCalledWith("0.0.1");
  });

  it("prints doctor output", () => {
    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const exitCode = run(["doctor"]);

    expect(exitCode).toBe(0);
    expect(infoSpy).toHaveBeenNthCalledWith(1, "outpost doctor");
    expect(infoSpy).toHaveBeenNthCalledWith(2, "status: ok");
  });

  it("prints doctor output as json", () => {
    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const exitCode = run(["doctor", "--json"]);

    expect(exitCode).toBe(0);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy.mock.calls[0]?.[0]).toContain('"command": "doctor"');
  });

  it("prints demo list output", () => {
    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const exitCode = run(["demo", "list"]);

    expect(exitCode).toBe(0);
    expect(infoSpy).toHaveBeenNthCalledWith(1, "outpost demo list");
    expect(infoSpy).toHaveBeenNthCalledWith(
      2,
      "- workspace-bootstrap: Workspace bootstrap [ready]",
    );
  });

  it("returns an error for unknown commands", () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const exitCode = run(["wat"]);

    expect(exitCode).toBe(1);
    expect(errorSpy).toHaveBeenNthCalledWith(1, "Unknown command: wat");
  });
});
