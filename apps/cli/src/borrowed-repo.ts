import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as Schema from "effect/Schema";
import type { BorrowedRecord } from "./borrowed-schema.js";
import { commandString, readOnlyGitCommand } from "./child-process.js";
import {
  loadConfig,
  loadRepoRegistry,
  upgradeConfig,
  writeConfig,
  writeRepoRegistry,
} from "./config.js";
import { ErrorDetailFields, reasonDetails } from "./error-details.js";
import { validatePortableFilename } from "./path-safety.js";
import { validateWindowsGitPath, validateWindowsInvocationCwd } from "./windows-git-path.js";

export class BorrowedError extends Schema.TaggedError<BorrowedError>()("BorrowedError", {
  ...ErrorDetailFields,
  message: Schema.String,
}) {}
const fail = (message: string) => new BorrowedError({ ...reasonDetails("invalid-state"), message });

// Node bigint stat is deliberate: Effect's numeric inode can lose Windows file-ID bits.
// Identity excludes mutable timestamps, config, refs and administrative contents.
function identity(value: string) {
  return Effect.tryPromise({
    try: async () => {
      const canonical = await realpath(value);
      const stat = await lstat(canonical, { bigint: true });
      if (!stat.isDirectory() || stat.ino <= 0n || stat.dev < 0n)
        throw new Error("No stable directory identity");
      return { path: canonical, device: stat.dev.toString(), inode: stat.ino.toString() };
    },
    catch: () =>
      fail(
        `Stable directory identity unavailable at ${value}. Preserve original storage; no replacement is adopted.`
      ),
  });
}
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function discoverBorrowed(input: string, name: string) {
  return Effect.gen(function* () {
    yield* validatePortableFilename("repository name", name);
    for (const key of [
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_COMMON_DIR",
      "GIT_INDEX_FILE",
      "GIT_OBJECT_DIRECTORY",
      "GIT_ALTERNATE_OBJECT_DIRECTORIES",
      "GIT_CONFIG",
      "GIT_CONFIG_COUNT",
      "GIT_CONFIG_PARAMETERS",
      "GIT_SHALLOW_FILE",
      "GIT_REPLACE_REF_BASE",
    ])
      if (process.env[key] !== undefined)
        return yield* fail(
          `Repository layout/config override ${key} is unsupported for registration.`
        );
    const path = yield* Path.Path;
    yield* validateWindowsInvocationCwd();
    yield* validateWindowsGitPath(input, "cwd");
    const invocation = yield* identity(input);
    const git = (...args: string[]) =>
      commandString(readOnlyGitCommand(...args).pipe(ChildProcess.setCwd(invocation.path))).pipe(
        Effect.map((text) => text.trim())
      );
    const top = yield* git("rev-parse", "--show-toplevel");
    const anchor = yield* identity(top);
    const privateGit = yield* identity(yield* git("rev-parse", "--absolute-git-dir"));
    const common = yield* identity(
      yield* git("rev-parse", "--path-format=absolute", "--git-common-dir")
    );
    yield* validateWindowsGitPath(common.path, "gitdir");
    yield* validateWindowsGitPath(path.join(anchor.path, ".git"), "gitdir");
    yield* validateWindowsGitPath(privateGit.path, "administrative-directory");
    if ((yield* git("rev-parse", "--show-superproject-working-tree")) !== "")
      return yield* fail("Submodule registration is unsupported.");
    const fs = yield* FileSystem.FileSystem;
    const entries = (yield* git("worktree", "list", "--porcelain", "-z"))
      .split("\0")
      .filter((field) => field.startsWith("worktree "))
      .map((field) => field.slice(9));
    if (!entries.length) return yield* fail("Missing main checkout registration.");
    const main = yield* identity(entries[0]);
    if (!equal(yield* identity(path.join(main.path, ".git")), common))
      return yield* fail("Separate Git-directory layouts are unsupported.");
    const listed = yield* Effect.forEach(entries, (entry) => identity(entry).pipe(Effect.result));
    if (!listed.some((entry) => entry._tag === "Success" && equal(entry.success, anchor)))
      return yield* fail("Checkout is not registered with its common directory.");
    const checkoutKind = equal(privateGit, common) ? ("main" as const) : ("linked" as const);
    if (checkoutKind === "main") {
      if (!equal(anchor, main) || !equal(yield* identity(path.join(anchor.path, ".git")), common))
        return yield* fail("Inconsistent main checkout identity.");
    } else {
      if (path.dirname(privateGit.path) !== path.join(common.path, "worktrees"))
        return yield* fail("Foreign linked administrative directory.");
      const pointer = (yield* fs.readFileString(path.join(anchor.path, ".git"))).trim();
      const back = (yield* fs.readFileString(path.join(privateGit.path, "gitdir"))).trim();
      if (
        !pointer.startsWith("gitdir: ") ||
        path.resolve(anchor.path, pointer.slice(8)) !== privateGit.path ||
        path.resolve(privateGit.path, back) !== path.join(anchor.path, ".git")
      )
        return yield* fail("Linked checkout back-pointers do not match.");
    }
    for (const current of [anchor, privateGit, common])
      if (!equal(current, yield* identity(current.path)))
        return yield* fail("Repository identity changed during inspection.");
    return {
      kind: "borrowed" as const,
      id: `local:${randomUUID()}`,
      name,
      registeredAt: new Date().toISOString(),
      anchor,
      privateGit,
      common,
      checkoutKind,
    } satisfies BorrowedRecord;
  }).pipe(
    Effect.mapError((error) =>
      error instanceof BorrowedError
        ? error
        : fail(`Cannot register checkout safely: ${error.message}`)
    )
  );
}

export function verifyBorrowed(record: BorrowedRecord) {
  return Effect.gen(function* () {
    // Check before Git as well as after, so replacement storage is never inspected as trusted.
    for (const saved of [record.anchor, record.privateGit, record.common])
      if (!equal(saved, yield* identity(saved.path)))
        return yield* fail(
          `Repository identity replaced at ${saved.path}. Preserve storage and inspect the retained record.`
        );
    const current = yield* discoverBorrowed(record.anchor.path, record.name);
    if (
      !equal(current.anchor, record.anchor) ||
      !equal(current.privateGit, record.privateGit) ||
      !equal(current.common, record.common) ||
      current.checkoutKind !== record.checkoutKind
    )
      return yield* fail("Borrowed repository association changed.");
    return record;
  });
}

export function inspectBorrowed(record: BorrowedRecord) {
  return verifyBorrowed(record).pipe(
    Effect.match({
      onSuccess: () => ({
        ...record,
        status: "ok" as const,
        storage: "external-unchanged" as const,
        diagnostics: [] as string[],
      }),
      onFailure: (error) => ({
        ...record,
        status: "unavailable" as const,
        storage: "external-unchanged" as const,
        diagnostics: [error.message],
      }),
    })
  );
}

export function prepareBorrowedState(home: string) {
  return Effect.gen(function* () {
    const config = yield* loadConfig(home);
    const registry = yield* loadRepoRegistry(home);
    if (config.version < 3) yield* writeConfig(home, { ...upgradeConfig(config), version: 3 });
    if (registry.version !== 4)
      yield* writeRepoRegistry(home, {
        ...registry,
        version: 4,
        retainedRepositories: registry.retainedRepositories ?? [],
        borrowedRepositories: [],
        retainedBorrowedRepositories: [],
      });
    return yield* loadRepoRegistry(home);
  });
}
