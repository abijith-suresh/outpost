"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const {
  LIMITS,
  PHASES,
  verifyPinnedNpm,
  createWaitObserver,
  attachPinnedNpmObserver,
  validateWaitCheckpoint,
  readWaitCheckpoint,
} = require("./npm-wait-observer.cjs");
const entry = process.env.npm_execpath;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const fakeHooks = () => ({ enable() {}, disable() {} });
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "outpost wait light-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("exact installed npm sources and hook points are verified; mismatches refuse before probe", (t) => {
  assert.ok(entry, "Supply verified npm JS entry through npm_execpath for these light tests");
  const verified = verifyPinnedNpm(entry);
  const Arborist = require(path.join(verified.root, "node_modules/@npmcli/arborist"));
  const Fetcher = require(path.join(verified.root, "node_modules/pacote/lib/fetcher.js"));
  const before = [
    Arborist.prototype[Symbol.for("reifyNode")],
    Fetcher.prototype.extract,
    Fetcher.prototype.tarballStream,
  ];
  const observer = attachPinnedNpmObserver(entry);
  assert.notEqual(Arborist.prototype[Symbol.for("reifyNode")], before[0]);
  observer.stop();
  assert.equal(Arborist.prototype[Symbol.for("reifyNode")], before[0]);
  assert.equal(Fetcher.prototype.extract, before[1]);
  assert.equal(Fetcher.prototype.tarballStream, before[2]);
  const dir = fixture(t),
    bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.copyFileSync(verified.entry, path.join(bin, "npm-cli.js"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: "11.16.0" }));
  assert.throws(
    () => attachPinnedNpmObserver(path.join(bin, "npm-cli.js")),
    (e) =>
      e.code === "INVALID_NPM_WAIT_PROBE" && e.reason === "pin-mismatch" && !e.message.includes(dir)
  );
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: "11.16.1" }));
  assert.throws(() => verifyPinnedNpm(path.join(bin, "npm-cli.js")), {
    code: "INVALID_NPM_WAIT_PROBE",
  });
  // Matching files but missing OR replaced in-memory hooks refuse before instrumentation.
  for (const replacement of [null, function changedHook() {}]) {
    Object.defineProperty(Arborist.prototype, Symbol.for("reifyNode"), {
      configurable: true,
      value: replacement,
    });
    try {
      assert.throws(
        () => attachPinnedNpmObserver(entry),
        (e) => e.reason === "hook-mismatch"
      );
      assert.equal(Fetcher.prototype.extract, before[1]);
    } finally {
      delete Arborist.prototype[Symbol.for("reifyNode")];
    }
  }
});

test("opaque observer separates pending/rejected/optional-handled inputs while actual allSettled waits", async () => {
  const verified = verifyPinnedNpm(entry);
  const allLate = require(path.join(verified.root, "node_modules/promise-all-reject-late"));
  const observer = createWaitObserver({ hookFactory: fakeHooks });
  let release, originalPending, originalRejected, originalHandled;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const one = observer.runAttempt(false, () => {
    originalPending = observer.observe("extract", () =>
      observer.observe("streamHandler", () => pending)
    );
    return originalPending;
  });
  const failure = Object.assign(new Error("PRIVATE_PATH_URI_CREDENTIAL"), { code: "EPERM" });
  const two = observer.runAttempt(false, () => {
    originalRejected = Promise.reject(failure);
    return originalRejected;
  });
  const three = observer.runAttempt(true, () => {
    const input = Promise.reject(failure);
    assert.equal(observer.trackPromise("optionalInput", input), input);
    originalHandled = input.catch(() => 17);
    return observer.observe("optionalResult", () => originalHandled);
  });
  assert.equal(one, originalPending);
  assert.equal(two, originalRejected);
  assert.equal(three, originalHandled);
  let barrierSettled = false,
    observed;
  const barrier = allLate([one, two, three]).then(
    () => {
      barrierSettled = true;
    },
    (e) => {
      barrierSettled = true;
      observed = e;
    }
  );
  await tick();
  const checkpoint = validateWaitCheckpoint(observer.snapshot());
  assert.equal(checkpoint.totals.node.pending, 1);
  assert.equal(checkpoint.totals.node.rejected, 1);
  assert.equal(checkpoint.totals.node.fulfilled, 1);
  assert.equal(checkpoint.optionalRejectedHandled, 1);
  assert.equal(checkpoint.pending[0].extract, "pending");
  assert.equal(checkpoint.pending[0].streamHandler, "pending");
  assert.equal(barrierSettled, false);
  assert.doesNotMatch(JSON.stringify(checkpoint), /PRIVATE|path|URI|message|stack/);
  release(42);
  await barrier;
  assert.equal(observed, failure);
  observer.stop();
});

