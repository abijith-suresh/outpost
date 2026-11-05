import { link, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { afterEach, expect, it, vi } from "vitest";
import { ApplicationInvocation } from "../src/application/context.js";
import { RecordedFiles, RecordedInventory } from "../src/application/inventory.js";
import { setInstructions } from "../src/application/settings.js";
import { runInit } from "../src/commands/init.js";

const homes: string[] = [];
const run = <A, E, R>(effect: Effect.Effect<A, E, R>, home: string) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provideService(ApplicationInvocation, {
        home,
        cwd: home,
        environment: { ...process.env },
      }),
      Effect.provide(NodeServices.layer)
    ) as Effect.Effect<A, E>
  );
async function fixture() {
  const home = await mkdtemp(path.join(tmpdir(), "om-"));
  homes.push(home);
  await run(runInit(), home);
  return home;
}
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
it("reads recorded metadata without changing source state or consulting an external root", async () => {
  const home = await fixture();
  const file = path.join(home, "config.json");
  const before = await readFile(file);
  const times = await stat(file, { bigint: true });
  const inventory = new RecordedInventory(await RecordedFiles.open(home));
  const first = await run(inventory.read(), home);
  const second = await run(inventory.read(), home);
  expect(first.state).toBe("ok");
  expect(second.revision).toBe(first.revision);
  expect(first.revision).toMatch(/^[0-9a-f-]{36}$/);
  expect(await readFile(file)).toEqual(before);
  expect((await stat(file, { bigint: true })).mtimeNs).toBe(times.mtimeNs);
});
it("rejects stale revisions inside the existing home lock before a write", async () => {
  const home = await fixture();
  const inventory = new RecordedInventory(await RecordedFiles.open(home));
  const old = await run(inventory.read(), home);
  await run(setInstructions("newer CLI instructions"), home);
  const preserved = await readFile(path.join(home, "config.json"));
  const ctx = {
    home,
    cwd: home,
    environment: { ...process.env },
    beforeMutation: inventory.checkRevision(old.revision).pipe(Effect.asVoid),
  };
  await expect(
    Effect.runPromise(
      setInstructions("stale browser text").pipe(
        Effect.provideService(ApplicationInvocation, ctx),
        Effect.provide(NodeServices.layer)
      )
    )
  ).rejects.toThrow("State changed");
  expect(await readFile(path.join(home, "config.json"))).toEqual(preserved);
});
it("allows unchanged revisions while the operation owns the home lock", async () => {
  const home = await fixture();
  const inventory = new RecordedInventory(await RecordedFiles.open(home));
  const old = await run(inventory.read(), home);
  await Effect.runPromise(
    setInstructions("valid browser text").pipe(
      Effect.provideService(ApplicationInvocation, {
        home,
        cwd: home,
        environment: { ...process.env },
        beforeMutation: inventory.checkRevision(old.revision).pipe(Effect.asVoid),
      }),
      Effect.provide(NodeServices.layer)
    )
  );
  expect(JSON.parse(await readFile(path.join(home, "config.json"), "utf8")).extraInstructions).toBe(
    "valid browser text"
  );
});
it("refuses redirected or hardlinked metadata instead of reading an external file", async () => {
  const home = await fixture();
  const outside = await mkdtemp(path.join(tmpdir(), "outside-"));
  homes.push(outside);
  const sentinel = path.join(outside, "sentinel");
  await writeFile(sentinel, "private external bytes");
  await rm(path.join(home, "repos.json"));
  await symlink(sentinel, path.join(home, "repos.json"));
  const files = await RecordedFiles.open(home);
  await expect(files.capture()).rejects.toThrow();
  await rm(path.join(home, "repos.json"));
  await link(sentinel, path.join(home, "repos.json"));
  await expect(files.capture()).rejects.toThrow();
  expect(await readFile(sentinel, "utf8")).toBe("private external bytes");
});
it("opening a missing home does not initialize it", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "om-"));
  homes.push(home);
  const missing = path.join(home, "missing");
  const files = await RecordedFiles.open(missing);
  expect((await files.capture()).fingerprint).toBe("uninitialized");
  await expect(stat(missing)).rejects.toThrow();
});
it("refuses an over-bound metadata file and a replaced pinned home without initialization or repair", async () => {
  const home = await fixture();
  const files = await RecordedFiles.open(home);
  await writeFile(path.join(home, "repos.json"), " ".repeat(1048577));
  await expect(files.capture()).rejects.toThrow();
  const moved = home + "-moved";
  homes.push(moved);
  const fs = await import("node:fs/promises");
  await fs.rename(home, moved);
  await fs.mkdir(home);
  await expect(files.capture()).rejects.toThrow();
});

