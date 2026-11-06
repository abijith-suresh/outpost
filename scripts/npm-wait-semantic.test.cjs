"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os");
const o = require("./npm-wait-observer.cjs");
const fake = () => ({ enable() {}, disable() {} });
function pending(observer, operation) {
  return observer.runAttempt(false, () => {
    operation();
    return new Promise(() => {});
  });
}
const read = (observer) => o.validateWaitCheckpoint(observer.snapshot()).pending[0].semantic;

test("synthetic semantic positive/zero/error reads never inspect data/errors; retirement covers skips/errors", () => {
  let now = 0;
  const observer = o.createWaitObserver({ clock: () => now, hookFactory: fake });
  const poison = new Proxy(
    {},
    {
      get() {
        throw Error("PRIVATE_OBJECT_READ");
      },
    }
  );
  try {
    pending(observer, () => {
      const context = {};
      let received;
      const original = function (...args) {
        assert.equal(this, context);
        received = args;
        return poison;
      };
      const wrapper = o.wrapReadBoundary(original, observer);
      assert.equal(wrapper.call(context, null, 17, poison), poison);
      assert.equal(received[2], poison);
      assert.equal(wrapper.call(context, false, 0, poison), poison);
      assert.equal(read(observer).lastReadResult, "zero");
      now = 30;
      let state = read(observer);
      assert.equal(state.positiveReadBytes, 17);
      assert.equal(state.lastPositiveReadAgeMs, 30);
      assert.equal(state.lastReadResult, "zero");
      wrapper.call(context, null, 0, poison);
      assert.equal(read(observer).lastReadResult, "zero");
      wrapper.call(context, poison, undefined, poison);
      state = read(observer);
      assert.equal(state.lastReadResult, "error");
      assert.equal(state.positiveReadBytes, 17);
      // Same retire method boundary for normal, skipped and error-retired entry work; no entry inspection.
      const retired = o.wrapRetireBoundary(function (value) {
        assert.equal(this, context);
        return value;
      }, observer);
      const promise = Promise.resolve(3);
      for (const value of ["skip", "error", promise])
        assert.equal(retired.call(context, value), value);
      now = 40;
      state = read(observer);
      assert.equal(state.retiredEntryWork, 3);
      assert.equal(state.lastRetiredAgeMs, 10);
    });
    assert.doesNotMatch(
      JSON.stringify(observer.snapshot()),
      /PRIVATE|lastPositiveReadAt|lastRetiredAt|raw|entryName|path/
    );
  } finally {
    observer.stop();
  }
});

test("fixed wrappers preserve thrown error, arguments, this and promise when instrumentation throws", () => {
  const failure = new Error("PRIVATE_ORIGINAL");
  const argument = {},
    context = {};
  const broken = {
    readBoundary() {
      throw Error("PRIVATE_OBSERVER");
    },
    retireBoundary() {
      throw Error("PRIVATE_OBSERVER");
    },
  };
  const promise = Promise.resolve(7);
  const original = function (...args) {
    assert.equal(this, context);
    assert.equal(args[2], argument);
    return promise;
  };
  assert.equal(o.wrapReadBoundary(original, broken).call(context, null, 5, argument), promise);
  assert.equal(o.wrapRetireBoundary(original, broken).call(context, null, 5, argument), promise);
  for (const wrap of [o.wrapReadBoundary, o.wrapRetireBoundary])
    assert.throws(
      () =>
        wrap(() => {
          throw failure;
        }, broken).call(context),
      (e) => e === failure
    );
  const observer = o.createWaitObserver({ hookFactory: fake });
  try {
    pending(observer, () => {
      assert.throws(
        () =>
          o.wrapRetireBoundary(() => {
            throw failure;
          }, observer)(),
        (e) => e === failure
      );
      assert.equal(read(observer).retiredEntryWork, 0);
    });
  } finally {
    observer.stop();
  }
});

test("missing context ignored; false optional context works; semantic cap/time faults produce unknown", () => {
  const observer = o.createWaitObserver({ hookFactory: fake });
  try {
    observer.readBoundary(false, 100);
    observer.retireBoundary();
    assert.equal(observer.snapshot().trackedAttempts, 0);
    assert.equal(observer.snapshot().coverage, "observed");
    pending(observer, () => {
      observer.readBoundary(false, 2147483647);
      for (let i = 0; i < 65536; i++) observer.retireBoundary();
    });
    const record = o.validateWaitCheckpoint(observer.snapshot());
    assert.equal(record.pending[0].optional, false);
    assert.equal(record.coverage, "unknown");
    assert.equal(record.pending[0].semantic.retiredEntryWork, 65535);
  } finally {
    observer.stop();
  }
  for (const value of [NaN, -1, Infinity, "PRIVATE_BYTES"]) {
    const x = o.createWaitObserver({ hookFactory: fake });
    try {
      pending(x, () => x.readBoundary(false, value));
      const record = o.validateWaitCheckpoint(x.snapshot());
      assert.equal(record.coverage, "unknown");
      assert.equal(record.pending[0].semantic.lastReadResult, "unknown");
    } finally {
      x.stop();
    }
  }
  let now = 0;
  const x = o.createWaitObserver({ hookFactory: fake, clock: () => now });
  try {
    pending(x, () => {
      now = NaN;
      x.readBoundary(false, 1);
      x.retireBoundary();
    });
    assert.equal(o.validateWaitCheckpoint(x.snapshot()).coverage, "unknown");
  } finally {
    x.stop();
  }
});

