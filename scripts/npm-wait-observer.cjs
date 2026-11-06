"use strict";
// Diagnostic-only. Never loaded by the product or normal candidate path.
const { AsyncLocalStorage, createHook } = require("node:async_hooks");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const LIMITS = Object.freeze({
  attempts: 1024,
  resources: 4096,
  rows: 32,
  bytes: 65536,
  intervalMs: 5000,
});
const PINNED = Object.freeze({
  "bin/npm-cli.js": "8e5f6f3429f8cdbe693cdc29904e9d5a7b127a494bd15c804bd54c7403bfcbe7",
  "lib/npm.js": "49046db2a5a6bf0ec432af43d32fe62bc603e58c4283e9731c16a3a4761f81dd",
  "lib/utils/timers.js": "7460bb4f2d2ef8719ee2a52c9f84c24157a3b96e81e4d6e67d9f2c7b15f426ab",
  "lib/utils/log-file.js": "0545402f1a53075726505829f4dc6b0ec2f43e857fd559b8868c60feae1c46a4",
  "node_modules/@npmcli/arborist/lib/arborist/index.js":
    "eab368e9ba8b9c3990b5ab02e084bd3ccef724d8cc1c9ceadad92b5cc7a97001",
  "node_modules/@npmcli/arborist/lib/arborist/reify.js":
    "6d917a9df6dd63d6206eb24defff05367ef6c5fcd0d057f6c30f35e4a353b542",
  "node_modules/@npmcli/arborist/lib/arborist/rebuild.js":
    "1db859afb29e7e93531ba1f3933558468c7192569d581820ad1721001a0396cd",
  "node_modules/pacote/lib/fetcher.js":
    "97dbf9a402ad3329c517aa35928da4c115a2e3a77b51f513729a8e253ee1144a",
  "node_modules/pacote/lib/index.js":
    "3f4a6a8d7ae3eb72ad61e567bae8d05356cc0a7439e9f7006701728a3af95d32",
  "node_modules/proc-log/lib/index.js":
    "2251aa02ae472e0174b94f37bcbf433f7f2decc77edb5c7b6c56a4a3d90f7c72",
  "node_modules/promise-all-reject-late/index.js":
    "d73d2201981f5c083f8cd7b8d80927e466c53a03dbea80167d7e67b918f7412d",
});
const HOOK_HASHES = Object.freeze({
  reifyNode: "884e466487e5ece614068022273ac8f6bc99bb4d9fe976c793f31fb049e50960",
  checkBins: "e4a400bd7e71f5ee1e59029e2abde4d49a99906cf190317a1b0639fde2cd56df",
  handleOptionalFailure: "a929dc01ffbe4af2cfd153d969da36e3897ad9847bd909a8704111020b4494ad",
  extract: "0682d3a7261077df4c9b4757fe7eb0a44962b34b2ec3c975014bf9aea8c7389d",
  tarballStream: "c89a5492c3a4e36229134e3e06592eecfd95b2d3d6c6b2661b5ebe96e2dd81d8",
});
const STAGES = Object.freeze([
  "node",
  "bins",
  "extract",
  "streamHandler",
  "optionalInput",
  "optionalResult",
]);
const STATES = Object.freeze([
  "unobserved",
  "pending",
  "fulfilled",
  "rejected",
  "sync-throw",
  "unknown-return",
]);
const PHASES = Object.freeze([
  "reify:loadTrees",
  "reify:diffTrees",
  "reify:retireShallow",
  "reify:createSparse",
  "reify:loadShrinkwraps",
  "reify:loadBundles",
  "reify:unpack",
  "reify:unretire",
  "reify:build",
  "build",
  "build:deps",
  "build:links",
  "build:queue",
  "build:link",
  "reify:trash",
  "reify:save",
  "reify",
  "command:ci",
]);
const RESOURCES = Object.freeze({
  FSREQCALLBACK: "fs",
  FSREQPROMISE: "fs",
  ZLIB: "decompression",
  GETADDRINFOREQWRAP: "dns",
  TCPCONNECTWRAP: "tcp",
  TCPWRAP: "tcp",
  TLSWRAP: "tls",
});
const FS_CLASSES = Object.freeze(["callback", "promise"]);
const FS_COUNT_MAX = 65535;
const RESOURCE_NAMES = Object.freeze(["fs", "decompression", "dns", "tcp", "tls"]);
const zeroResources = () => Object.fromEntries(RESOURCE_NAMES.map((name) => [name, 0]));
const invalid = (reason) =>
  Object.assign(new Error("Invalid npm wait probe."), { code: "INVALID_NPM_WAIT_PROBE", reason });
