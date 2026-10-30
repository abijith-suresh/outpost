import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { NodeServices } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { systemError } from "effect/PlatformError";
import { expect, it, vi } from "vitest";
import * as Child from "../src/child-process.ts";
import { runCreate } from "../src/commands/create.ts";
import * as Fresh from "../src/fresh-base.ts";
import * as Store from "../src/store.ts";
import {
  createManagedRepoFixture,
  createTempDir,
  path,
  runCli,
  setupAfterEach,
  writeFileSync,
} from "./helpers.ts";

setupAfterEach();
function git(cwd: string, ...args: string[]) {
  return execFileSync(
    "git",
    [
      "-c",
      "core.longpaths=true",
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=f@example.invalid",
      "-c",
      "core.autocrlf=false",
      "-C",
      cwd,
      ...args,
    ],
    { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
  ).trim();
}
async function cli(...args: string[]) {
  const out = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
  out.mockClear();
  err.mockClear();
  const code = await runCli([...args, "--json"]);
  const output = [...out.mock.calls, ...err.mock.calls].map((c) => String(c[0])).join("\n");
  return { code, output, data: JSON.parse(output).data };
}
async function ok(...args: string[]) {
  const r = await cli(...args);
  expect(r.code, r.output).toBe(0);
  return r.data;
}
function snapshot(root: string) {
  const result: Record<string, string> = {};
  function visit(dir: string) {
    for (const name of readdirSync(dir)) {
      const file = path.join(dir, name);
      const stat = lstatSync(file, { bigint: true });
      if (stat.isDirectory()) visit(file);
      else if (stat.isFile())
        result[file] = `${stat.mtimeNs}:${readFileSync(file).toString("base64")}`;
    }
  }
  visit(root);
  return result;
}
function preserved(before: Record<string, string>) {
  for (const [file, bytes] of Object.entries(before))
    expect(
      `${lstatSync(file, { bigint: true }).mtimeNs}:${readFileSync(file).toString("base64")}`,
      file
    ).toBe(bytes);
}
async function fixture() {
  const f = await createManagedRepoFixture({ repoName: "app" });
  const initial = git(f.tempRepo, "rev-parse", "HEAD");
  const writer = createTempDir("ofw-");
  git(writer, "clone", f.tempRemote, ".");
  writeFileSync(path.join(writer, "fresh"), "remote-only\n");
  git(writer, "add", ".");
  git(writer, "commit", "-m", "fresh");
  git(writer, "push", "origin", "main");
  const fresh = git(writer, "rev-parse", "HEAD");
  expect(() => git(f.tempRepo, "cat-file", "-e", fresh)).toThrow();
  const home = createTempDir("ofh-");
  process.env.OUTPOST_HOME = home;
  await ok("init");
  const repo = (await ok("repo", "register", f.tempRepo, "--name", "app")).repository;
  git(f.tempRepo, "update-index", "--split-index");
  writeFileSync(path.join(f.tempRepo, "dirty"), "preserve\n");
  return { ...f, initial, fresh, home, repo, writer };
}
function args(id: string, ticket = "FRESH") {
  return [
    "create",
    "--ticket",
    ticket,
    "--type",
    "feat",
    "--repo",
    id,
    "--base-source",
    "fresh-remote",
    "--remote",
    "origin",
    "--base",
    "main",
  ];
}
it("selects actual advertised remote-only SHA and retains source, cache, receipts and healthy inventory through lifecycle", async () => {
  const f = await fixture();
  const before = snapshot(f.tempRepo);
  const preview = await ok(...args(f.repo.id), "--dry-run");
  expect(preview.worktrees[0].baseCommit).toBe(null);
  expect(preview.worktrees[0].baseResolution).toBe("fetch-required");
  preserved(before);
  const made = await ok(...args(f.repo.id));
  const member = made.worktrees[0];
  expect(member.baseCommit).toBe(f.fresh);
  expect(git(member.path, "rev-parse", "HEAD")).toBe(f.fresh);
  expect(git(f.tempRepo, "rev-parse", "refs/remotes/origin/main")).toBe(f.initial);
  expect(git(f.tempRepo, "rev-parse", "refs/heads/main")).toBe(f.initial);
  expect(member.fetchReceipt.commit).toBe(f.fresh);
  expect(git(f.tempRepo, "rev-parse", member.fetchReceipt.ref)).toBe(f.fresh);
  expect(JSON.parse(readFileSync(path.join(f.home, "workspaces/FRESH.json"), "utf8")).version).toBe(
    7
  );
  const resumed = await ok("workspace", "resume", "FRESH");
  expect(resumed.resumable).toBe(true);
  expect(resumed.worktrees[0].originalBase.fetchReceipt).toEqual(member.fetchReceipt);
  const doctor = await ok("doctor");
  expect(doctor.status).toBe("ok");
  expect(doctor.operationRecords.some((r: { kind: string }) => r.kind === "completed-fresh")).toBe(
    true
  );
  await ok("workspace", "remove", "FRESH");
  preserved(before);
  expect(git(f.tempRepo, "rev-parse", member.fetchReceipt.ref)).toBe(f.fresh);
  expect(
    existsSync(path.join(f.home, "operations", `${member.fetchReceipt.operationId}.json`))
  ).toBe(true);
  // Completed retained inventory is not an unfinished ticket and does not prevent deliberate new admission after clean removal.
  const next = await ok(...args(f.repo.id, "SECOND"));
  expect(next.worktrees[0].baseCommit).toBe(f.fresh);
});
it("refuses missing advertised ref without cache fallback and blocks blind replay from failed journal", async () => {
  const f = await fixture();
  const a = args(f.repo.id);
  a[a.length - 1] = "missing";
  const before = snapshot(f.tempRepo);
  const failure = await cli(...a);
  expect(failure.code, failure.output).toBe(1);
  preserved(before);
  expect(existsSync(path.join(f.home, "workspaces/FRESH.json"))).toBe(false);
  const replay = await cli(...args(f.repo.id));
  expect(replay.code, replay.output).toBe(1);
  preserved(before);
});
it("does not write configured Git trace targets during fresh metadata preview", async () => {
  const f = await fixture();
  const trace = path.join(f.home, "trace.log");
  const global = path.join(f.home, "synthetic.gitconfig");
  writeFileSync(
    global,
    `[trace2]\n eventTarget = ${trace.replaceAll("\\", "/")}\n configParams = remote.origin.url\n`
  );
  process.env.GIT_CONFIG_GLOBAL = global;
  writeFileSync(trace, "");
  await ok(...args(f.repo.id), "--dry-run");
  expect(readFileSync(trace, "utf8")).toBe("");
});
it("captures advertisement once even when server branch moves before destination-free fetch", async () => {
  const f = await fixture();
  const original = Child.commandResult;
  const spy = vi.spyOn(Child, "commandResult").mockImplementation((command, options) =>
    original(command, options).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          if (command._tag === "StandardCommand" && command.args.includes("ls-remote"))
            git(f.tempRemote, "update-ref", "refs/heads/main", f.initial);
        })
      )
    )
  );
  const made = await ok(...args(f.repo.id));
  spy.mockRestore();
  expect(made.worktrees[0].baseCommit).toBe(f.fresh);
  expect(git(f.tempRemote, "rev-parse", "refs/heads/main")).toBe(f.initial);
  expect(git(f.tempRepo, "rev-parse", "refs/remotes/origin/main")).toBe(f.initial);
});
it.each(["direct", "symbolic"])(
  "refuses raced %s receipt including same-OID collision without claiming ownership",
  async (kind) => {
    const f = await fixture();
    const original = Child.acquireBranchCreation;
    let candidate = "";
    const spy = vi.spyOn(Child, "acquireBranchCreation").mockImplementation((...input) => {
      if (input[1].startsWith("refs/outpost/base-fetch/")) {
        candidate = input[1];
        if (kind === "direct") git(f.tempRepo, "update-ref", candidate, input[2]);
        else git(f.tempRepo, "symbolic-ref", candidate, "refs/heads/main");
      }
      return original(...input);
    });
    const r = await cli(...args(f.repo.id));
    spy.mockRestore();
    expect(r.code, r.output).toBe(1);
    expect(candidate).not.toBe("");
    expect(git(f.tempRepo, "rev-parse", candidate)).toBe(kind === "direct" ? f.fresh : f.initial);
    expect(existsSync(path.join(f.home, "workspaces/FRESH.json"))).toBe(false);
    expect(git(f.tempRepo, "rev-parse", "main")).toBe(f.initial);
  }
);
it("keeps committed receipt unconfirmed after lost commit acknowledgement and blocks replay", async () => {
  const f = await fixture();
  const original = Child.acquireBranchCreation;
  let candidate = "";
  const spy = vi.spyOn(Child, "acquireBranchCreation").mockImplementation((...input) =>
    original(...input).pipe(
      Effect.map((locked) => {
        if (!input[1].startsWith("refs/outpost/base-fetch/")) return locked;
        candidate = input[1];
        return {
          ...locked,
          commit: locked.commit.pipe(
            Effect.andThen(
              Effect.fail(
                systemError({
                  _tag: "Unknown",
                  module: "ChildProcess",
                  method: "execute",
                  description: "Synthetic acknowledgement loss",
                })
              )
            )
          ),
        };
      })
    )
  );
  const r = await cli(...args(f.repo.id));
  spy.mockRestore();
  expect(r.code, r.output).toBe(1);
  expect(git(f.tempRepo, "rev-parse", candidate)).toBe(f.fresh);
  expect(existsSync(path.join(f.home, "workspaces/FRESH.json"))).toBe(false);
  const operations = readdirSync(path.join(f.home, "operations")).map((name) =>
    JSON.parse(readFileSync(path.join(f.home, "operations", name), "utf8"))
  );
  expect(
    operations
      .flatMap((j) => j.steps ?? [])
      .some((step: { stage?: string }) => step.stage === "receipt-confirmed")
  ).toBe(false);
  const retry = await cli(...args(f.repo.id));
  expect(retry.code, retry.output).toBe(1);
  expect(git(f.tempRepo, "rev-parse", candidate)).toBe(f.fresh);
});
it("refuses truncated successful fetch output without inferring success from available objects", async () => {
  const f = await fixture();
  const original = Child.commandResult;
  const spy = vi
    .spyOn(Child, "commandResult")
    .mockImplementation((command, options) =>
      original(command, options).pipe(
        Effect.map((r) =>
          command._tag === "StandardCommand" && command.args.includes("fetch")
            ? { ...r, stderr: { ...r.stderr, truncated: true } }
            : r
        )
      )
    );
  const r = await cli(...args(f.repo.id));
  spy.mockRestore();
  expect(r.code, r.output).toBe(1);
  expect(git(f.tempRepo, "cat-file", "-t", f.fresh)).toBe("commit");
  expect(existsSync(path.join(f.home, "workspaces/FRESH.json"))).toBe(false);
  expect(git(f.tempRepo, "rev-parse", "refs/remotes/origin/main")).toBe(f.initial);
});
it("refuses mixed named fresh before transport/helper and preserves both selections", async () => {
  const f = await fixture();
  const managed = await createManagedRepoFixture({ repoName: "other" });
  await ok("repo", "add", managed.tempRepo);
  const m = (await ok("repo", "list")).repos.find(
    (repo: { kind?: string }) => repo.kind !== "borrowed"
  );
  const before = snapshot(f.tempRepo);
  const original = Child.commandResult;
  let transport = 0;
  const spy = vi.spyOn(Child, "commandResult").mockImplementation((command, options) => {
    if (
      command._tag === "StandardCommand" &&
      command.args.some((arg) => ["ls-remote", "fetch"].includes(arg))
    )
      transport++;
    return original(command, options);
  });
  const r = await cli(...args(f.repo.id), "--repo", m.id);
  spy.mockRestore();
  expect(r.code, r.output).toBe(1);
  expect(transport).toBe(0);
  preserved(before);
});
it("preserves confirmed receipt and unknown admission on fiber interruption without replay", async () => {
  const f = await fixture();
  const before = snapshot(f.tempRepo);
  let ready!: () => void;
  const reached = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const original = Store.writeJsonFileAtomic;
  let paused = false;
  const spy = vi.spyOn(Store, "writeJsonFileAtomic").mockImplementation((file, value) => {
    const result = original(file, value);
    const shouldPause =
      !paused &&
      file.startsWith(path.join(f.home, "operations") + path.sep) &&
      JSON.stringify(value).includes('"stage":"receipt-confirmed"');
    if (shouldPause) paused = true;
    return shouldPause
      ? result.pipe(Effect.andThen(Effect.sync(ready)), Effect.andThen(Effect.never))
      : result;
  });
  const fiber = Effect.runFork(
    runCreate(args(f.repo.id).slice(1), { interactive: false }).pipe(
      Effect.provide(NodeServices.layer)
    )
  );
  await Promise.race([
    reached,
    Effect.runPromise(Fiber.await(fiber)).then((exit) => {
      throw new Error(`Creation ended before receipt pause: ${JSON.stringify(exit)}`);
    }),
  ]);
  await Effect.runPromise(Fiber.interrupt(fiber));
  spy.mockRestore();
  preserved(before);
  expect(git(f.tempRepo, "for-each-ref", "--format=%(objectname)", "refs/outpost/base-fetch")).toBe(
    f.fresh
  );
  expect(existsSync(path.join(f.home, "workspaces/FRESH.json"))).toBe(false);
  expect((await cli(...args(f.repo.id))).code).toBe(1);
});
it("preserves borrowed A-B-A branch/reflog and readable unique B after late failed fresh admission", async () => {
  const f = await fixture();
  const before = snapshot(f.tempRepo);
  const original = Store.writeJsonFileAtomic;
  const checkout = path.join(f.home, "worktrees", "FRESH", "app");
  let unique = "";
  let history = "";
  const spy = vi.spyOn(Store, "writeJsonFileAtomic").mockImplementation((file, value) => {
    if (
      file.startsWith(path.join(f.home, "operations") + path.sep) &&
      JSON.stringify(value).includes('"action":"write-workspace-manifest"')
    ) {
      git(checkout, "commit", "--allow-empty", "-m", "unique B");
      unique = git(checkout, "rev-parse", "HEAD");
      git(checkout, "update-ref", "refs/heads/feat/FRESH", f.fresh, unique);
      history = readFileSync(
        path.join(f.tempRepo, ".git", "logs", "refs", "heads", "feat", "FRESH"),
        "utf8"
      );
      return Effect.fail(new Store.StoreError({ message: "Synthetic late failure" }));
    }
    return original(file, value);
  });
  const r = await cli(...args(f.repo.id));
  spy.mockRestore();
  expect(r.code, r.output).toBe(1);
  expect(unique).not.toBe("");
  expect(git(f.tempRepo, "cat-file", "-t", unique)).toBe("commit");
  expect(git(f.tempRepo, "rev-parse", "feat/FRESH")).toBe(f.fresh);
  expect(
    readFileSync(path.join(f.tempRepo, ".git", "logs", "refs", "heads", "feat", "FRESH"), "utf8")
  ).toBe(history);
  expect(history).toContain(unique);
  expect(existsSync(checkout)).toBe(true);
  preserved(before);
});
it("keeps original provenance and resume eligibility if a historical receipt disappears", async () => {
  const f = await fixture();
  const made = await ok(...args(f.repo.id));
  const receipt = made.worktrees[0].fetchReceipt;
  git(f.tempRepo, "update-ref", "--no-deref", "-d", receipt.ref, receipt.commit);
  const resumed = await ok("workspace", "resume", "FRESH");
  expect(resumed.resumable).toBe(true);
  expect(resumed.worktrees[0].receiptObservation).toBe("missing");
  expect(resumed.worktrees[0].originalBase.fetchReceipt).toEqual(receipt);
  expect((await ok("workspace", "show", "FRESH")).worktrees[0].receiptObservation).toBe("missing");
  await ok("workspace", "remove", "FRESH");
  expect(
    (await ok("doctor")).operationRecords.find(
      (r: { kind: string }) => r.kind === "completed-fresh"
    ).receiptObservations[0].status
  ).toBe("missing");
});
it("refuses success if durable completed inventory cannot be confirmed while preserving published evidence", async () => {
  const f = await fixture();
  const original = Store.writeJsonFileAtomic;
  const spy = vi
    .spyOn(Store, "writeJsonFileAtomic")
    .mockImplementation((file, value) =>
      JSON.stringify(value).includes('"kind":"fresh-receipt-inventory"')
        ? Effect.fail(new Store.StoreError({ message: "Synthetic inventory write failure" }))
        : original(file, value)
    );
  const r = await cli(...args(f.repo.id));
  spy.mockRestore();
  expect(r.code, r.output).toBe(1);
  expect(existsSync(path.join(f.home, "workspaces/FRESH.json"))).toBe(true);
  expect(git(f.tempRepo, "for-each-ref", "--format=%(objectname)", "refs/outpost/base-fetch")).toBe(
    f.fresh
  );
  expect((await cli(...args(f.repo.id))).code).toBe(1);
});
it("uses a single selection deadline across members and retains earlier confirmed receipt on expiry", async () => {
  const first = await fixture();
  const second = await fixture();
  process.env.OUTPOST_HOME = first.home;
  const other = (await ok("repo", "register", second.tempRepo, "--name", "other")).repository;
  const beforeFirst = snapshot(first.tempRepo);
  const beforeSecond = snapshot(second.tempRepo);
  const originalClock = performance.now.bind(performance);
  let elapsed = 0;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => originalClock() + elapsed);
  const original = Store.writeJsonFileAtomic;
  const spy = vi.spyOn(Store, "writeJsonFileAtomic").mockImplementation((file, value) =>
    original(file, value).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          if (
            file.startsWith(path.join(first.home, "operations") + path.sep) &&
            JSON.stringify(value).includes('"stage":"receipt-confirmed"')
          )
            elapsed = 121_000;
        })
      )
    )
  );
  const r = await cli(...args(first.repo.id), "--repo", other.id);
  spy.mockRestore();
  clock.mockRestore();
  expect(r.code, r.output).toBe(1);
  expect(elapsed).toBe(121_000);
  expect(
    git(first.tempRepo, "for-each-ref", "--format=%(objectname)", "refs/outpost/base-fetch")
  ).toBe(first.fresh);
  expect(
    git(second.tempRepo, "for-each-ref", "--format=%(objectname)", "refs/outpost/base-fetch")
  ).toBe("");
  expect(() => git(second.tempRepo, "cat-file", "-e", second.fresh)).toThrow();
  expect(existsSync(path.join(first.home, "workspaces/FRESH.json"))).toBe(false);
  preserved(beforeFirst);
  preserved(beforeSecond);
});
it("retains no receipt when the shared selection deadline expires before admission", async () => {
  const f = await fixture();
  const original = Child.commandResult;
  const spy = vi.spyOn(Child, "commandResult").mockImplementation((command, options) => {
    if (command._tag === "StandardCommand" && command.args.includes("ls-remote"))
      return original(command, options).pipe(
        Effect.andThen(Effect.sleep(100)),
        Effect.andThen(
          Effect.fail(
            systemError({
              _tag: "Unknown",
              module: "ChildProcess",
              method: "execute",
              description: "Synthetic delayed transport",
            })
          )
        )
      );
    return original(command, options);
  });
  const deadline = vi
    .spyOn(Fresh, "freshDeadline")
    .mockImplementation(() => Effect.succeed(performance.now() + 50));
  const r = await cli(...args(f.repo.id));
  spy.mockRestore();
  deadline.mockRestore();
  expect(r.code, r.output).toBe(1);
  expect(git(f.tempRepo, "for-each-ref", "--format=%(objectname)", "refs/outpost/base-fetch")).toBe(
    ""
  );
});
it("uses saved linked worktree-only helper/includes noninteractively for synthetic loopback fresh only", async () => {
  const { freshLoopback } = await import("../scripts/fresh-fixtures.mjs");
  const f = await fixture();
  const service = await freshLoopback(f.tempRemote, createTempDir("ofa-"));
  try {
    const anchor = path.join(createTempDir("ofl-"), "linked");
    git(f.tempRepo, "worktree", "add", "--detach", anchor, "HEAD");
    git(f.tempRepo, "config", "extensions.worktreeConfig", "true");
    const include = path.join(createTempDir("ofi-"), "anchor.inc");
    git(anchor, "config", "--file", include, "remote.team.url", service.url);
    git(anchor, "config", "--file", include, "credential.helper", service.helperCommand);
    git(anchor, "config", "--file", include, "core.askPass", service.askpassCommand);
    git(anchor, "config", "--file", include, "http.proxy", "");
    const privateDir = git(anchor, "rev-parse", "--absolute-git-dir").replaceAll("\\", "/");
    git(
      anchor,
      "config",
      "--worktree",
      `includeIf.gitdir:${privateDir}.path`,
      include.replaceAll("\\", "/")
    );
    expect(git(anchor, "remote", "get-url", "team")).toBe(service.url);
    git(anchor, "update-index", "--split-index");
    const home = createTempDir("oflh-");
    process.env.OUTPOST_HOME = home;
    await ok("init");
    const linked = (await ok("repo", "register", anchor, "--name", "linked")).repository;
    const a = args(linked.id);
    a[a.indexOf("origin")] = "team";
    const before = snapshot(f.tempRepo);
    const linkedBefore = snapshot(anchor);
    await ok(...a, "--dry-run");
    expect(existsSync(service.helperLog)).toBe(false);
    expect(service.authenticated).toBe(0);
    const diagnostics: object[] = [];
    const adapter = Child.commandResult;
    const debug = vi.spyOn(Child, "commandResult").mockImplementation((command, options) =>
      adapter(command, options).pipe(
        Effect.tap((r) =>
          Effect.sync(() => {
            if (command._tag === "StandardCommand" && command.args.includes("ls-remote"))
              diagnostics.push({
                code: r.exitCode,
                stdoutBytes: r.stdout.text.length,
                stderrBytes: r.stderr.text.length,
                stderrTruncated: r.stderr.truncated,
                authenticated: service.authenticated,
              });
          })
        )
      )
    );
    const attempt = await cli(...a);
    debug.mockRestore();
    expect(
      attempt.code,
      JSON.stringify(diagnostics) +
        attempt.output +
        JSON.stringify(
          readdirSync(path.join(home, "operations")).map((name) =>
            JSON.parse(readFileSync(path.join(home, "operations", name), "utf8"))
          )
        )
    ).toBe(0);
    const made = attempt.data;
    expect(made.worktrees[0].baseCommit).toBe(f.fresh);
    expect(service.authenticated).toBeGreaterThan(0);
    expect(readFileSync(service.helperLog, "utf8")).toMatch(/get/);
    expect(existsSync(service.askpassMarker)).toBe(false);
    expect(() => git(f.tempRepo, "config", "--get", "remote.team.url")).toThrow();
    // Source metadata and linked private/shared indexes are unchanged; only receipt and new objects/admin were added.
    preserved(before);
    preserved(linkedBefore);
    git(f.tempRepo, "worktree", "remove", anchor);
    expect((await ok("workspace", "resume", "FRESH")).resumable).toBe(true);
    await ok("workspace", "remove", "FRESH");
    for (const file of Object.keys(snapshot(home)))
      expect(readFileSync(file, "utf8"), file).not.toContain("SYNTHETIC_FRESH_CREDENTIAL_49");
  } finally {
    await service.close();
  }
});
it("terminates only operation-owned synthetic helper descendants on fresh interruption", async () => {
  const f = await fixture();
  const directory = createTempDir("ofp-");
  const marker = path.join(directory, "pids.json");
  const driver = path.join(directory, "stall.mjs");
  writeFileSync(
    driver,
    `import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';const child=spawn(process.execPath,['-e',"setInterval(()=>{},1000)"],{stdio:'ignore'});writeFileSync(${JSON.stringify(marker)},JSON.stringify([process.pid,child.pid]));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`
  );
  git(f.tempRepo, "config", "remote.origin.uploadpack", `node "${driver.replaceAll("\\", "/")}"`);
  const before = snapshot(f.tempRepo);
  const fiber = Effect.runFork(
    runCreate(args(f.repo.id).slice(1), { interactive: false }).pipe(
      Effect.provide(NodeServices.layer)
    )
  );
  const reached = Effect.runPromise(
    Effect.gen(function* () {
      while (!existsSync(marker)) yield* Effect.sleep(10);
    }).pipe(
      Effect.timeoutOrElse({
        duration: 4000,
        orElse: () => Effect.fail(new Error("Owned helper did not start")),
      })
    )
  );
  await Promise.race([
    reached,
    Effect.runPromise(Fiber.await(fiber)).then((exit) => {
      throw new Error(`Creation ended before owned-helper pause: ${JSON.stringify(exit)}`);
    }),
  ]);
  const pids: number[] = JSON.parse(readFileSync(marker, "utf8"));
  await Effect.runPromise(Fiber.interrupt(fiber));
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  // Check children actually disappear; the product does not claim control over detached or shared services.
  await Effect.runPromise(
    Effect.gen(function* () {
      for (let i = 0; i < 100 && pids.some(alive); i++) yield* Effect.sleep(10);
    })
  );
  expect(pids.filter(alive)).toEqual([]);
  preserved(before);
  expect(existsSync(path.join(f.home, "workspaces/FRESH.json"))).toBe(false);
}, 15_000);
it.each([205, 206])(
  "runs named fresh at common %ibyte Windows derived-admin boundary without shortening budgets",
  async (bytes) => {
    const outer = realpathSync.native(createTempDir("ofb-"));
    const source = path.join(outer, "s".repeat(bytes - Buffer.byteLength(outer, "utf8") - 6));
    mkdirSync(source);
    git(source, "init", "-b", "main");
    git(source, "config", "core.autocrlf", "false");
    writeFileSync(path.join(source, "README"), "boundary\n");
    git(source, "add", ".");
    git(source, "commit", "-m", "boundary");
    const remote = path.join(createTempDir("ofbr-"), "r.git");
    git(source, "clone", "--bare", source, remote);
    git(source, "remote", "add", "origin", remote);
    const home = createTempDir("ofbh-");
    process.env.OUTPOST_HOME = home;
    await ok("init");
    const name = "outpost-create-repo-fixed0";
    const repo = (await ok("repo", "register", source, "--name", name)).repository;
    mkdirSync(path.join(source, ".git", "worktrees"));
    writeFileSync(path.join(source, ".git", "worktrees", name), "foreign admin sentinel\n");
    expect(Buffer.byteLength(path.join(source, ".git"), "utf8")).toBe(bytes);
    const before = snapshot(source);
    const original = Child.commandResult;
    let transports = 0;
    const spy = vi.spyOn(Child, "commandResult").mockImplementation((command, options) => {
      if (
        command._tag === "StandardCommand" &&
        command.args.some((arg) => ["fetch", "ls-remote"].includes(arg))
      )
        transports++;
      return original(command, options);
    });
    if (process.platform === "win32" && bytes === 206) {
      const r = await cli(...args(repo.id, "BOUNDARY"));
      expect(r.code, r.output).toBe(1);
      expect(transports).toBe(0);
      expect(git(source, "branch", "--list", "feat/BOUNDARY")).toBe("");
      expect(git(source, "for-each-ref", "--format=%(refname)", "refs/outpost/base-fetch")).toBe(
        ""
      );
    } else {
      const made = await ok(...args(repo.id, "BOUNDARY"));
      const member = made.worktrees[0];
      if (bytes === 205)
        expect(git(member.path, "rev-parse", "--absolute-git-dir").length).toBe(243);
      expect(member.fetchReceipt.ref).toBe(member.baseRef);
      expect(transports).toBe(2);
      expect((await ok("workspace", "resume", "BOUNDARY")).resumable).toBe(true);
      await ok("workspace", "remove", "BOUNDARY");
      expect(git(source, "rev-parse", member.fetchReceipt.ref)).toBe(member.baseCommit);
    }
    spy.mockRestore();
    preserved(before);
  }
);
it.each(["pack-directory", "fanout", "pack", "idx", "rev", "keep", "midx", "midx-chain"])(
  "refuses incoming %s alias before any advertisement/helper or external write",
  async (kind) => {
    const f = await fixture();
    const external = createTempDir("of-alias-");
    const sentinel = path.join(external, "sentinel");
    writeFileSync(sentinel, "preserve\n");
    const objects = path.join(f.tempRepo, ".git", "objects");
    const pack = path.join(objects, "pack");
    if (kind === "pack-directory") {
      renameSync(pack, `${pack}-held`);
      symlinkSync(external, pack, "junction");
    } else if (kind === "fanout") {
      const dir = path.join(objects, f.fresh.slice(0, 2));
      if (existsSync(dir)) renameSync(dir, `${dir}-held`);
      symlinkSync(external, dir, "junction");
    } else if (kind === "midx-chain") {
      symlinkSync(external, path.join(pack, "multi-pack-index.d"), "junction");
    } else {
      const target = path.join(external, "metadata");
      writeFileSync(target, "do not adopt\n");
      const leaf = kind === "midx" ? "multi-pack-index" : `pack-${"1".repeat(40)}.${kind}`;
      symlinkSync(target, path.join(pack, leaf), "file");
    }
    const before = snapshot(external);
    const original = Child.commandResult;
    let transports = 0;
    const spy = vi.spyOn(Child, "commandResult").mockImplementation((command, options) => {
      if (
        command._tag === "StandardCommand" &&
        command.args.some((arg) => ["ls-remote", "fetch"].includes(arg))
      )
        transports++;
      return original(command, options);
    });
    const r = await cli(...args(f.repo.id));
    spy.mockRestore();
    expect(r.code, r.output).toBe(1);
    expect(transports).toBe(0);
    preserved(before);
    expect(readdirSync(external).sort()).toEqual(
      Object.keys(before)
        .map((p) => path.basename(p))
        .sort()
    );
    expect(existsSync(path.join(f.home, "workspaces/FRESH.json"))).toBe(false);
  }
);
it("rechecks incoming storage after advertisement and before fetch rather than writing through a raced alias", async () => {
  const f = await fixture();
  const external = createTempDir("of-race-");
  writeFileSync(path.join(external, "sentinel"), "preserve\n");
  const pack = path.join(f.tempRepo, ".git", "objects", "pack");
  const before = snapshot(external);
  let fetches = 0;
  let injected = false;
  const original = Child.commandResult;
  const spy = vi.spyOn(Child, "commandResult").mockImplementation((command, options) =>
    original(command, options).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          if (command._tag !== "StandardCommand") return;
          if (command.args.includes("fetch")) fetches++;
          if (command.args.includes("ls-remote")) {
            renameSync(pack, `${pack}-held`);
            symlinkSync(external, pack, "junction");
            injected = true;
          }
        })
      )
    )
  );
  const r = await cli(...args(f.repo.id));
  spy.mockRestore();
  expect(r.code, r.output).toBe(1);
  expect(injected).toBe(true);
  expect(fetches).toBe(0);
  preserved(before);
  expect(readdirSync(external)).toEqual(["sentinel"]);
});
it.each([1, 1_000_000])(
  "keeps incoming objects packed despite unpackLimit=%i without changing loose/source files",
  async (limit) => {
    const f = await fixture();
    git(f.tempRepo, "config", "fetch.unpackLimit", String(limit));
    git(f.tempRepo, "config", "transfer.unpackLimit", String(limit));
    const objects = path.join(f.tempRepo, ".git", "objects");
    const loose = () =>
      Object.keys(snapshot(objects))
        .filter((file) => /\/objects\/[0-9a-f]{2}\//.test(file.replaceAll("\\", "/")))
        .sort();
    const beforeLoose = loose();
    const before = snapshot(f.tempRepo);
    const made = await ok(...args(f.repo.id));
    expect(made.worktrees[0].baseCommit).toBe(f.fresh);
    expect(loose()).toEqual(beforeLoose);
    preserved(before);
    const entries = readdirSync(path.join(objects, "pack"));
    expect(entries.some((name) => name.endsWith(".pack"))).toBe(true);
    expect(entries.some((name) => name.endsWith(".idx"))).toBe(true);
    console.info(
      JSON.stringify({
        freshPackedLimit: limit,
        remainingKeepEntries: entries.filter((name) => name.endsWith(".keep")),
      })
    );
  }
);
it("does not write through an incoming loose-blob leaf alias while retaining post-fetch ownership refusal", async () => {
  const f = await fixture();
  const blob = git(f.writer, "rev-parse", `${f.fresh}:fresh`);
  const external = createTempDir("of-leaf-");
  const target = path.join(external, "blob");
  writeFileSync(
    target,
    readFileSync(path.join(f.writer, ".git", "objects", blob.slice(0, 2), blob.slice(2)))
  );
  const fanout = path.join(f.tempRepo, ".git", "objects", blob.slice(0, 2));
  mkdirSync(fanout, { recursive: true });
  const leaf = path.join(fanout, blob.slice(2));
  symlinkSync(target, leaf, "file");
  const before = snapshot(external);
  const r = await cli(...args(f.repo.id));
  expect(r.code, r.output).toBe(1);
  preserved(before);
  expect(readdirSync(external)).toEqual(["blob"]);
  expect(lstatSync(leaf).isSymbolicLink()).toBe(true);
  expect(
    readdirSync(path.join(f.tempRepo, ".git", "objects", "pack")).some((name) =>
      name.endsWith(".pack")
    )
  ).toBe(true);
  expect(existsSync(path.join(f.home, "workspaces/FRESH.json"))).toBe(false);
});
it("preflights every member's incoming store before the first transport", async () => {
  const first = await fixture();
  const second = await fixture();
  process.env.OUTPOST_HOME = first.home;
  const other = (await ok("repo", "register", second.tempRepo, "--name", "other")).repository;
  const external = createTempDir("of-multi-alias-");
  writeFileSync(path.join(external, "sentinel"), "keep\n");
  const pack = path.join(second.tempRepo, ".git", "objects", "pack");
  renameSync(pack, `${pack}-held`);
  symlinkSync(external, pack, "junction");
  const before = snapshot(external);
  let transports = 0;
  const original = Child.commandResult;
  const spy = vi.spyOn(Child, "commandResult").mockImplementation((command, options) => {
    if (
      command._tag === "StandardCommand" &&
      command.args.some((arg) => ["fetch", "ls-remote"].includes(arg))
    )
      transports++;
    return original(command, options);
  });
  const r = await cli(...args(first.repo.id), "--repo", other.id);
  spy.mockRestore();
  expect(r.code, r.output).toBe(1);
  expect(transports).toBe(0);
  preserved(before);
  expect(readdirSync(external)).toEqual(["sentinel"]);
});
it("refuses fresh transport with unreadable operation metadata without changing managed retry semantics", async () => {
  const f = await fixture();
  const operations = path.join(f.home, "operations");
  mkdirSync(operations, { recursive: true });
  writeFileSync(path.join(operations, "unknown.json"), "{truncated");
  const before = snapshot(f.tempRepo);
  const r = await cli(...args(f.repo.id));
  expect(r.code, r.output).toBe(1);
  preserved(before);
  const managed = await createManagedRepoFixture({ repoName: "managed" });
  await ok("repo", "add", managed.tempRepo);
  const m = (await ok("repo", "list")).repos.find(
    (repo: { kind?: string }) => repo.kind !== "borrowed"
  );
  writeFileSync(
    path.join(operations, "prior-managed.json"),
    JSON.stringify({
      status: "interrupted-or-failed",
      steps: [{ action: "create-workspace", ticket: "MANAGED" }],
    })
  );
  const made = await ok("create", "--ticket", "MANAGED", "--type", "feat", "--repo", m.id);
  expect(made.worktrees[0].baseCommit).not.toBe(null);
  preserved(before);
});
it("journals frozen unattempted membership before a first-member remote failure", async () => {
  const first = await fixture();
  const second = await fixture();
  process.env.OUTPOST_HOME = first.home;
  const other = (await ok("repo", "register", second.tempRepo, "--name", "other")).repository;
  const a = args(first.repo.id);
  a[a.length - 1] = "missing";
  const before = snapshot(second.tempRepo);
  const r = await cli(...a, "--repo", other.id);
  expect(r.code, r.output).toBe(1);
  preserved(before);
  const journals = readdirSync(path.join(first.home, "operations")).map((name) =>
    JSON.parse(readFileSync(path.join(first.home, "operations", name), "utf8"))
  );
  const steps = journals.flatMap((j) => j.steps ?? []);
  const planned = steps.find(
    (step: { action: string }) => step.action === "borrowed-fresh-prepared"
  );
  expect(planned.members.map((member: { repoId: string }) => member.repoId)).toEqual([
    first.repo.id,
    other.id,
  ]);
  expect(planned.members[1]).toMatchObject({
    stage: "unattempted",
    remote: "origin",
    remoteRef: "refs/heads/missing",
  });
  expect(
    steps.some(
      (step: { action: string; repoId: string }) =>
        step.action === "borrowed-fresh" && step.repoId === other.id
    )
  ).toBe(false);
});
it.each([
  "prepare-workspace-provenance-state",
  "create-branch",
  "create-worktree",
  "write-workspace-manifest",
])(
  "refuses a directly observed binding change at %s after confirmed receipt without persisting URL",
  async (stage) => {
    const f = await fixture();
    const replacement = path.join(createTempDir("of-binding-"), "SYNTHETIC_BINDING_SECRET");
    const original = Store.writeJsonFileAtomic;
    let changed = false;
    const spy = vi.spyOn(Store, "writeJsonFileAtomic").mockImplementation((file, value) =>
      original(file, value).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            if (
              !changed &&
              file.startsWith(path.join(f.home, "operations") + path.sep) &&
              JSON.stringify(value).includes(`"action":"${stage}"`)
            ) {
              changed = true;
              git(f.tempRepo, "config", "remote.origin.url", replacement);
            }
          })
        )
      )
    );
    const r = await cli(...args(f.repo.id));
    spy.mockRestore();
    expect(changed).toBe(true);
    expect(r.code, r.output).toBe(1);
    expect(r.output).not.toContain("SYNTHETIC_BINDING_SECRET");
    for (const file of Object.keys(snapshot(f.home)))
      expect(readFileSync(file, "utf8"), file).not.toContain("SYNTHETIC_BINDING_SECRET");
    expect(
      git(f.tempRepo, "for-each-ref", "--format=%(objectname)", "refs/outpost/base-fetch")
    ).toBe(f.fresh);
    expect(git(f.tempRepo, "rev-parse", "main")).toBe(f.initial);
    expect(existsSync(path.join(f.home, "workspaces/FRESH.json"))).toBe(false);
  }
);
it("keeps completed receipt inventory discoverable when config is absent without calling it a live lock", async () => {
  const f = await fixture();
  const made = await ok(...args(f.repo.id));
  unlinkSync(path.join(f.home, "config.json"));
  const doctor = await ok("doctor");
  expect(doctor.initialized).toBe(false);
  expect(doctor.operationRecords.some((r: { kind: string }) => r.kind === "completed-fresh")).toBe(
    true
  );
  expect(doctor.diagnostics).toEqual([]);
  expect(existsSync(made.receiptInventory.path)).toBe(true);
});
