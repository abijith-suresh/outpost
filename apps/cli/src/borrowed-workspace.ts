import { lstat, mkdtemp, realpath, rmdir } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { BorrowedError, directoryIdentity } from "./borrowed-repo.js";
import type { BorrowedRecord, WorkspaceStorage } from "./borrowed-schema.js";
import { readOnlyGitCommand } from "./child-process.js";
import { validateWindowsExistingWorktree } from "./windows-git-path.js";

export function verifyDirectory(saved: BorrowedRecord["common"]) {
  return Effect.gen(function* () {
    const actual = yield* directoryIdentity(saved.path);
    if (JSON.stringify(actual) !== JSON.stringify(saved))
      return yield* new BorrowedError({
        message: `Frozen directory identity changed: ${saved.path}. Preserve all work; no replacement is adopted.`,
      });
  });
}

/** New worktree administration and reflogs must stay inside the admitted store. */
export function verifyMutationParents(record: BorrowedRecord, branch: string, created = false) {
  return verifyDirectory(record.common).pipe(
    Effect.andThen(
      Effect.tryPromise({
        try: async () => {
          const root = record.common.path;
          const parts = ["logs", "refs", "heads", ...branch.split("/")];
          const paths = [
            join(root, "worktrees"),
            ...parts.map((_, index) => join(root, ...parts.slice(0, index + 1))),
          ];
          for (const candidate of paths) {
            let stat: import("node:fs").Stats;
            try {
              stat = await lstat(candidate);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
              throw error;
            }
            const leaf = candidate === paths.at(-1);
            if (
              stat.isSymbolicLink() ||
              (!leaf && !stat.isDirectory()) ||
              (leaf && (!created || !stat.isFile()))
            )
              throw new Error(`Unowned or pre-existing worktree/reflog metadata at ${candidate}`);
            const inside = relative(root, await realpath(candidate));
            if (isAbsolute(inside) || inside === ".." || inside.startsWith(`..${sep}`))
              throw new Error(`Metadata escapes registered storage at ${candidate}`);
          }
        },
        catch: (error) =>
          new BorrowedError({
            message: `${error instanceof Error ? error.message : "Cannot verify mutation parents"}. No metadata alias or old reflog is adopted.`,
          }),
      })
    )
  );
}

export function captureWorkspaceStorage(record: BorrowedRecord, checkoutPath: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* verifyDirectory(record.common);
    const checkout = yield* directoryIdentity(checkoutPath);
    const text = (yield* fs.readFileString(path.join(checkout.path, ".git"))).trim();
    if (!text.startsWith("gitdir: "))
      return yield* new BorrowedError({ message: "New checkout has no linked gitfile." });
    const administration = yield* directoryIdentity(path.resolve(checkout.path, text.slice(8)));
    const storage = { kind: "borrowed" as const, common: record.common, checkout, administration };
    yield* verifyWorkspaceStorage(storage, checkoutPath);
    return storage;
  });
}

export function verifyWorkspaceStorage(storage: WorkspaceStorage, checkoutPath: string) {
  return Effect.gen(function* () {
    if (storage.kind !== "borrowed") return;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* validateWindowsExistingWorktree(storage.common.path, checkoutPath);
    for (const saved of [storage.common, storage.checkout, storage.administration])
      yield* verifyDirectory(saved);
    if (
      path.resolve(checkoutPath) !== storage.checkout.path ||
      path.dirname(storage.administration.path) !== path.join(storage.common.path, "worktrees")
    )
      return yield* new BorrowedError({
        message: "Frozen checkout/admin paths do not belong to the recorded storage.",
      });
    const gitfile = (yield* fs.readFileString(path.join(checkoutPath, ".git"))).trim();
    const back = (yield* fs.readFileString(
      path.join(storage.administration.path, "gitdir")
    )).trim();
    const common = (yield* fs.readFileString(
      path.join(storage.administration.path, "commondir")
    )).trim();
    if (
      !gitfile.startsWith("gitdir: ") ||
      path.resolve(checkoutPath, gitfile.slice(8)) !== storage.administration.path ||
      path.resolve(storage.administration.path, back) !==
        path.join(storage.checkout.path, ".git") ||
      path.resolve(storage.administration.path, common) !== storage.common.path
    )
      return yield* new BorrowedError({
        message:
          "Frozen checkout/common reciprocal pointers changed. Preserve source and checkout.",
      });
  });
}

/** Private operation-scoped hooks directory; cleanup never recursively removes injected files. */
export function emptyHooks(home: string) {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    return yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => mkdtemp(path.join(home, ".empty-hooks-")),
        catch: () => new BorrowedError({ message: "Cannot create private hooks directory." }),
      }),
      (directory) =>
        Effect.tryPromise({
          try: () => rmdir(directory),
          catch: () => new BorrowedError({ message: "Preserved nonempty hooks directory." }),
        }).pipe(Effect.ignore)
    );
  });
}

export function checkedHooks(directory: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* directoryIdentity(directory);
    if ((yield* fs.readDirectory(directory)).length)
      return yield* new BorrowedError({
        message: "Operation hooks directory is no longer empty; refusing Git mutation.",
      });
  });
}

export function safeBorrowedGit(hooks: string, ...args: string[]) {
  return readOnlyGitCommand(
    "-c",
    `core.hooksPath=${hooks}`,
    "-c",
    "branch.autoSetupMerge=false",
    "-c",
    "core.splitIndex=false",
    "-c",
    "gc.auto=0",
    "-c",
    "maintenance.auto=false",
    ...args
  );
}
