// Fixed parent-only records. No input-derived strings or exception values enter a record.
const STATES = new Set([
  "unreached",
  "match",
  "mismatch",
  "unavailable",
  "read-refused",
  "hash-mismatch",
  "shape-mismatch",
  "load-refused",
  "attach-refused",
]);
const cell = (id) => ({ id, state: "unreached", hashMatch: null });
export function parentPreflight(context, sink, operation) {
  const record = {
    npmWaitPreflight: 1,
    context: context === 1 ? 1 : 2,
    nodeMatch: null,
    selectedNpmVersionMatch: null,
    versionState: "unreached",
    layout: Array.from({ length: 4 }, (_, i) => ({ id: i + 1, state: "unreached", match: null })),
    files: Array.from({ length: 13 }, (_, i) => cell(i + 1)),
    hooks: Array.from({ length: 7 }, (_, i) => cell(i + 1)),
    hookLoad: "unreached",
    attachment: "unreached",
    result: "refused",
  };
  const trace = (kind, id, state, match) => {
    if (!STATES.has(state) || ![null, true, false].includes(match)) return;
    if (kind === "node") record.nodeMatch = match;
    else if (kind === "version") {
      record.selectedNpmVersionMatch = match;
      record.versionState = state;
    } else if (kind === "hook-load") record.hookLoad = state;
    else if (kind === "attach") record.attachment = state;
    else if (kind === "layout" && Number.isInteger(id) && id >= 1 && id <= 4)
      record.layout[id - 1] = { id, state, match };
    else if ((kind === "file" || kind === "hook") && Number.isInteger(id)) {
      const rows = kind === "file" ? record.files : record.hooks;
      if (id >= 1 && id <= rows.length) rows[id - 1] = { id, state, hashMatch: match };
    }
  };
  try {
    const result = operation(trace);
    record.result = "passed";
    return result;
  } finally {
    try {
      if (Buffer.byteLength(JSON.stringify(record)) <= 8192) sink(record);
    } catch {
      /* Preserve the exact operation value/refusal. */
    }
  }
}
