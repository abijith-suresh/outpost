import { lstat, mkdtemp, opendir, realpath, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import * as Effect from "effect/Effect";
import { BorrowedError, directoryIdentity } from "./borrowed-repo.js";
import type { BorrowedRecord } from "./borrowed-schema.js";
import { validateWindowsGitPath } from "./windows-git-path.js";

async function emptyDirectory(path: string) {
  const directory = await opendir(path);
  try {
    return (await directory.read()) === null;
  } finally {
    await directory.close();
  }
}
export type AttributeInspection = { index: string; check: Effect.Effect<void, BorrowedError> };
const same = (a: BorrowedRecord["common"], b: BorrowedRecord["common"]) =>
  a.path === b.path && a.inode === b.inode && a.device === b.device;
function absent(file: string) {
  return Effect.tryPromise({
    try: async () => {
      try {
        await lstat(file);
        throw new Error("Inspection index unexpectedly exists");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    },
    catch: () =>
      new BorrowedError({
        message: `Unexpected private inspection index or alias at ${file}. Preserve this unconfirmed residue; no path was removed.`,
      }),
  });
}

/** Only selected-tree check-attr uses this index. It is never copied from source. */
export function withAttributeIndex<A, E, R>(
  record: BorrowedRecord,
  run: (inspection: AttributeInspection) => Effect.Effect<A, E, R>
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const parent = yield* directoryIdentity(tmpdir());
      yield* validateWindowsGitPath(parent.path, "cwd");
      for (const source of [record.anchor.path, record.privateGit.path, record.common.path]) {
        const relation = relative(source, parent.path);
        if (
          relation === "" ||
          (!isAbsolute(relation) && relation !== ".." && !relation.startsWith(`..${sep}`))
        )
          return yield* new BorrowedError({
            message:
              "Inspection scratch parent is inside borrowed source; no scratch or source index was changed.",
          });
      }
      yield* validateWindowsGitPath(
        join(parent.path, "outpost-attributes-XXXXXX", "index"),
        "gitdir"
      );
      const directory = yield* Effect.acquireRelease(
        Effect.uninterruptible(
          Effect.gen(function* () {
            const path = yield* Effect.tryPromise({
              try: () => mkdtemp(join(parent.path, "outpost-attributes-")),
              catch: () =>
                new BorrowedError({
                  message: "Cannot allocate private attribute inspection scratch outside source.",
                }),
            });
            const identity = yield* directoryIdentity(path);
            const state = yield* Effect.tryPromise({
              try: () => lstat(path, { bigint: true }),
              catch: () =>
                new BorrowedError({
                  message: `Cannot verify owned scratch ${path}; preserve residue.`,
                }),
            });
            if (
              typeof process.getuid === "function" &&
              (state.uid !== BigInt(process.getuid()) || (state.mode & 0o077n) !== 0n)
            )
              return yield* new BorrowedError({
                message: `Inspection scratch ownership/permissions are not private at ${path}; preserve residue.`,
              });
            return {
              path,
              identity,
              mtime: state.mtimeNs.toString(),
              ctime: state.ctimeNs.toString(),
            };
          })
        ),
        (owned) =>
          Effect.tryPromise({
            try: async () => {
              const actual = await lstat(owned.path, { bigint: true });
              const current = {
                path: await realpath(owned.path),
                device: actual.dev.toString(),
                inode: actual.ino.toString(),
              };
              if (
                same(current, owned.identity) &&
                actual.mtimeNs.toString() === owned.mtime &&
                actual.ctimeNs.toString() === owned.ctime &&
                (await emptyDirectory(owned.path))
              )
                await rmdir(owned.path);
            },
            catch: () =>
              new BorrowedError({ message: `Preserved changed inspection scratch ${owned.path}.` }),
          }).pipe(Effect.ignore)
      );
      for (const source of [record.anchor.path, record.privateGit.path, record.common.path]) {
        const relation = relative(source, directory.identity.path);
        if (
          relation === "" ||
          (!isAbsolute(relation) && relation !== ".." && !relation.startsWith(`..${sep}`))
        )
          return yield* new BorrowedError({
            message:
              "Private attribute inspection scratch must be outside borrowed source. No source index is read or repaired.",
          });
      }
      const index = join(directory.path, "index");
      // Use the existing conservative Git bootstrap envelope, never extended-path
      // assumptions for an inspection index. 220 UTF-8 bytes also fits classic
      // Win32 file access; its private parent plus separator is shorter still.
      yield* validateWindowsGitPath(index, "gitdir");
      const check = Effect.gen(function* () {
        if (
          !same(parent, yield* directoryIdentity(parent.path)) ||
          !same(directory.identity, yield* directoryIdentity(directory.path))
        )
          return yield* new BorrowedError({
            message: `Inspection parent identity changed; preserve ${directory.path}.`,
          });
        yield* absent(index);
        const empty = yield* Effect.tryPromise({
          try: () => emptyDirectory(directory.path),
          catch: () =>
            new BorrowedError({
              message: `Cannot inspect private scratch ${directory.path}; preserve residue.`,
            }),
        });
        if (!empty)
          return yield* new BorrowedError({
            message: `Unexpected file in private inspection scratch ${directory.path}; preserve residue.`,
          });
        const actual = yield* Effect.tryPromise({
          try: () => lstat(directory.path, { bigint: true }),
          catch: () =>
            new BorrowedError({ message: `Cannot inspect scratch identity ${directory.path}.` }),
        });
        if (
          actual.mtimeNs.toString() !== directory.mtime ||
          actual.ctimeNs.toString() !== directory.ctime
        )
          return yield* new BorrowedError({
            message: `Inspection scratch changed unexpectedly; preserve ${directory.path}.`,
          });
      });
      yield* check;
      const result = yield* Effect.exit(run({ index, check }));
      yield* check;
      return yield* result;
    })
  );
}
