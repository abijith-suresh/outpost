import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  openSync,
  readSync,
} from "node:fs";
import { join } from "node:path";

const MAX_ENTRIES = 16;
const MAX_FILES = 8;
const MAX_FILE = 256 * 1024;
const MAX_TOTAL = 1024 * 1024;
const MAX_LINES = 16384;
const phases = [
  "idealTree",
  "npm-ci:rm",
  "reify:loadTrees",
  "reify:diffTrees",
  "reify:retireShallow",
  "reify:createSparse",
  "reify:loadShrinkwraps",
  "reify:loadBundles",
  "reify:audit",
  "reify:unpack",
  "reify:unretire",
  "build",
  "build:deps",
  "build:links",
  "build:queue",
  "build:link",
  "reify:build",
  "reify:trash",
  "reify:save",
  "reify",
  "command:ci",
];
// Locations never leave this classifier. Only these two constant aggregate names do.
const namespaceBuckets = ["reifyNode:bucket", "build:link:bucket"];
function timingPhase(key) {
  if (phases.includes(key)) return key;
  for (const [prefix, bucket] of [
    ["reifyNode:", namespaceBuckets[0]],
    ["build:link:", namespaceBuckets[1]],
  ]) {
    if (!key.startsWith(prefix)) continue;
    const suffix = key.slice(prefix.length);
    if (
      suffix.length > 0 &&
      suffix.length <= 512 &&
      [...suffix].every((character) => {
        const code = character.charCodeAt(0);
        return code >= 32 && (code < 127 || code > 159);
      })
    )
      return bucket;
  }
  return undefined;
}

const empty = () => ({
  npmInstallProgress: 1,
  outcome: "unknown",
  filesRead: 0,
  linesRead: 0,
  bounded: true,
  truncated: false,
  commandTimingObserved: false,
  lineEndings: { lf: false, crlf: false, embeddedCR: false },
  logLevels: { timing: 0, http: 0, silly: 0, verbose: 0, info: 0, warn: 0, error: 0, notice: 0 },
  unknownRecordLines: 0,
  unrecognizedTimingRecords: 0,
  progress: {
    idealTreeBuildDepsRecords: 0,
    fetchManifestRecords: 0,
    reifyMovesRecords: 0,
    optionalDependencyFailureRecords: 0,
    tarballCacheMissingRecords: 0,
    unfinishedKnownPhaseRecords: 0,
  },
  cacheHits: 0,
  cacheMisses: 0,
  httpFetches: 0,
  networkErrorTokens: 0,
  timings: [],
});

