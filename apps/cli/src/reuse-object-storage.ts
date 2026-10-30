import { lstat, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { commandResult, readOnlyGitCommand } from "./child-process.js";
import { domainDetails, ErrorDetailFields, reasonDetails } from "./error-details.js";

export const REUSE_OBJECT_LIMITS = {
  inventoryBytes: 256 * 1024,
  objects: 8192,
  packEntries: 1024,
} as const;

export class ReuseObjectStorageError extends Schema.TaggedError<ReuseObjectStorageError>()(
  "ReuseObjectStorageError",
  {
    ...ErrorDetailFields,
    message: Schema.String,
  }
) {}

type Metadata = { path: string; identity: string | null };
const fingerprint = (stat: Awaited<ReturnType<typeof lstat>>) =>
  [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");

function inspectStorage(
  managed: string,
  ids: readonly string[] | undefined,
  previous: readonly Metadata[] = [],
  incoming = false
) {
  return Effect.tryPromise({
    try: async (signal) => {
      const root = await realpath(managed);
      const snapshots = new Map<string, Metadata>();
      const check = async (file: string, directory: boolean, optional = false) => {
        signal.throwIfAborted();
        let stat: Awaited<ReturnType<typeof lstat>>;
        try {
          stat = await lstat(file);
        } catch (error) {
          if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") {
            snapshots.set(file, { path: file, identity: null });
            return false;
          }
          throw error;
        }
        if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()))
          throw new Error(`Aliased or unsupported object storage: ${file}`);
        const canonical = await realpath(file);
        const suffix = relative(root, canonical);
        if (isAbsolute(suffix) || suffix === ".." || suffix.startsWith(`..${sep}`))
          throw new Error(`Object storage escapes owned repository: ${file}`);
        snapshots.set(file, { path: file, identity: fingerprint(stat) });
        return true;
      };
      await check(join(managed, "objects"), true);
      if (incoming) {
        await check(join(managed, "objects", "info"), true, true);
        for (const name of ["alternates", "http-alternates"]) {
          try {
            await lstat(join(managed, "objects", "info", name));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
            throw error;
          }
          throw new Error("Incoming objects cannot use alternate object views");
        }
        try {
          await lstat(join(managed, "info", "grafts"));
          throw new Error("Incoming objects cannot use graft views");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        for (let i = 0; i < 256; i++)
          await check(join(managed, "objects", i.toString(16).padStart(2, "0")), true, true);
      }
      const pack = join(managed, "objects", "pack");
      let entries = 0;
      const inspectPack = async (directory: string, chained: boolean) => {
        if (!(await check(directory, true, true))) return;
        const stream = await opendir(directory);
        try {
          for await (const entry of stream) {
            signal.throwIfAborted();
            if (++entries > REUSE_OBJECT_LIMITS.packEntries)
              throw new Error(
                `Object storage pack metadata exceeds ${REUSE_OBJECT_LIMITS.packEntries} entries: ${directory}`
              );
            const file = join(directory, entry.name);
            if (!chained && entry.name === "multi-pack-index.d") await inspectPack(file, true);
            else await check(file, false);
          }
        } finally {
          await stream.close().catch(() => undefined);
        }
      };
      await inspectPack(pack, false);
      if (ids) {
        const fanouts = new Map<string, boolean>();
        for (const id of ids) {
          const fanout = join(managed, "objects", id.slice(0, 2));
          let exists = fanouts.get(fanout);
          if (exists === undefined) {
            exists = await check(fanout, true, true);
            fanouts.set(fanout, exists);
          }
          if (exists) await check(join(fanout, id.slice(2)), false, true);
        }
      }
      // Recheck the exact metadata read before Git traversal. Directory identity
      // changes also catch newly inserted/removed pack files without scanning content.
      for (const before of previous) {
        let actual: string | null = null;
        try {
          actual = fingerprint(await lstat(before.path));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (actual !== before.identity)
          throw new Error(`Object storage changed during ownership inspection: ${before.path}`);
      }
      return [...snapshots.values()];
    },
    catch: (error) =>
      new ReuseObjectStorageError({
        ...reasonDetails("invalid-state"),
        action:
          "Preserve the original repository, refs and source. Inspect object storage manually; reuse cannot adopt aliases or repair/import objects.",
        message: error instanceof Error ? error.message : String(error),
      }),
  });
}

/** Incoming fetches use pack storage only. Check bounded writable metadata, never loose contents. */
export function requireOwnedIncomingStorage(managed: string, repoId: string, selectedOid?: string) {
  return Effect.gen(function* () {
    yield* requireNoReplacementView(managed, repoId);
    const ids = selectedOid ? [selectedOid] : undefined;
    const before = yield* inspectStorage(managed, ids, [], true);
    yield* inspectStorage(managed, ids, before, true);
  });
}
function requireNoReplacementView(managed: string, repoId: string) {
  return Effect.gen(function* () {
    // Replacement commit objects are omitted from rev-list's emitted OIDs.
    // Refuse this unsupported view rather than silently miss a dependency or
    // change the user's replacement refs/object interpretation.
    const replacements = yield* commandResult(
      readOnlyGitCommand(
        "--git-dir",
        managed,
        "for-each-ref",
        "--count=1",
        "--format=%(refname)",
        "refs/replace"
      ),
      { maxOutputBytes: 8192 }
    );
    if (
      replacements.exitCode !== 0 ||
      replacements.stdout.truncated ||
      replacements.stderr.truncated ||
      replacements.stdout.text.trim()
    )
      return yield* Effect.fail(
        new ReuseObjectStorageError({
          ...reasonDetails("invalid-state"),
          message: `Replacement refs are unsupported for existing-branch reuse of ${repoId}. Preserve refs and source; the selected checkout object inventory cannot establish their complete dependencies.`,
        })
      );
  });
}

/** Check only selected checkout object paths and bounded pack metadata, never object content. */
export function requireOwnedReuseObjects(managed: string, commit: string, repoId: string) {
  return Effect.gen(function* () {
    yield* requireNoReplacementView(managed, repoId);
    const before = yield* inspectStorage(managed, [commit]);
    const inventory = yield* commandResult(
      readOnlyGitCommand(
        "--git-dir",
        managed,
        "rev-list",
        "--objects",
        "--no-object-names",
        "--missing=error",
        "--no-walk",
        commit
      ),
      { maxOutputBytes: REUSE_OBJECT_LIMITS.inventoryBytes }
    );
    const ids = [...new Set(inventory.stdout.text.trim().split(/\r?\n/))];
    if (
      inventory.exitCode !== 0 ||
      inventory.stdout.truncated ||
      inventory.stderr.truncated ||
      ids.length > REUSE_OBJECT_LIMITS.objects ||
      !ids.includes(commit) ||
      ids.some((id) => !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(id))
    )
      return yield* Effect.fail(
        new ReuseObjectStorageError({
          ...reasonDetails("invalid-state"),
          message: `Required checkout objects for ${repoId} cannot be established within the owned inventory bound (${REUSE_OBJECT_LIMITS.inventoryBytes} bytes/${REUSE_OBJECT_LIMITS.objects} IDs). Preserve source work; no implicit fetch or object import is supported.`,
        })
      );
    const selected = yield* inspectStorage(managed, ids, before);
    yield* inspectStorage(managed, ids, selected);
  }).pipe(
    Effect.mapError(
      (error) => new ReuseObjectStorageError({ ...domainDetails(error), message: error.message })
    )
  );
}