function readBounded(file, limit) {
  const before = fs.lstatSync(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(limit))
    throw invalid("pin-mismatch");
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY |
      (process.platform === "win32" ? 0 : fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
  );
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      !opened.isFile() ||
      opened.size > BigInt(limit) ||
      opened.size !== before.size ||
      opened.mtimeNs !== before.mtimeNs
    )
      throw invalid("pin-mismatch");
    const data = Buffer.alloc(Number(opened.size) + 1);
    let length = 0;
    while (length < data.length) {
      const n = fs.readSync(fd, data, length, data.length - length, null);
      if (!n) break;
      length += n;
    }
    const after = fs.fstatSync(fd, { bigint: true });
    if (
      length !== Number(opened.size) ||
      opened.size !== after.size ||
      opened.mtimeNs !== after.mtimeNs
    )
      throw invalid("pin-mismatch");
    return data.subarray(0, length);
  } finally {
    fs.closeSync(fd);
  }
}
// Optional parent-only check observations; never replace a check's result/refusal.
function notifyPreflight(trace, kind, id, state, match = null) {
  if (!trace) return;
  try {
    trace(kind, id, state, match);
  } catch {
    /* Preserve original outcome. */
  }
}
function verifyPinnedNpm(entry, trace) {
  try {
    const nodeMatch = process.versions.node === "24.22.1";
    notifyPreflight(trace, "node", 0, nodeMatch ? "match" : "mismatch", nodeMatch);
    if (!nodeMatch) throw invalid("pin-mismatch");
    const absolute = path.isAbsolute(entry);
    notifyPreflight(trace, "layout", 1, absolute ? "match" : "mismatch", absolute);
    if (!absolute) throw invalid("pin-mismatch");
    notifyPreflight(trace, "layout", 2, "unavailable");
    const canonical = fs.realpathSync.native(entry);
    notifyPreflight(trace, "layout", 2, "match", true);
    const leafMatch = path.basename(canonical) === "npm-cli.js";
    notifyPreflight(trace, "layout", 3, leafMatch ? "match" : "mismatch", leafMatch);
    if (!leafMatch) throw invalid("pin-mismatch");
    const parentMatch = path.basename(path.dirname(canonical)) === "bin";
    notifyPreflight(trace, "layout", 4, parentMatch ? "match" : "mismatch", parentMatch);
    if (!parentMatch) throw invalid("pin-mismatch");
    const root = path.dirname(path.dirname(canonical));
    notifyPreflight(trace, "version", 0, "read-refused");
    const versionMatch =
      JSON.parse(readBounded(path.join(root, "package.json"), 65536)).version === "11.16.0";
    notifyPreflight(trace, "version", 0, versionMatch ? "match" : "mismatch", versionMatch);
    if (!versionMatch) throw invalid("pin-mismatch");
    let id = 0;
    for (const [name, expected] of Object.entries(PINNED)) {
      id++;
      notifyPreflight(trace, "file", id, "read-refused");
      const match =
        createHash("sha256")
          .update(readBounded(path.join(root, name), 256 * 1024))
          .digest("hex") === expected;
      notifyPreflight(trace, "file", id, match ? "match" : "hash-mismatch", match);
      if (!match) throw invalid("pin-mismatch");
    }
    return { root, entry: canonical };
  } catch {
    throw invalid("pin-mismatch");
  }
}