test("strict v3 semantic schema refuses old versions, internal fields, forged counts/classification", () => {
  const observer = o.createWaitObserver({ hookFactory: fake });
  try {
    pending(observer, () => observer.readBoundary(false, 2));
    const good = observer.snapshot();
    for (const mutate of [
      (v) => {
        v.npmWaitProbe = 1;
      },
      (v) => {
        v.npmWaitProbe = 2;
      },
      (v) => {
        v.pending[0].semantic.path = "PRIVATE";
      },
      (v) => {
        v.pending[0].semantic.lastRetiredAt = 7;
      },
      (v) => {
        v.pending[0].semantic.positiveReadBytes = 2147483648;
      },
      (v) => {
        v.pending[0].semantic.readSeen = false;
      },
      (v) => {
        v.pending[0].semantic.lastPositiveReadAgeMs = null;
      },
    ]) {
      const value = structuredClone(good);
      mutate(value);
      assert.throws(() => o.validateWaitCheckpoint(value));
    }
  } finally {
    observer.stop();
  }
});

test("two additional exact source/method pins fail closed before patching, old constants remain intact", (t) => {
  const entry = process.env.npm_execpath;
  const verified = o.verifyPinnedNpm(entry);
  assert.equal(Object.keys(o.PINNED).length, 11);
  assert.equal(Object.keys(o.HOOK_HASHES).length, 5);
  assert.equal(Object.keys(o.EXTRA_PINNED).length, 2);
  assert.equal(Object.keys(o.EXTRA_HOOK_HASHES).length, 2);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "outpost-semantic-pin-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const name of ["package.json", ...Object.keys(o.PINNED), ...Object.keys(o.EXTRA_PINNED)]) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.copyFileSync(path.join(verified.root, name), path.join(dir, name));
  }
  fs.appendFileSync(path.join(dir, "node_modules/fs-minipass/lib/index.js"), "\n");
  assert.throws(() => o.verifyPinnedNpm(path.join(dir, "bin/npm-cli.js")), {
    code: "INVALID_NPM_WAIT_PROBE",
    reason: "pin-mismatch",
  });
  const { ReadStream } = require(path.join(verified.root, "node_modules/fs-minipass"));
  const tar = require(path.join(verified.root, "node_modules/tar"));
  for (const [prototype, name] of [
    [ReadStream.prototype, "_onread"],
    [tar.Unpack.prototype, "unpend"],
  ]) {
    const key = Object.getOwnPropertySymbols(prototype).find((k) => k.description === name),
      descriptor = Object.getOwnPropertyDescriptor(prototype, key);
    Object.defineProperty(prototype, key, { ...descriptor, value: function changed() {} });
    try {
      assert.throws(() => o.attachPinnedNpmObserver(entry), {
        code: "INVALID_NPM_WAIT_PROBE",
        reason: "hook-mismatch",
      });
    } finally {
      Object.defineProperty(prototype, key, descriptor);
    }
  }
});

test("parent preflight fixed IDs extend to thirteen sources and seven methods, restore both new hooks", async () => {
  const { parentPreflight } = await import("./npm-wait-preflight.mjs");
  const entry = process.env.npm_execpath,
    verified = o.verifyPinnedNpm(entry);
  const { ReadStream } = require(path.join(verified.root, "node_modules/fs-minipass")),
    tar = require(path.join(verified.root, "node_modules/tar"));
  const targets = [
    [ReadStream.prototype, "_onread"],
    [tar.Unpack.prototype, "unpend"],
  ].map(([prototype, name]) => {
    const key = Object.getOwnPropertySymbols(prototype).find((k) => k.description === name);
    return { prototype, key, original: prototype[key] };
  });
  const records = [];
  const active = parentPreflight(
    2,
    (r) => records.push(r),
    (trace) => o.attachPinnedNpmObserver(entry, {}, trace)
  );
  try {
    assert.equal(records[0].files.length, 13);
    assert.equal(records[0].hooks.length, 7);
    assert.ok(records[0].files.every((r) => r.hashMatch));
    assert.ok(records[0].hooks.every((r) => r.hashMatch));
    for (const target of targets) assert.notEqual(target.prototype[target.key], target.original);
    assert.ok(Buffer.byteLength(JSON.stringify(records[0])) <= 8192);
  } finally {
    active.stop();
  }
  for (const target of targets) assert.equal(target.prototype[target.key], target.original);
});
