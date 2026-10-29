import { strict as assert } from "node:assert";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

// Resolve from the actual consumer locations. A root/dev lock cannot prove
// which nested shared adapter the installed platform package will import.
export function verifyInstalledRuntime(packageRoot) {
  const manifestPath = join(packageRoot, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const expected = manifest.dependencies.effect;
  assert.match(expected, /^\d+\.\d+\.\d+$/);
  const app = createRequire(manifestPath);
  const platformPath = app.resolve("@effect/platform-node/package.json");
  const platform = createRequire(platformPath);
  const sharedPath = platform.resolve("@effect/platform-node-shared/package.json");
  const shared = createRequire(sharedPath);
  const paths = {
    effect: app.resolve("effect/package.json"),
    "@effect/platform-node": platformPath,
    "@effect/platform-node-shared": sharedPath,
  };
  const versions = {};
  for (const [name, file] of Object.entries(paths)) {
    assert.equal(
      manifest.dependencies[name],
      expected,
      `Missing exact shipped runtime cohort pin: ${name}`
    );
    versions[name] = JSON.parse(readFileSync(file, "utf8")).version;
    assert.equal(
      versions[name],
      expected,
      `Incompatible installed runtime dependency: ${name} at ${file}`
    );
  }
  assert.equal(
    realpathSync(sharedPath),
    realpathSync(app.resolve("@effect/platform-node-shared/package.json")),
    "Platform adapter bypassed the shipped shared dependency pin"
  );
  for (const consumer of [platform, shared]) {
    assert.equal(
      realpathSync(consumer.resolve("effect/package.json")),
      realpathSync(paths.effect),
      "Installed adapters resolve a different Effect runtime"
    );
  }
  return { versions, paths };
}