function createWaitObserver({
  sink = () => {},
  hookFactory = createHook,
  clock = () => performance.now(),
} = {}) {
  const als = new AsyncLocalStorage(),
    attempts = new Map(),
    resources = new Map();
  const phaseState = new Map(PHASES.map((phase) => [phase, { starts: 0, ends: 0 }]));
  let capacityLoss = false,
    observerFault = false,
    stopped = false,
    timer;
  let start = 0;
  try {
    start = clock();
  } catch {
    observerFault = true;
  }
  const safe = (fn) => {
    try {
      return fn();
    } catch {
      observerFault = true;
      return undefined;
    }
  };
  const elapsed = () =>
    safe(() => {
      const value = clock() - start;
      if (!Number.isFinite(value) || value < 0) {
        observerFault = true;
        return 0;
      }
      if (value >= 2147483647) {
        capacityLoss = true;
        return 2147483647;
      }
      return Math.floor(value);
    }) ?? 0;
  const recordState = (row, stage, state) =>
    safe(() => {
      if (row && STAGES.includes(stage)) row[stage] = state;
    });
  function trackPromise(stage, value) {
    const row = als.getStore();
    if (!row || stopped) return value;
    let nativePromise = false;
    if (
      !safe(() => {
        nativePromise = value instanceof Promise;
        return true;
      })
    ) {
      recordState(row, stage, "unknown-return");
      return value;
    }
    if (nativePromise) {
      recordState(row, stage, "pending");
      // Side reactions observe, while the ORIGINAL promise is returned unchanged.
      safe(() =>
        Promise.prototype.then.call(
          value,
          () => {
            recordState(row, stage, "fulfilled");
          },
          () => {
            recordState(row, stage, "rejected");
          }
        )
      );
    } else if (value === null || (typeof value !== "object" && typeof value !== "function")) {
      recordState(row, stage, "fulfilled");
    } else {
      recordState(row, stage, "unknown-return");
      observerFault = true;
    }
    return value;
  }
  function observe(stage, operation) {
    const row = als.getStore();
    recordState(row, stage, "pending");
    let value;
    try {
      value = operation();
    } catch (error) {
      recordState(row, stage, "sync-throw");
      throw error;
    }
    return trackPromise(stage, value);
  }
  const newFsStats = () => ({
    initialized: 0,
    before: 0,
    after: 0,
    destroyed: 0,
    lastBeforeAt: null,
    lastAfterAt: null,
  });
  const increment = (stats, key) => {
    if (stats[key] < FS_COUNT_MAX) stats[key]++;
    if (stats[key] === FS_COUNT_MAX) capacityLoss = true;
  };
  const age = (now, at) => {
    if (at === null) return null;
    if (!Number.isInteger(at) || at < 0 || at > now) {
      observerFault = true;
      return 0;
    }
    return Math.min(2147483647, now - at);
  };
  function fsContext(resource) {
    const row = attempts.get(resource.id);
    if (!row || !FS_CLASSES.includes(resource.fsClass) || !row.fsActivity) {
      observerFault = true;
      return undefined;
    }
    const stats = row.fsActivity[resource.fsClass];
    if (!stats || typeof stats !== "object") {
      observerFault = true;
      return undefined;
    }
    return stats;
  }
  function fsCallback(asyncId, event) {
    safe(() => {
      const resource = resources.get(asyncId);
      if (stopped || !resource || resource.kind !== "fs") return;
      const stats = fsContext(resource);
      if (!stats) return;
      if (event === "after" && !resource.beforeSeen) {
        observerFault = true;
        return;
      }
      increment(stats, event);
      stats[event === "before" ? "lastBeforeAt" : "lastAfterAt"] = elapsed();
      if (event === "before") resource.beforeSeen = true;
    });
  }
  function runAttempt(optional, operation) {
    if (stopped) return operation();
    if (attempts.size >= LIMITS.attempts) {
      capacityLoss = true;
      return als.run(undefined, operation);
    }
    const row = {
      id: attempts.size + 1,
      optional: optional === true,
      fsActivity: { callback: newFsStats(), promise: newFsStats() },
      ...Object.fromEntries(STAGES.map((stage) => [stage, "unobserved"])),
    };
    attempts.set(row.id, row);
    return als.run(row, () => observe("node", operation));
  }
  const resourceCallbacks = {
    init(asyncId, type) {
      safe(() => {
        const row = als.getStore(),
          kind = Object.hasOwn(RESOURCES, type) ? RESOURCES[type] : undefined;
        if (stopped) return;
        if (resources.has(asyncId)) {
          observerFault = true;
          return;
        }
        if (!row || !kind) return;
        if (attempts.get(row.id) !== row) {
          observerFault = true;
          return;
        }
        if (resources.size >= LIMITS.resources) {
          capacityLoss = true;
          return;
        }
        const resource = { id: row.id, kind };
        if (kind === "fs") {
          resource.fsClass = type === "FSREQCALLBACK" ? "callback" : "promise";
          resource.createdAt = elapsed();
          resource.beforeSeen = false;
          increment(row.fsActivity[resource.fsClass], "initialized");
        }
        resources.set(asyncId, resource);
      });
    },
    before(asyncId) {
      fsCallback(asyncId, "before");
    },
    after(asyncId) {
      fsCallback(asyncId, "after");
    },
    destroy(asyncId) {
      safe(() => {
        const resource = resources.get(asyncId);
        if (resource?.kind === "fs") {
          const stats = fsContext(resource);
          if (stats) increment(stats, "destroyed");
        }
        resources.delete(asyncId);
      });
    },
  };
  let hook;
  try {
    hook = hookFactory(resourceCallbacks);
    hook.enable();
  } catch {
    observerFault = true;
  }
  const onTime = (event, name) => {
    safe(() => {
      if (stopped || !phaseState.has(name) || (event !== "start" && event !== "end")) return;
      const state = phaseState.get(name),
        field = event === "start" ? "starts" : "ends";
      if (state[field] >= 4096) capacityLoss = true;
      else state[field]++;
    });
  };
  process.on("time", onTime);
  function snapshot() {
    const elapsedMs = elapsed();
    const totals = Object.fromEntries(
      STAGES.map((stage) => [stage, Object.fromEntries(STATES.map((state) => [state, 0]))])
    );
    let optionalRejectedHandled = 0;
    const pending = [];
    const live = zeroResources();
    for (const row of attempts.values()) {
      for (const stage of STAGES) totals[stage][row[stage]]++;
      if (row.optional && row.optionalInput === "rejected" && row.optionalResult === "fulfilled")
        optionalRejectedHandled++;
      if (row.node === "pending") pending.push(row);
    }
    const livePerAttempt = new Map();
    const fsLive = new Map();
    for (const resource of resources.values()) {
      live[resource.kind]++;
      if (!livePerAttempt.has(resource.id)) livePerAttempt.set(resource.id, zeroResources());
      livePerAttempt.get(resource.id)[resource.kind]++;
      if (resource.kind === "fs") {
        if (!fsContext(resource)) continue;
        if (!fsLive.has(resource.id))
          fsLive.set(
            resource.id,
            Object.fromEntries(
              FS_CLASSES.map((kind) => [
                kind,
                { liveNeverSeen: 0, liveSeen: 0, oldestLiveAgeMs: null },
              ])
            )
          );
        const entry = fsLive.get(resource.id)[resource.fsClass];
        entry[resource.beforeSeen ? "liveSeen" : "liveNeverSeen"]++;
        entry.oldestLiveAgeMs = Math.max(
          entry.oldestLiveAgeMs ?? 0,
          age(elapsedMs, resource.createdAt)
        );
      }
    }
    const rowsTruncated = pending.length > LIMITS.rows;
    // Explicit fields only. Internal timestamps and resource IDs never enter output.
    const pendingRows = pending.slice(0, LIMITS.rows).map((row) => ({
      id: row.id,
      optional: row.optional,
      ...Object.fromEntries(STAGES.map((stage) => [stage, row[stage]])),
      liveResources: livePerAttempt.get(row.id) ?? zeroResources(),
      fsActivity: FS_CLASSES.map((kind) => {
        const stats = row.fsActivity[kind];
        const live = fsLive.get(row.id)?.[kind];
        return {
          kind,
          initialized: stats.initialized,
          before: stats.before,
          after: stats.after,
          destroyed: stats.destroyed,
          liveNeverSeen: live?.liveNeverSeen ?? 0,
          liveSeen: live?.liveSeen ?? 0,
          oldestLiveAgeMs: live?.oldestLiveAgeMs ?? null,
          lastBeforeAgeMs: age(elapsedMs, stats.lastBeforeAt),
          lastAfterAgeMs: age(elapsedMs, stats.lastAfterAt),
        };
      }),
    }));
    return {
      npmWaitProbe: 2,
      valid: true,
      coverage: capacityLoss || observerFault || rowsTruncated ? "unknown" : "observed",
      elapsedMs,
      capacityLoss,
      observerFault,
      rowsTruncated,
      trackedAttempts: attempts.size,
      totals,
      optionalRejectedHandled,
      liveResources: live,
      phases: PHASES.map((phase) => ({ phase, ...phaseState.get(phase) })),
      pending: pendingRows,
    };
  }
  function emit() {
    try {
      let data = snapshot();
      if (Buffer.byteLength(JSON.stringify(data)) > LIMITS.bytes) {
        observerFault = true;
        data = { npmWaitProbe: 2, valid: false, coverage: "unknown", reason: "checkpoint-bound" };
      }
      sink(data);
      return true;
    } catch {
      observerFault = true;
      return false;
    }
  }
  function startCheckpoints() {
    if (stopped || timer) return;
    emit();
    timer = setInterval(emit, LIMITS.intervalMs);
    timer.unref();
  }
  function stop() {
    stopped = true;
    if (timer) clearInterval(timer);
    safe(() => hook?.disable());
    process.removeListener("time", onTime);
  }
  return {
    runAttempt,
    observe,
    trackPromise,
    snapshot,
    emit,
    startCheckpoints,
    stop,
    markFault() {
      observerFault = true;
    },
  };
}

