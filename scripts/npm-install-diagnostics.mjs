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
  "reify:unpack",
  "reify:build",
  "reify:save",
  "reify",
  "command:ci",
];
const empty = () => ({
  npmInstallProgress: 1,
  outcome: "unknown",
  filesRead: 0,
  linesRead: 0,
  bounded: true,
  truncated: false,
  commandTimingObserved: false,
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
        for (const line of lines) {
          if (!line) continue;
          if (summary.linesRead >= MAX_LINES) {
            incomplete = true;
            lineLimit = true;
            break;
          }
          summary.linesRead++;
          const match = /^\d+ timing ([A-Za-z:-]+) Completed in (\d{1,9})ms$/.exec(line);
          if (match && phases.includes(match[1])) {
            const observed = timings.get(match[1]) ?? { phase: match[1], count: 0, maxMs: 0 };
            observed.count++;
            observed.maxMs = Math.max(observed.maxMs, Number(match[2]));
            timings.set(match[1], observed);
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
  summary.timings = phases.filter((phase) => timings.has(phase)).map((phase) => timings.get(phase));
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
