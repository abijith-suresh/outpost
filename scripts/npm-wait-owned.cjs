"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { LIMITS, validateWaitCheckpoint } = require("./npm-wait-observer.cjs");
const failure = () =>
  Object.assign(new Error("Invalid owned probe storage."), { code: "INVALID_NPM_WAIT_STORAGE" });
function identity(directory) {
  const state = fs.lstatSync(directory, { bigint: true });
  if (!state.isDirectory() || state.isSymbolicLink()) throw failure();
  return {
    dev: String(state.dev),
    ino: String(state.ino),
    real: fs.realpathSync.native(directory),
  };
}
function assertOwned(directory, expected) {
  const actual = identity(directory);
  if (
    !expected ||
    actual.dev !== expected.dev ||
    actual.ino !== expected.ino ||
    actual.real !== expected.real
  )
    throw failure();
}
function removeOwned(directory, expected) {
  assertOwned(directory, expected);
  fs.rmSync(directory, { recursive: true, force: true });
}
function createOwnedDirectory(prefix) {
  const directory = fs.mkdtempSync(prefix);
  const expected = identity(directory);
  return { directory: expected.real, identity: expected };
}
function checkpointWriter(directory, expected) {
  assertOwned(directory, expected);
  const file = path.join(directory, "wait-checkpoint.json");
  const fd = fs.openSync(file, "wx+", 0o600);
  const opened = fs.fstatSync(fd, { bigint: true });
  let closed = false;
  return {
    write(value) {
      if (closed) throw failure();
      assertOwned(directory, expected);
      const state = fs.lstatSync(file, { bigint: true });
      if (
        !state.isFile() ||
        state.isSymbolicLink() ||
        state.dev !== opened.dev ||
        state.ino !== opened.ino
      )
        throw failure();
      validateWaitCheckpoint(value);
      const bytes = Buffer.from(JSON.stringify(value));
      if (bytes.length > LIMITS.bytes) throw failure();
      let offset = 0;
      while (offset < bytes.length) {
        const count = fs.writeSync(fd, bytes, offset, bytes.length - offset, offset);
        if (!count) throw failure();
        offset += count;
      }
      fs.ftruncateSync(fd, bytes.length);
    },
    close() {
      if (!closed) {
        closed = true;
        fs.closeSync(fd);
      }
    },
  };
}
module.exports = { identity, createOwnedDirectory, assertOwned, removeOwned, checkpointWriter };