function attachPinnedNpmObserver(entry, options = {}, trace) {
  const verified = verifyPinnedNpm(entry, trace);
  let Arborist, Fetcher;
  notifyPreflight(trace, "hook-load", 0, "load-refused");
  try {
    Arborist = require(path.join(verified.root, "node_modules/@npmcli/arborist"));
    Fetcher = require(path.join(verified.root, "node_modules/pacote/lib/fetcher.js"));
    const methods = {
      ...Object.fromEntries(
        ["reifyNode", "checkBins", "handleOptionalFailure"].map((name) => [
          name,
          Arborist.prototype[Symbol.for(name)],
        ])
      ),
      extract: Fetcher.prototype.extract,
      tarballStream: Fetcher.prototype.tarballStream,
    };
    notifyPreflight(trace, "hook-load", 0, "match", true);
    let id = 0;
    for (const [name, expected] of Object.entries(HOOK_HASHES)) {
      id++;
      notifyPreflight(trace, "hook", id, "shape-mismatch");
      if (typeof methods[name] !== "function") throw invalid("hook-mismatch");
      notifyPreflight(trace, "hook", id, "read-refused");
      const match =
        createHash("sha256")
          .update(Function.prototype.toString.call(methods[name]))
          .digest("hex") === expected;
      notifyPreflight(trace, "hook", id, match ? "match" : "hash-mismatch", match);
      if (!match) throw invalid("hook-mismatch");
    }
  } catch {
    throw invalid("hook-mismatch");
  }
  const observer = createWaitObserver(options),
    restore = [];
  function patch(prototype, key, wrap) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, key),
      original = prototype[key];
    Object.defineProperty(prototype, key, {
      configurable: true,
      writable: true,
      enumerable: descriptor?.enumerable ?? false,
      value: wrap(original),
    });
    restore.push(() => {
      if (descriptor) Object.defineProperty(prototype, key, descriptor);
      else delete prototype[key];
    });
  }
  notifyPreflight(trace, "attach", 0, "attach-refused");
  try {
    patch(
      Arborist.prototype,
      Symbol.for("reifyNode"),
      (original) =>
        function (...args) {
          let optional = false;
          try {
            optional = args[0]?.optional === true;
          } catch {
            observer.markFault();
          }
          return observer.runAttempt(optional, () => Reflect.apply(original, this, args));
        }
    );
    patch(
      Arborist.prototype,
      Symbol.for("checkBins"),
      (original) =>
        function (...args) {
          return observer.observe("bins", () => Reflect.apply(original, this, args));
        }
    );
    patch(
      Arborist.prototype,
      Symbol.for("handleOptionalFailure"),
      (original) =>
        function (...args) {
          observer.trackPromise("optionalInput", args[1]);
          return observer.observe("optionalResult", () => Reflect.apply(original, this, args));
        }
    );
    patch(
      Fetcher.prototype,
      "extract",
      (original) =>
        function (...args) {
          return observer.observe("extract", () => Reflect.apply(original, this, args));
        }
    );
    patch(
      Fetcher.prototype,
      "tarballStream",
      (original) =>
        function (handler, ...rest) {
          const wrapped =
            typeof handler === "function"
              ? function (...args) {
                  return observer.observe("streamHandler", () =>
                    Reflect.apply(handler, this, args)
                  );
                }
              : handler;
          return Reflect.apply(original, this, [wrapped, ...rest]);
        }
    );
  } catch {
    for (const undo of restore.reverse()) {
      try {
        undo();
      } catch {
        /* Invalid probe refuses execution. */
      }
    }
    observer.stop();
    throw invalid("hook-mismatch");
  }
  notifyPreflight(trace, "attach", 0, "match", true);
  return {
    ...observer,
    entry: verified.entry,
    stop() {
      observer.stop();
      for (const undo of restore.reverse()) {
        try {
          undo();
        } catch {
          observer.markFault();
        }
      }
    },
  };
}