it("binds a submitted revision before a concurrent polling read changes the current fingerprint", async () => {
  const home = await fixture();
  const files = await RecordedFiles.open(home);
  const inventory = new RecordedInventory(files);
  const prior = await run(inventory.read(), home);
  await run(setInstructions("completed concurrent CLI edit"), home);
  let resume!: () => void;
  let began!: () => void;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const capture = files.capture.bind(files);
  const spy = vi.spyOn(files, "capture").mockImplementationOnce(async () => {
    began();
    await gate;
    return capture();
  });
  const guarded = run(inventory.checkRevision(prior.revision), home);
  const refused = expect(guarded).rejects.toThrow("State changed");
  await started;
  await run(inventory.read(), home);
  resume();
  await refused;
  spy.mockRestore();
});
it("surfaces unfinished and malformed journals without exposing raw recovery content", async () => {
  const home = await fixture();
  const fs = await import("node:fs/promises");
  await fs.mkdir(path.join(home, "operations"), { recursive: true });
  const inventory = new RecordedInventory(await RecordedFiles.open(home));
  await writeFile(
    path.join(home, "operations", "interrupted.json"),
    JSON.stringify({ status: "interrupted-or-failed", privateMarker: "EXCLUDED_PRIVATE_MARKER" })
  );
  const interrupted = await run(inventory.read(), home);
  expect(interrupted.state).toBe("partial");
  expect(interrupted.notice).toContain("doctor");
  expect(interrupted.notice).not.toContain("EXCLUDED_PRIVATE_MARKER");
  await writeFile(path.join(home, "operations", "interrupted.json"), "not valid JSON");
  expect((await run(inventory.read(), home)).state).toBe("partial");
});
it("quiet config interpretation refuses unknown home spellings without resolving external aliases", async () => {
  const home = await fixture();
  const configPath = path.join(home, "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.outpostHome = path.join(home, "nonexistent-external-alias");
  await writeFile(configPath, JSON.stringify(config));
  const inventory = new RecordedInventory(await RecordedFiles.open(home));
  await expect(run(inventory.read(), home)).rejects.toThrow("Recorded metadata");
});
it("refuses a torn read when registration metadata changes during capture", async () => {
  const home = await fixture();
  const files = await RecordedFiles.open(home);
  const read = files.read.bind(files);
  let changed = false;
  const spy = vi.spyOn(files, "read").mockImplementation(async (relative, budget) => {
    const content = await read(relative, budget);
    if (relative === "config.json" && !changed) {
      changed = true;
      await writeFile(
        path.join(home, "config.json"),
        JSON.stringify({ ...JSON.parse(content!), extraInstructions: "later transaction" })
      );
    }
    return content;
  });
  await expect(files.capture()).rejects.toThrow();
  spy.mockRestore();
});
it("does not call surviving manifests an empty uninitialized home when config and registry are missing", async () => {
  const home = await fixture();
  const fs = await import("node:fs/promises");
  await writeFile(
    path.join(home, "workspaces", "ORPHAN.json"),
    JSON.stringify({ untrusted: "retained" })
  );
  await fs.rm(path.join(home, "config.json"));
  await fs.rm(path.join(home, "repos.json"));
  const inventory = new RecordedInventory(await RecordedFiles.open(home));
  const result = await run(inventory.read(), home);
  expect(result.state).toBe("invalid");
  expect(result.workspaces).toMatchObject([{ ticket: "ORPHAN", metadataState: "invalid" }]);
  expect(result.notice).toContain("doctor");
});
it("caches unchanged decoded metadata but detects in-place edits and keeps admission reads fresh", async () => {
  const home = await fixture();
  const files = await RecordedFiles.open(home);
  const inventory = new RecordedInventory(files);
  const first = await run(inventory.read(), home);
  const reader = vi.spyOn(files, "read");
  expect((await run(inventory.read(), home)).revision).toBe(first.revision);
  expect(reader).not.toHaveBeenCalled();
  const cfg = path.join(home, "config.json");
  const content = JSON.parse(await readFile(cfg, "utf8"));
  await writeFile(
    cfg,
    JSON.stringify({
      ...content,
      version: 2,
      legacyWorktreesRoot: content.worktreesRoot,
      trustedWorktreesRoots: [content.worktreesRoot],
      extraInstructions: "new text",
    })
  );
  const changed = await run(inventory.read(), home);
  expect(changed.revision).not.toBe(first.revision);
  expect(reader).toHaveBeenCalled();
  reader.mockClear();
  await run(inventory.checkRevision(changed.revision), home);
  expect(reader).toHaveBeenCalled();
  reader.mockRestore();
});
