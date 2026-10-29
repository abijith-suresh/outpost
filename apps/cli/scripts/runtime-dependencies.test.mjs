import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { verifyInstalledRuntime } from "./runtime-dependencies.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "outpost-runtime-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (directory, value) => {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "package.json"), JSON.stringify(value));
  };
  const names = ["effect", "@effect/platform-node", "@effect/platform-node-shared"];
  const dependencies = Object.fromEntries(names.map((name) => [name, "4.0.6"]));
  const manifest = { name: "outpost-consumer-fixture", dependencies };
  write(root, manifest);
  for (const name of names)
    write(join(root, "node_modules", name), {
      name,
      version: "4.0.6",
      exports: { "./package.json": "./package.json" },
    });
  return { root, write, manifest };
}

test("accepts a compatible installed cohort using actual Node resolution", (t) => {
  const f = fixture(t);
  assert.equal(verifyInstalledRuntime(f.root).versions["@effect/platform-node-shared"], "4.0.6");
});

test("rejects the incompatible nested shared adapter even when root pins look correct", (t) => {
  const f = fixture(t);
  f.write(
    join(f.root, "node_modules/@effect/platform-node/node_modules/@effect/platform-node-shared"),
    {
      name: "@effect/platform-node-shared",
      version: "4.1.0",
      exports: { "./package.json": "./package.json" },
    }
  );
  assert.throws(() => verifyInstalledRuntime(f.root), /Incompatible installed runtime dependency/);
});

test("rejects a tarball manifest that omits its consumer-effective shared pin", (t) => {
  const f = fixture(t);
  delete f.manifest.dependencies["@effect/platform-node-shared"];
  f.write(f.root, f.manifest);
  assert.throws(() => verifyInstalledRuntime(f.root), /Missing exact shipped runtime cohort pin/);
});