module.exports = {
  LIMITS,
  PINNED,
  HOOK_HASHES,
  PHASES,
  STAGES,
  STATES,
  RESOURCE_NAMES,
  FS_CLASSES,
  verifyPinnedNpm,
  createWaitObserver,
  attachPinnedNpmObserver,
  readBounded,
};

const keys = (value, expected) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
const count = (value, max) => Number.isInteger(value) && value >= 0 && value <= max;
const resourceCounts = (value) =>
  keys(value, RESOURCE_NAMES) &&
  RESOURCE_NAMES.every((name) => count(value[name], LIMITS.resources)) &&
  Object.values(value).reduce((a, b) => a + b, 0) <= LIMITS.resources;
function validateWaitCheckpoint(value) {
  const topKeys = [
    "npmWaitProbe",
    "valid",
    "coverage",
    "elapsedMs",
    "capacityLoss",
    "observerFault",
    "rowsTruncated",
    "trackedAttempts",
    "totals",
    "optionalRejectedHandled",
    "liveResources",
    "phases",
    "pending",
  ];
  if (
    !keys(value, topKeys) ||
    value.npmWaitProbe !== 2 ||
    value.valid !== true ||
    !["observed", "unknown"].includes(value.coverage) ||
    !count(value.elapsedMs, 2147483647) ||
    ![value.capacityLoss, value.observerFault, value.rowsTruncated].every(
      (v) => typeof v === "boolean"
    ) ||
    (value.coverage === "observed" &&
      (value.capacityLoss || value.observerFault || value.rowsTruncated)) ||
    !count(value.trackedAttempts, LIMITS.attempts) ||
    !keys(value.totals, STAGES) ||
    !count(value.optionalRejectedHandled, value.trackedAttempts) ||
    !resourceCounts(value.liveResources)
  )
    throw invalid("checkpoint-invalid");
  for (const stage of STAGES) {
    const totals = value.totals[stage];
    if (
      !keys(totals, STATES) ||
      !STATES.every((state) => count(totals[state], value.trackedAttempts)) ||
      Object.values(totals).reduce((a, b) => a + b, 0) !== value.trackedAttempts
    )
      throw invalid("checkpoint-invalid");
  }
  if (
    !Array.isArray(value.phases) ||
    value.phases.length !== PHASES.length ||
    !value.phases.every(
      (row, i) =>
        keys(row, ["phase", "starts", "ends"]) &&
        row.phase === PHASES[i] &&
        count(row.starts, 4096) &&
        count(row.ends, 4096)
    )
  )
    throw invalid("checkpoint-invalid");
  if (
    !Array.isArray(value.pending) ||
    value.pending.length > LIMITS.rows ||
    value.pending.length !== Math.min(LIMITS.rows, value.totals.node.pending) ||
    value.rowsTruncated !== value.totals.node.pending > LIMITS.rows
  )
    throw invalid("checkpoint-invalid");
  const ids = new Set();
  for (const row of value.pending) {
    if (
      !keys(row, ["id", "optional", ...STAGES, "liveResources", "fsActivity"]) ||
      !count(row.id, value.trackedAttempts) ||
      row.id === 0 ||
      ids.has(row.id) ||
      typeof row.optional !== "boolean" ||
      row.node !== "pending" ||
      !STAGES.every((stage) => STATES.includes(row[stage])) ||
      !resourceCounts(row.liveResources)
    )
      throw invalid("checkpoint-invalid");
    if (!Array.isArray(row.fsActivity) || row.fsActivity.length !== 2)
      throw invalid("checkpoint-invalid");
    let fsLiveTotal = 0;
    for (const [index, stats] of row.fsActivity.entries()) {
      if (
        !keys(stats, [
          "kind",
          "initialized",
          "before",
          "after",
          "destroyed",
          "liveNeverSeen",
          "liveSeen",
          "oldestLiveAgeMs",
          "lastBeforeAgeMs",
          "lastAfterAgeMs",
        ]) ||
        stats.kind !== FS_CLASSES[index] ||
        !["initialized", "before", "after", "destroyed"].every((key) =>
          count(stats[key], FS_COUNT_MAX)
        ) ||
        !count(stats.liveNeverSeen, LIMITS.resources) ||
        !count(stats.liveSeen, LIMITS.resources) ||
        !["oldestLiveAgeMs", "lastBeforeAgeMs", "lastAfterAgeMs"].every(
          (key) => stats[key] === null || count(stats[key], 2147483647)
        ) ||
        (stats.liveNeverSeen + stats.liveSeen === 0) !== (stats.oldestLiveAgeMs === null) ||
        (stats.before === 0) !== (stats.lastBeforeAgeMs === null) ||
        (stats.after === 0) !== (stats.lastAfterAgeMs === null) ||
        (value.coverage === "observed" &&
          (stats.initialized - stats.destroyed !== stats.liveNeverSeen + stats.liveSeen ||
            [stats.initialized, stats.before, stats.after, stats.destroyed].includes(FS_COUNT_MAX)))
      )
        throw invalid("checkpoint-invalid");
      fsLiveTotal += stats.liveNeverSeen + stats.liveSeen;
    }
    if (fsLiveTotal !== row.liveResources.fs) throw invalid("checkpoint-invalid");
    ids.add(row.id);
  }
  return value;
}
function readWaitCheckpoint(file) {
  try {
    return validateWaitCheckpoint(JSON.parse(readBounded(file, LIMITS.bytes).toString("utf8")));
  } catch {
    return { npmWaitProbe: 2, valid: false, coverage: "unknown", reason: "checkpoint-unavailable" };
  }
}
module.exports.validateWaitCheckpoint = validateWaitCheckpoint;
module.exports.readWaitCheckpoint = readWaitCheckpoint;
