import { describe, expect, it, vi } from "vitest";

import { run } from "../src/index.js";

describe("run", () => {
  it("prints a bootstrap message", () => {
    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const exitCode = run([]);

    expect(exitCode).toBe(0);
    expect(infoSpy).toHaveBeenCalledWith("outpost: CLI foundation is ready.");
  });

  it("prints the current version", () => {
    const infoSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const exitCode = run(["--version"]);

    expect(exitCode).toBe(0);
    expect(infoSpy).toHaveBeenCalledWith("0.0.1");
  });
});
