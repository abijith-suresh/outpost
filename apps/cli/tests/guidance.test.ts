import { readdirSync, readFileSync, symlinkSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it, vi } from "vitest";
import { ALL_COMMANDS } from "../src/command-spec.ts";
import { GUIDANCE_PATHS } from "../src/commands/guidance.ts";
import {
  createTempDir,
  existsSync,
  path,
  runCli,
  setupAfterEach,
  writeFileSync,
} from "./helpers.ts";

setupAfterEach();

function capture() {
  const info = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  return async (args: string[], expected = 0) => {
    info.mockClear();
    error.mockClear();
    expect(await runCli([...args, "--json"])).toBe(expected);
    expect(expected ? info : error).not.toHaveBeenCalled();
    const output = JSON.parse(String((expected ? error : info).mock.calls[0][0]));
    const schema = JSON.parse(
      readFileSync(
        path.join(GUIDANCE_PATHS.schemasPath, `${output.command.replaceAll(" ", "-")}.output.json`),
        "utf8"
      )
    );
    const validate = new Ajv2020({ strict: true }).compile(schema);
    expect(validate(output), JSON.stringify(validate.errors)).toBe(true);
    return output;
  };
}

describe("bundled offline guidance", () => {
  it("reads all topics and locates assets without initializing a home", async () => {
    const root = createTempDir();
    const home = path.join(root, "unused-home");
    process.env.OUTPOST_HOME = home;
    const run = capture();
    for (const topic of ["overview", "commands", "recovery", "schemas"]) {
      const result = await run(["docs", topic]);
      expect(result.data.content).toBe(readFileSync(result.data.path, "utf8"));
    }
    expect((await run(["skill", "show"])).data.content).toBe(
      readFileSync(GUIDANCE_PATHS.skillPath, "utf8")
    );
    expect((await run(["skill", "path"])).data).toEqual(GUIDANCE_PATHS);
    expect((await run(["docs", "__proto__"], 1)).error.reason).toBe("invalid-arguments");
    expect(existsSync(home)).toBe(false);
  });

  it("exports the portable skill only to a new selected destination and refuses overwrites", async () => {
    const selected = path.join(createTempDir(), "selected");
    const run = capture();
    const exported = await run(["skill", "export", selected]);
    expect(exported.data.skillPath).toBe(path.join(selected, "outpost", "SKILL.md"));
    expect(exported.data.files).toContain("references/commands.md");
    for (const file of exported.data.files)
      expect(readFileSync(path.join(selected, "outpost", file))).toEqual(
        readFileSync(path.join(GUIDANCE_PATHS.skillDirectory, file))
      );
    writeFileSync(exported.data.skillPath, "User edited skill");
    await run(["skill", "export", selected], 1);
    expect(readFileSync(exported.data.skillPath, "utf8")).toBe("User edited skill");
    const root = createTempDir();
    const external = createTempDir();
    symlinkSync(external, path.join(root, "outpost"), "dir");
    await run(["skill", "export", root], 1);
    expect(readdirSync(external)).toEqual([]);
  });

  it("ships schemas with no unresolved local or network references for every JSON command", () => {
    const index = JSON.parse(
      readFileSync(path.join(GUIDANCE_PATHS.schemasPath, "index.json"), "utf8")
    );
    for (const asset of index.schemas) {
      const schema = JSON.parse(
        readFileSync(path.join(GUIDANCE_PATHS.schemasPath, asset.path), "utf8")
      );
      expect(() => new Ajv2020({ strict: true }).compile(schema)).not.toThrow();
    }
    for (const command of ALL_COMMANDS.filter((command) => command.json)) {
      expect(index.schemas).toContainEqual({
        command: command.path.join(" "),
        kind: "output",
        path: `${command.path.join("-")}.output.json`,
      });
    }
  });
});