/** Only fixed categories/counts leave the parser. No filenames or raw log fields. */
export function summarizeNpmInstallLogs(directory) {
  const summary = empty();
  const timings = new Map();
  let total = 0,
    entries = 0,
    incomplete = false,
    lineLimit = false;
  let directoryHandle;
  try {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return summary;
    directoryHandle = opendirSync(directory);
    while (true) {
      const entry = directoryHandle.readSync();
      if (entry === null) break;
      if (++entries > MAX_ENTRIES) {
        incomplete = true;
        break;
      }
      if (!entry.name.endsWith(".log")) continue;
      if (summary.filesRead >= MAX_FILES || total >= MAX_TOTAL) {
        incomplete = true;
        break;
      }
      const file = join(directory, entry.name);
      let descriptor;
      try {
        const before = lstatSync(file, { bigint: true });
        if (!before.isFile() || before.isSymbolicLink()) {
          incomplete = true;
          continue;
        }
        descriptor = openSync(
          file,
          constants.O_RDONLY |
            (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK)
        );
        const opened = fstatSync(descriptor, { bigint: true });
        if (!opened.isFile() || before.dev !== opened.dev || before.ino !== opened.ino) {
          incomplete = true;
          continue;
        }
        const limit = Math.min(MAX_FILE, MAX_TOTAL - total);
        const bytes = Buffer.alloc(limit);
        let length = 0;
        while (length < bytes.length) {
          const count = readSync(descriptor, bytes, length, bytes.length - length, null);
          if (count === 0) break;
          length += count;
        }
        total += length;
        const after = fstatSync(descriptor, { bigint: true });
        if (opened.size !== after.size || opened.mtimeNs !== after.mtimeNs) {
          incomplete = true;
          continue;
        }
        summary.filesRead++;
        const text = bytes.subarray(0, length).toString("utf8");
        if (opened.size > BigInt(length) || (length > 0 && !text.endsWith("\n"))) {
          incomplete = true;
          summary.truncated = true;
        }
        // Ignore an unterminated last line instead of interpreting partial evidence.
        const lines = text.slice(0, text.lastIndexOf("\n") + 1).split("\n");
        for (const rawLine of lines) {
          if (!rawLine) continue;
          // npm11.16 writes os.EOL. Remove only its terminal CR, not arbitrary whitespace.
          const crlf = rawLine.endsWith("\r");
          const line = crlf ? rawLine.slice(0, -1) : rawLine;
          if (!line) continue;
          if (summary.linesRead >= MAX_LINES) {
            incomplete = true;
            lineLimit = true;
            break;
          }
          summary.linesRead++;
          summary.lineEndings.crlf ||= crlf;
          summary.lineEndings.lf ||= !crlf;
          summary.lineEndings.embeddedCR ||= line.includes("\r");
          const prefix = /^\d+ (timing|http|silly|verbose|info|warn|error|notice)(?: |$)/.exec(
            line
          );
          if (prefix) summary.logLevels[prefix[1]]++;
          else summary.unknownRecordLines++;
          const progress = summary.progress;
          if (/^\d+ silly idealTree buildDeps$/.test(line)) progress.idealTreeBuildDepsRecords++;
          if (/^\d+ silly fetch manifest(?: |$)/.test(line)) progress.fetchManifestRecords++;
          if (/^\d+ silly reify moves(?: |$)/.test(line)) progress.reifyMovesRecords++;
          if (/^\d+ verbose reify failed optional dependency(?: |$)/.test(line))
            progress.optionalDependencyFailureRecords++;
          if (/^\d+ silly tarball no local data for(?: |$)/.test(line))
            progress.tarballCacheMissingRecords++;
          const unfinished = /^\d+ silly unfinished npm timer ([A-Za-z:-]+) \d{1,16}$/.exec(line);
          if (unfinished && phases.includes(unfinished[1])) progress.unfinishedKnownPhaseRecords++;
          const match = /^\d+ timing ([^\r\n]{1,1024}) Completed in (\d{1,9})ms$/.exec(line);
          const phase = match ? timingPhase(match[1]) : undefined;
          if (phase) {
            const observed = timings.get(phase) ?? { phase, count: 0, maxMs: 0 };
            observed.count++;
            observed.maxMs = Math.max(observed.maxMs, Number(match[2]));
            timings.set(phase, observed);
          } else if (prefix?.[1] === "timing") {
            summary.unrecognizedTimingRecords++;
          }
          if (/^\d+ http (?:cache|fetch) /.test(line)) {
            if (/\(cache hit\)$/.test(line)) summary.cacheHits++;
            if (/\(cache miss\)$/.test(line)) summary.cacheMisses++;
            if (/^\d+ http fetch /.test(line)) summary.httpFetches++;
          }
          if (
            /^\d+ (?:error code|http fetch .* attempt \d+ failed with) (?:ETIMEDOUT|ECONNRESET|ENOTFOUND)$/.test(
              line
            )
          )
            summary.networkErrorTokens++;
        }
        if (lineLimit) break;
      } catch {
        incomplete = true;
      } finally {
        if (descriptor !== undefined) {
          try {
            closeSync(descriptor);
          } catch {
            incomplete = true;
          }
        }
      }
    }
  } catch {
    incomplete = true;
  } finally {
    if (directoryHandle) {
      try {
        directoryHandle.closeSync();
      } catch {
        incomplete = true;
      }
    }
  }
  summary.timings = [...phases, ...namespaceBuckets]
    .filter((phase) => timings.has(phase))
    .map((phase) => timings.get(phase));
  summary.commandTimingObserved = timings.has("command:ci");
  summary.outcome = incomplete ? "incomplete" : summary.filesRead ? "observed" : "unknown";
  return summary;
}

/** Existing parent scratch is owned by preparation and remains under its cleanup. */
export function withNpmInstallDiagnostics(
  parent,
  operation,
  sink = (record) => {
    process.stderr.write(`${JSON.stringify(record)}\n`);
  }
) {
  let directory;
  try {
    const selected = join(parent, "npm-install-logs");
    mkdirSync(selected, { mode: 0o700 });
    directory = selected;
  } catch {
    /* Diagnostic setup must not replace or skip the actual install. */
  }
  try {
    return operation(directory ? ["--timing", "--logs-dir", directory] : []);
  } finally {
    // This synchronous summary runs after the child returns/throws, before outer cleanup.
    try {
      sink(directory ? summarizeNpmInstallLogs(directory) : empty());
    } catch {
      /* Preserve the exact original child result or exception. */
    }
  }
}
