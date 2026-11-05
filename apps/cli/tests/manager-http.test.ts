import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { afterEach, expect, it } from "vitest";
import { ApplicationInvocation } from "../src/application/context.js";
import { runInit } from "../src/commands/init.js";
import { createManager } from "../src/manager/server.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const home = await mkdtemp(path.join(tmpdir(), "om-http-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const ctx = { home, cwd: home, environment: { ...process.env } };
  await Effect.runPromise(
    runInit().pipe(
      Effect.provideService(ApplicationInvocation, ctx),
      Effect.provide(NodeServices.layer)
    )
  );
  const manager = await createManager(
    ctx,
    new Map([
      ["/", { bytes: Buffer.from("<!doctype html><title>Outpost</title>"), type: "text/html" }],
    ])
  );
  cleanups.push(() => manager.stop());
  const proof = new URL(manager.pairingLink()).hash.slice(6);
  const call = async (route: string, body?: unknown, bearer?: string) =>
    fetch(manager.origin + "/api/v1/" + route, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "X-Outpost-Manager": "1",
        Origin: manager.origin,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const pair = await (await call("pair", { proof })).json();
  return { home, manager, call, bearer: pair.data.bearer as string };
}
it("authenticates metadata reads and never serves arbitrary paths or API HTML fallbacks", async () => {
  const { manager, call, bearer } = await fixture();
  expect((await call("snapshot?section=repositories")).status).toBe(401);
  const data = await (await call("snapshot?section=repositories", undefined, bearer)).json();
  expect(data.data.state).toBe("ok");
  expect(data.data).not.toHaveProperty("config");
  expect((await fetch(manager.origin + "/config.json")).status).toBe(404);
  expect((await call("unknown", undefined, bearer)).status).toBe(404);
  expect((await fetch(manager.origin)).headers.get("content-security-policy")).toContain(
    "frame-ancestors 'none'"
  );
});
it("deduplicates an accepted mutation across signout and repair without replay", async () => {
  const { home, manager, call, bearer } = await fixture();
  const snapshot = await (await call("snapshot?section=repositories", undefined, bearer)).json();
  const body = {
    requestId: randomUUID(),
    revision: snapshot.data.revision,
    operation: { kind: "set-instructions", text: "one accepted write" },
  };
  const accepted = await (await call("operations", body, bearer)).json();
  expect(accepted.data.id).toBe(body.requestId);
  // Drain via the internal ownership promise, no arbitrary test delay.
  await manager.operations.settled(body.requestId);
  const before = await readFile(path.join(home, "config.json"));
  expect(JSON.parse(before.toString()).extraInstructions).toBe("one accepted write");
  await call("sign-out", {}, bearer);
  const proof = new URL(manager.pairingLink()).hash.slice(6);
  const second = await (await call("pair", { proof })).json();
  const duplicate = await (await call("operations", body, second.data.bearer)).json();
  expect(duplicate.data.state).toBe("succeeded");
  expect(await readFile(path.join(home, "config.json"))).toEqual(before);
  const conflict = await call(
    "operations",
    { ...body, operation: { ...body.operation, text: "different" } },
    second.data.bearer
  );
  expect(conflict.status).toBe(409);
});
it("refuses oversized ordinary actions and wrong body classes before admitting a write", async () => {
  const { home, manager, bearer } = await fixture();
  const before = await readFile(path.join(home, "config.json"));
  const ordinary = await fetch(`${manager.origin}/api/v1/operations`, {
    method: "POST",
    headers: {
      Origin: manager.origin,
      "X-Outpost-Manager": "1",
      Authorization: `Bearer ${bearer}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ padding: "x".repeat(9000) }),
  });
  expect(ordinary.status).toBe(413);
  const wrong = await fetch(`${manager.origin}/api/v1/operations`, {
    method: "POST",
    headers: {
      Origin: manager.origin,
      "X-Outpost-Manager": "1",
      Authorization: `Bearer ${bearer}`,
      "Content-Type": "application/json",
      "X-Outpost-Body": "instructions",
    },
    body: JSON.stringify({ operation: { kind: "register" } }),
  });
  expect(wrong.status).toBe(400);
  expect(await readFile(path.join(home, "config.json"))).toEqual(before);
});
it("rejects unknown API versions before pairing or authenticated state reads", async () => {
  const { manager, bearer } = await fixture();
  for (const route of ["/api/v2/settings", "/api/v99/settings"]) {
    const response = await fetch(manager.origin + route, {
      headers: {
        Origin: manager.origin,
        "X-Outpost-Manager": "1",
        Authorization: `Bearer ${bearer}`,
      },
    });
    expect(response.status).toBe(404);
  }
  const response = await fetch(manager.origin + "/api/v2/pair", {
    method: "POST",
    headers: {
      Origin: manager.origin,
      "X-Outpost-Manager": "1",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ proof: new URL(manager.pairingLink()).hash.slice(6) }),
  });
  expect(response.status).toBe(404);
});
it("explicit verification refuses a random revision without trusting the selected handle", async () => {
  const { home, manager, call, bearer } = await fixture();
  const { execFileSync } = await import("node:child_process");
  const fs = await import("node:fs/promises");
  const source = path.join(home, "source");
  await fs.mkdir(source);
  execFileSync("git", ["init", source], { stdio: "ignore" });
  const snapshot = await (await call("snapshot?section=repositories", undefined, bearer)).json();
  const register = {
    requestId: randomUUID(),
    revision: snapshot.data.revision,
    operation: { kind: "register", checkoutPath: source, name: "source" },
  };
  await call("operations", register, bearer);
  expect((await manager.operations.settled(register.requestId)).state).toBe("succeeded");
  const current = await (await call("snapshot?section=repositories", undefined, bearer)).json();
  const id = randomUUID();
  await call(
    "operations",
    {
      requestId: id,
      revision: randomUUID(),
      operation: { kind: "verify-registration", handle: current.data.repositories[0].handle },
    },
    bearer
  );
  expect((await manager.operations.settled(id)).state).toBe("failed");
});
it("returns stale409 only after the inside-lock revision check and preserves the newer settings", async () => {
  const { home, call, bearer, manager } = await fixture();
  const snapshot = await (await call("snapshot?section=repositories", undefined, bearer)).json();
  await Effect.runPromise(
    (await import("../src/application/settings.js")).setInstructions("newer CLI value").pipe(
      Effect.provideService(ApplicationInvocation, {
        home,
        cwd: home,
        environment: { ...process.env },
      }),
      Effect.provide(NodeServices.layer)
    )
  );
  const id = randomUUID();
  const response = await call(
    "operations",
    {
      requestId: id,
      revision: snapshot.data.revision,
      operation: { kind: "set-instructions", text: "stale browser value" },
    },
    bearer
  );
  expect(response.status).toBe(409);
  expect((await response.json()).error.code).toBe("stale-state");
  expect((await manager.operations.settled(id)).state).toBe("failed");
  expect(JSON.parse(await readFile(path.join(home, "config.json"), "utf8")).extraInstructions).toBe(
    "newer CLI value"
  );
});
it("imports a managed repository only after the locked revision check and deduplicates the request", async () => {
  const { home, manager, call, bearer } = await fixture();
  const { execFileSync } = await import("node:child_process");
  const fs = await import("node:fs/promises");
  const source = path.join(home, "source");
  const remote = path.join(home, "remote.git");
  execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
  execFileSync("git", ["init", source], { stdio: "ignore" });
  execFileSync("git", ["-C", source, "remote", "add", "origin", remote]);
  const snapshot = await (await call("snapshot?section=repositories", undefined, bearer)).json();
  const operation = { kind: "import", checkoutPath: source, remoteName: "origin" };
  const stale = { requestId: randomUUID(), revision: randomUUID(), operation };
  expect((await call("operations", stale, bearer)).status).toBe(409);
  expect((await manager.operations.settled(stale.requestId)).state).toBe("failed");
  const body = { requestId: randomUUID(), revision: snapshot.data.revision, operation };
  expect((await call("operations", body, bearer)).status).toBe(202);
  expect((await manager.operations.settled(body.requestId)).state).toBe("succeeded");
  const inventory = await (await call("snapshot?section=repositories", undefined, bearer)).json();
  expect(inventory.data.repositories).toHaveLength(1);
  expect(inventory.data.repositories[0].kind).toBe("managed");
  const registry = await fs.readFile(path.join(home, "repos.json"));
  expect((await (await call("operations", body, bearer)).json()).data.state).toBe("succeeded");
  expect(await fs.readFile(path.join(home, "repos.json"))).toEqual(registry);
});
it("reports an actionable remote selection error without exposing Git output", async () => {
  const { home, manager, call, bearer } = await fixture();
  const { execFileSync } = await import("node:child_process");
  const source = path.join(home, "source");
  execFileSync("git", ["init", source], { stdio: "ignore" });
  for (const name of ["origin", "other"])
    execFileSync("git", ["-C", source, "remote", "add", name, path.join(home, name)]);
  const snapshot = await (await call("snapshot?section=repositories", undefined, bearer)).json();
  const id = randomUUID();
  await call(
    "operations",
    {
      requestId: id,
      revision: snapshot.data.revision,
      operation: { kind: "import", checkoutPath: source },
    },
    bearer
  );
  const result = await manager.operations.settled(id);
  expect(result.state).toBe("failed");
  expect(result.message).toBe("Enter the name of the remote to import.");
});
it("keeps a failed transport outcome uncertain after import admission", async () => {
  const { home, manager, call, bearer } = await fixture();
  const { execFileSync } = await import("node:child_process");
  const source = path.join(home, "source");
  execFileSync("git", ["init", source], { stdio: "ignore" });
  execFileSync("git", ["-C", source, "remote", "add", "origin", path.join(home, "missing.git")]);
  const snapshot = await (await call("snapshot?section=repositories", undefined, bearer)).json();
  const id = randomUUID();
  await call(
    "operations",
    {
      requestId: id,
      revision: snapshot.data.revision,
      operation: { kind: "import", checkoutPath: source },
    },
    bearer
  );
  const result = await manager.operations.settled(id);
  expect(result.state).toBe("unknown");
  expect(result.message).toContain("inspect with the CLI");
});