test("sync throws, thenables, original values and failed sinks do not replace operation results", async () => {
  const observer = createWaitObserver({
    hookFactory: fakeHooks,
    sink() {
      throw new Error("PRIVATE_SINK");
    },
  });
  const failure = new Error("PRIVATE_ORIGINAL");
  assert.throws(
    () =>
      observer.runAttempt(false, () => {
        throw failure;
      }),
    (e) => e === failure
  );
  const value = {};
  assert.equal(
    observer.runAttempt(false, () => value),
    value
  );
  // biome-ignore lint/suspicious/noThenProperty: Verify that an arbitrary then getter is never read.
  const poison = Object.defineProperty({}, "then", {
    get() {
      throw failure;
    },
  });
  assert.equal(
    observer.runAttempt(false, () => poison),
    poison
  );
  assert.equal(
    observer.runAttempt(false, () => 99),
    99
  );
  const hostilePrototype = new Proxy(
    {},
    {
      getPrototypeOf() {
        throw failure;
      },
    }
  );
  assert.equal(
    observer.runAttempt(false, () => hostilePrototype),
    hostilePrototype
  );
  observer.emit();
  const originalRejected = Promise.reject(failure);
  const returned = observer.runAttempt(false, () => {
    observer.emit();
    return originalRejected;
  });
  assert.equal(returned, originalRejected);
  await assert.rejects(returned, (e) => e === failure);
  const checkpoint = observer.snapshot();
  assert.equal(checkpoint.coverage, "unknown");
  assert.equal(checkpoint.observerFault, true);
  observer.stop();
});

test("attempt/resource/row caps are exact and capacity loss is explicit unknown", async () => {
  let callbacks;
  const observer = createWaitObserver({
    hookFactory(c) {
      callbacks = c;
      return fakeHooks();
    },
  });
  const pending = new Promise(() => {});
  observer.runAttempt(false, () => {
    for (let i = 0; i <= LIMITS.resources; i++) callbacks.init(i, "FSREQPROMISE");
    callbacks.init(90000, "PRIVATE_RESOURCE");
    callbacks.init(90001, "__proto__");
    return pending;
  });
  for (let i = 1; i <= LIMITS.attempts; i++) observer.runAttempt(false, () => pending);
  const checkpoint = validateWaitCheckpoint(observer.snapshot());
  assert.equal(checkpoint.trackedAttempts, 1024);
  assert.equal(checkpoint.pending.length, 32);
  assert.equal(checkpoint.liveResources.fs, 4096);
  assert.equal(checkpoint.rowsTruncated, true);
  assert.equal(checkpoint.capacityLoss, true);
  assert.equal(checkpoint.coverage, "unknown");
  assert.ok(Buffer.byteLength(JSON.stringify(checkpoint)) <= 65536);
  callbacks.destroy(0);
  assert.equal(observer.snapshot().liveResources.fs, 4095);
  observer.stop();
});

test("only fixed phase/resource categories survive hostile event input", () => {
  let callbacks;
  const observer = createWaitObserver({
    hookFactory(c) {
      callbacks = c;
      return fakeHooks();
    },
  });
  process.emit("time", "start", "reify:unpack");
  process.emit("time", "start", "PRIVATE_RAW_PHASE_URI");
  observer.runAttempt(false, () => {
    callbacks.init(1, "FSREQCALLBACK");
    callbacks.init(2, "ZLIB");
    callbacks.init(3, "TLSWRAP");
    callbacks.init(4, Object.create(null));
    return new Promise(() => {});
  });
  const checkpoint = observer.snapshot();
  assert.equal(checkpoint.observerFault, true); // hostile coercion caught, not thrown into operation
  assert.deepEqual(checkpoint.liveResources, { fs: 1, decompression: 1, dns: 0, tcp: 0, tls: 1 });
  assert.equal(checkpoint.phases.find((p) => p.phase === "reify:unpack").starts, 1);
  assert.doesNotMatch(JSON.stringify(checkpoint), /PRIVATE|FSREQ|ZLIB|TLSWRAP/);
  assert.deepEqual(
    checkpoint.phases.map((p) => p.phase),
    PHASES
  );
  observer.stop();
});

