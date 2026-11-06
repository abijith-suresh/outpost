"use strict";
// One diagnostic npm-ci entry, never a product/candidate entry or general preload.
const path = require("node:path");
const { attachPinnedNpmObserver } = require("./npm-wait-observer.cjs");
const { checkpointWriter } = require("./npm-wait-owned.cjs");
function prepare(entry, directory, dev, ino) {
  let writer;
  const observer = attachPinnedNpmObserver(entry, { sink: (value) => writer.write(value) });
  try {
    writer = checkpointWriter(directory, { dev, ino, real: directory });
  } catch {
    observer.stop();
    throw Object.assign(new Error("Invalid npm wait probe."), { code: "INVALID_NPM_WAIT_PROBE" });
  }
  const active = observer;
  active.startCheckpoints();
  process.once("exit", () => {
    active.emit();
    try {
      active.stop();
    } catch {
      /* Preserve npm exit. */
    }
    try {
      writer.close();
    } catch {
      /* Preserve npm exit. */
    }
  });
  process.argv = [
    process.execPath,
    active.entry,
    "ci",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--timing",
    "--logs-dir",
    path.join(directory, "npm-logs"),
  ];
  return active.entry;
}
module.exports = { prepare };
if (require.main === module) {
  let entry;
  try {
    if (process.argv.length !== 6) throw new Error("Invalid probe invocation.");
    entry = prepare(...process.argv.slice(2));
  } catch {
    // Startup is a distinct invalid probe, not a successful uninstrumented install.
    process.stderr.write("NPM_WAIT_PROBE_INVALID\n");
    process.exitCode = 86;
  }
  if (entry) require(entry);
}
