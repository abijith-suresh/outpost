"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createHash, randomBytes } = require("node:crypto");
const { Writable } = require("node:stream");
const {
  createWaitObserver,
  validateWaitCheckpoint,
  verifyPinnedNpm,
} = require("./npm-wait-observer.cjs");
const owned = require("./npm-wait-owned.cjs");
const fake = () => ({ enable() {}, disable() {} });
function synthetic() {
  let callbacks,
    now = 0;
  const observer = createWaitObserver({
    clock: () => now,
    hookFactory(c) {
      callbacks = c;
      return fake();
    },
  });
  return {
    observer,
    get callbacks() {
      return callbacks;
    },
    time(n) {
      now = n;
    },
  };
}
const first = (o) => validateWaitCheckpoint(o.snapshot()).pending[0].fsActivity;

test("synthetic lifecycle distinguishes never-called, callback-seen and destroy; unrelated global IDs ignored", () => {
  const s = synthetic();
  try {
    s.callbacks.before(999);
    s.callbacks.after(999);
    s.callbacks.destroy(999);
    const promise = new Promise(() => {});
    assert.equal(
      s.observer.runAttempt(false, () => {
        s.callbacks.init(7, "FSREQCALLBACK");
        s.callbacks.init(8, "FSREQPROMISE");
        s.callbacks.init(9, "ZLIB");
        return promise;
      }),
      promise
    );
    s.time(50);
    let rows = first(s.observer);
    assert.equal(rows[0].liveNeverSeen, 1);
    assert.equal(rows[0].oldestLiveAgeMs, 50);
    assert.equal(rows[0].lastBeforeAgeMs, null);
    s.time(60);
    s.callbacks.before(7);
    s.time(62);
    s.callbacks.after(7);
    s.time(100);
    rows = first(s.observer);
    assert.equal(rows[0].before, 1);
    assert.equal(rows[0].after, 1);
    assert.equal(rows[0].liveSeen, 1);
    assert.equal(rows[0].lastBeforeAgeMs, 40);
    assert.equal(rows[0].lastAfterAgeMs, 38);
    assert.equal(rows[0].oldestLiveAgeMs, 100);
    assert.equal(rows[1].liveNeverSeen, 1);
    s.callbacks.destroy(7);
    rows = first(s.observer);
    assert.equal(rows[0].destroyed, 1);
    assert.equal(rows[0].oldestLiveAgeMs, null);
    assert.equal(rows[0].liveSeen, 0);
    assert.equal(s.observer.snapshot().coverage, "observed");
    assert.doesNotMatch(
      JSON.stringify(s.observer.snapshot()),
      /createdAt|lastBeforeAt|lastAfterAt|asyncId|beforeSeen|afterSeen|FSREQ|ZLIB/
    );
  } finally {
    s.observer.stop();
  }
});

test("synthetic saturation, corrupted tracked lifecycle and bad clocks are guarded unknown", () => {
  const s = synthetic();
  try {
    s.observer.runAttempt(false, () => {
      s.callbacks.init(1, "FSREQCALLBACK");
      return new Promise(() => {});
    });
    for (let i = 0; i < 65536; i++) {
      s.callbacks.before(1);
      s.callbacks.after(1);
    }
    const record = validateWaitCheckpoint(s.observer.snapshot());
    assert.equal(record.coverage, "unknown");
    assert.equal(record.capacityLoss, true);
    assert.equal(record.pending[0].fsActivity[0].before, 65535);
  } finally {
    s.observer.stop();
  }
  for (const mode of ["duplicate", "after-without-before", "clock"]) {
    const x = synthetic();
    try {
      const value = x.observer.runAttempt(false, () => {
        x.callbacks.init(1, "FSREQPROMISE");
        if (mode === "duplicate") x.callbacks.init(1, "FSREQPROMISE");
        return 17;
      });
      assert.equal(value, 17);
      if (mode === "after-without-before") x.callbacks.after(1);
      if (mode === "clock") {
        x.time(NaN);
        x.callbacks.before(1);
      }
      const record = validateWaitCheckpoint(x.observer.snapshot());
      assert.equal(record.coverage, "unknown");
      assert.equal(record.observerFault, true);
    } finally {
      x.observer.stop();
    }
  }
});

test("strict v2 schema rejects leaked timestamps/raw IDs, wrong class, inconsistent live counts and v1", () => {
  const s = synthetic();
  try {
    s.observer.runAttempt(false, () => {
      s.callbacks.init(77, "FSREQCALLBACK");
      return new Promise(() => {});
    });
    const good = s.observer.snapshot();
    assert.equal(good.npmWaitProbe, 2);
    for (const mutate of [
      (v) => {
        v.npmWaitProbe = 1;
      },
      (v) => {
        v.pending[0].createdAt = 123;
      },
      (v) => {
        v.pending[0].fsActivity[0].asyncId = 77;
      },
      (v) => {
        v.pending[0].fsActivity[0].kind = "PRIVATE";
      },
      (v) => {
        v.pending[0].fsActivity[0].liveNeverSeen = 0;
      },
      (v) => {
        v.pending[0].fsActivity[0].before = 65536;
      },
      (v) => {
        v.pending[0].fsActivity[0].lastBeforeAgeMs = -1;
      },
    ]) {
      const record = structuredClone(good);
      mutate(record);
      assert.throws(() => validateWaitCheckpoint(record));
    }
  } finally {
    s.observer.stop();
  }
});