test("bounded checkpoint reader rejects oversized/truncated/hostile fields and preserves fixture bytes", (t) => {
  const dir = fixture(t),
    file = path.join(dir, "checkpoint.json");
  const observer = createWaitObserver({ hookFactory: fakeHooks });
  const valid = observer.snapshot();
  fs.writeFileSync(file, JSON.stringify(valid));
  assert.deepEqual(readWaitCheckpoint(file), valid);
  for (const value of [
    { ...valid, path: "PRIVATE_PATH" },
    { ...valid, phases: [{ phase: "PRIVATE", starts: 0, ends: 0 }] },
    { ...valid, pending: [{ id: 1, name: "PRIVATE" }] },
    { ...valid, totals: { PRIVATE: 1 } },
    { ...valid, coverage: "success" },
    { ...valid, capacityLoss: true, coverage: "observed" },
  ]) {
    fs.writeFileSync(file, JSON.stringify(value));
    const before = fs.readFileSync(file);
    const result = readWaitCheckpoint(file);
    assert.equal(result.valid, false);
    assert.equal(result.coverage, "unknown");
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
    assert.deepEqual(fs.readFileSync(file), before);
  }
  fs.writeFileSync(file, "x".repeat(65537));
  assert.equal(readWaitCheckpoint(file).valid, false);
  fs.writeFileSync(file, '{"npmWaitProbe":1');
  assert.equal(readWaitCheckpoint(file).valid, false);
  assert.equal(readWaitCheckpoint(path.join(dir, "absent")).valid, false);
  observer.stop();
});

test("checkpoint interval is 5s unref and cannot keep a child process alive", () => {
  const file = require.resolve("./npm-wait-observer.cjs");
  const output = execFileSync(
    process.execPath,
    [
      "-e",
      `const {createWaitObserver,LIMITS}=require(${JSON.stringify(file)});if(LIMITS.intervalMs!==5000)throw Error('bad');createWaitObserver().startCheckpoints();process.stdout.write('SAFE');`,
    ],
    { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "pipe"] }
  );
  assert.equal(output, "SAFE");
});

test("real filesystem async resources are observable under opaque context without file contents", async (t) => {
  const dir = fixture(t),
    file = path.join(dir, "file");
  fs.writeFileSync(file, "PRIVATE_CONTENT");
  let callbacks,
    fsSeen = false;
  const { createHook } = require("node:async_hooks");
  const observer = createWaitObserver({
    hookFactory(c) {
      callbacks = c;
      return createHook({
        init(id, type) {
          if (type === "FSREQPROMISE") fsSeen = true;
          callbacks.init(id, type);
        },
        destroy(id) {
          callbacks.destroy(id);
        },
      });
    },
  });
  await observer.runAttempt(false, () => observer.observe("extract", () => fsp.readFile(file)));
  await tick();
  assert.equal(fsSeen, true);
  assert.doesNotMatch(JSON.stringify(observer.snapshot()), /PRIVATE|file/);
  observer.stop();
});

test("observer setup, clock and phase capacity faults stay unknown without replacing results", () => {
  const failure = new Error("PRIVATE_OBSERVER_FAILURE");
  let now = 0;
  const observer = createWaitObserver({
    hookFactory() {
      throw failure;
    },
    clock() {
      if (now++ > 0) throw failure;
      return 0;
    },
  });
  assert.equal(
    observer.runAttempt(false, () => 7),
    7
  );
  for (let i = 0; i < 4097; i++) process.emit("time", "start", "reify:unpack");
  const value = validateWaitCheckpoint(observer.snapshot());
  assert.equal(value.coverage, "unknown");
  assert.equal(value.observerFault, true);
  assert.equal(value.capacityLoss, true);
  assert.equal(value.phases.find((p) => p.phase === "reify:unpack").starts, 4096);
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE/);
  observer.stop();
});

test("actual pinned optional handler separates handled input and propagated required rejection", async () => {
  const verified = verifyPinnedNpm(entry);
  const Arborist = require(path.join(verified.root, "node_modules/@npmcli/arborist"));
  const observer = attachPinnedNpmObserver(entry);
  try {
    const failure = new Error("PRIVATE_OPTIONAL_FAILURE");
    const optional = { optional: true, edgesIn: new Set(), edgesOut: new Map() };
    let trashCalls = 0;
    const context = {
      [Symbol.for("addNodeToTrashList")]() {
        trashCalls++;
      },
    };
    const handle = Arborist.prototype[Symbol.for("handleOptionalFailure")];
    const handled = observer.runAttempt(true, () =>
      handle.call(context, optional, Promise.reject(failure))
    );
    assert.equal(await handled, optional);
    assert.equal(trashCalls, 1);
    const required = { optional: false };
    await assert.rejects(
      observer.runAttempt(false, () => handle.call(context, required, Promise.reject(failure))),
      (e) => e === failure
    );
    await tick();
    const checkpoint = validateWaitCheckpoint(observer.snapshot());
    assert.equal(checkpoint.optionalRejectedHandled, 1);
    assert.equal(checkpoint.totals.optionalInput.rejected, 2);
    assert.equal(checkpoint.totals.optionalResult.fulfilled, 1);
    assert.equal(checkpoint.totals.optionalResult.rejected, 1);
    assert.doesNotMatch(JSON.stringify(checkpoint), /PRIVATE|edges|trashCalls/);
  } finally {
    observer.stop();
  }
});