test("one owned pinned FSMinipass to driver gate to tar extraction observes callbacks without observer flow changes", {
  timeout: 5000,
}, async (t) => {
  const verified = verifyPinnedNpm(process.env.npm_execpath);
  for (const [file, hash] of Object.entries({
    "node_modules/fs-minipass/lib/index.js":
      "912b77fd03d013203ad1c3fa7c8712660f599e4d194af41815fceb059ff88faf",
    "node_modules/tar/dist/commonjs/unpack.js":
      "b7a8635532be4055fa5525fb4e0c4e217a9fba1035233de92a7209801fe25cab",
    "node_modules/tar/dist/commonjs/parse.js":
      "b92c848f6b6a29bd6b6bcc12f2c737c8b5a07a4038529f57353fefcc34c6a959",
    "node_modules/minizlib/dist/commonjs/index.js":
      "1545b857e5a597a4fb9294e5040f8b8e3f207e53901f935de2b135a4200abbbf",
  }))
    assert.equal(
      createHash("sha256")
        .update(fs.readFileSync(path.join(verified.root, file)))
        .digest("hex"),
      hash
    );
  const tar = require(path.join(verified.root, "node_modules/tar"));
  const { ReadStream } = require(path.join(verified.root, "node_modules/fs-minipass"));
  const { directory, identity } = owned.createOwnedDirectory(
    path.join(os.tmpdir(), "outpost-fs-boundary-")
  );
  const input = path.join(directory, "input"),
    output = path.join(directory, "output"),
    archive = path.join(directory, "fixture.tgz");
  fs.mkdirSync(input);
  fs.mkdirSync(output);
  for (const name of ["a", "b"]) fs.writeFileSync(path.join(input, name), randomBytes(8192));
  tar.c({ sync: true, gzip: true, cwd: input, file: archive }, ["a", "b"]);
  assert.ok(fs.statSync(archive).size <= 65536);
  const observer = createWaitObserver();
  let source, gate, extractor, fd, releaseGate, barrier, gateReached;
  let clean = false,
    stageTimer;
  const reached = new Promise((resolve) => {
    gateReached = resolve;
  });
  const deadline = (ms) =>
    new Promise((_, reject) => {
      stageTimer = setTimeout(() => reject(new Error("Controlled pipeline bound")), ms);
    });
  try {
    let extractionDone;
    const returned = observer.runAttempt(false, () => {
      fd = fs.openSync(archive, "r");
      extractor = tar.x({ cwd: output });
      extractionDone = new Promise((resolve, reject) => {
        extractor.once("end", resolve);
        extractor.once("error", reject);
      });
      let first = true;
      gate = new Writable({
        highWaterMark: 1,
        write(chunk, _encoding, callback) {
          extractor.write(chunk);
          if (first) {
            first = false;
            releaseGate = () => {
              releaseGate = undefined;
              callback();
            };
            gateReached();
          } else callback();
        },
        final(callback) {
          extractor.end();
          callback();
        },
      });
      const gateDone = new Promise((resolve, reject) => {
        gate.once("finish", resolve);
        gate.once("error", reject);
      });
      const gateClosed = new Promise((resolve) => gate.once("close", resolve));
      source = new ReadStream(archive, { fd, autoClose: false, readSize: 1024 });
      source.pipe(gate);
      const sourceDone = source.promise();
      barrier = Promise.all([sourceDone, gateDone, gateClosed, extractionDone]);
      return barrier;
    });
    assert.equal(returned, barrier);
    // Observe rejection immediately, even if a later assertion fails while the gate is held.
    barrier.catch(() => {});
    const operation = (async () => {
      await reached;
      const before = validateWaitCheckpoint(observer.snapshot());
      const row = before.pending[0];
      assert.ok(row);
      assert.ok(row.fsActivity[0].before > 0);
      assert.equal(typeof releaseGate, "function");
      releaseGate();
      await returned;
      assert.deepEqual(
        fs.readFileSync(path.join(output, "a")),
        fs.readFileSync(path.join(input, "a"))
      );
      assert.deepEqual(
        fs.readFileSync(path.join(output, "b")),
        fs.readFileSync(path.join(input, "b"))
      );
      t.diagnostic(
        JSON.stringify({
          controlledPipeline: true,
          fsCallbackObserved: row.fsActivity[0].before > 0,
          opaqueSummaryOnly: true,
          bytesOrOsCompletionClaim: false,
        })
      );
    })();
    await Promise.race([operation, deadline(4000)]);
  } finally {
    clearTimeout(stageTimer);
    // ALWAYS release test-only backpressure before draining. Never remove live fixture files.
    if (releaseGate) releaseGate();
    if (barrier) {
      let drainTimer;
      const settled = await Promise.race([
        barrier.then(
          () => true,
          () => false
        ),
        new Promise((resolve) => {
          drainTimer = setTimeout(() => resolve(false), 900);
        }),
      ]);
      clearTimeout(drainTimer);
      clean = settled;
    }
    observer.stop();
    if (clean) {
      if (fd !== undefined) fs.closeSync(fd);
      owned.removeOwned(directory, identity);
    }
    // On a failed/undrained stream preserve the owned fixture instead of cascading cleanup.
  }
  assert.equal(clean, true);
});
