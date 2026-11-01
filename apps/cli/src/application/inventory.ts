import { createHash, randomUUID } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { loadConfig, loadRepoRegistry } from "../config.js";
import { CompletedFreshSchema } from "../fresh-inventory.js";
import { ManifestSchema } from "../workspace-manifest.js";
import { InvocationError } from "./context.js";

const identity = (stat: { dev: bigint; ino: bigint }) => `${stat.dev}:${stat.ino}`;
const signature = (stat: BigIntStats) =>
  `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.nlink}`;
const missing = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
const failure = () =>
  new InvocationError({
    message:
      "Recorded metadata is unavailable, changed or exceeds inspection limits. Preserve state and inspect with the CLI.",
  });

/** Only pinned home metadata is read. Never accepts arbitrary browser paths or starts Git. */
export class RecordedFiles {
  private cached?: {
    files: Map<string, string>;
    fingerprint: string;
    signatures: Map<string, string>;
    directories: Map<string, string>;
  };
  private async unchanged() {
    const cached = this.cached;
    if (!cached || !(await this.validate())) return undefined;
    for (const [relative, expected] of cached.directories) {
      const target = relative === "." ? this.home : path.join(this.home, relative);
      try {
        const stat = await fs.lstat(target, { bigint: true });
        if (!stat.isDirectory() || stat.isSymbolicLink() || signature(stat) !== expected)
          return undefined;
      } catch (error) {
        if (!missing(error) || expected !== "missing") return undefined;
      }
    }
    const signatures = [...cached.signatures];
    for (let offset = 0; offset < signatures.length; offset += 32) {
      const checks = await Promise.all(
        signatures.slice(offset, offset + 32).map(async ([relative, expected]) => {
          try {
            const stat = await fs.lstat(path.join(this.home, relative), { bigint: true });
            return stat.isFile() && stat.nlink === 1n && signature(stat) === expected;
          } catch (error) {
            return missing(error) && expected === "missing";
          }
        })
      );
      if (checks.some((valid) => !valid)) return undefined;
    }
    for (const [relative, expected] of cached.directories) {
      try {
        const stat = await fs.lstat(relative === "." ? this.home : path.join(this.home, relative), {
          bigint: true,
        });
        if (!stat.isDirectory() || stat.isSymbolicLink() || signature(stat) !== expected)
          return undefined;
      } catch (error) {
        if (!missing(error) || expected !== "missing") return undefined;
      }
    }
    await this.validate();
    return { files: new Map(cached.files), fingerprint: cached.fingerprint };
  }
  private constructor(
    readonly home: string,
    private readonly homeIdentity: string | null,
    readonly requestedHome: string
  ) {}
  static async open(home: string) {
    const absolute = path.resolve(home);
    try {
      const real = await fs.realpath(absolute);
      const stat = await fs.lstat(real, { bigint: true });
      if (!stat.isDirectory() || stat.ino === 0n) throw failure();
      return new RecordedFiles(real, identity(stat), absolute);
    } catch (error) {
      if (missing(error)) return new RecordedFiles(absolute, null, absolute);
      throw failure();
    }
  }
  async validate() {
    if (this.homeIdentity === null) {
      try {
        await fs.lstat(this.home);
        throw failure();
      } catch (error) {
        if (missing(error)) return false;
        throw failure();
      }
    }
    const stat = await fs.lstat(this.home, { bigint: true });
    if (
      !stat.isDirectory() ||
      identity(stat) !== this.homeIdentity ||
      (await fs.realpath(this.home)) !== this.home
    )
      throw failure();
    return true;
  }
  async read(
    relative: string,
    budget?: { remaining: number },
    signatures?: Map<string, string>
  ): Promise<string | undefined> {
    if (!(await this.validate())) return undefined;
    const parts = relative.split("/");
    if (parts.some((part) => !part || part === "." || part === ".." || part.includes("\\")))
      throw failure();
    let current = this.home;
    for (const part of parts.slice(0, -1)) {
      current = path.join(current, part);
      try {
        const stat = await fs.lstat(current);
        if (
          !stat.isDirectory() ||
          stat.isSymbolicLink() ||
          (await fs.realpath(current)) !== current
        )
          throw failure();
      } catch (error) {
        if (missing(error)) return undefined;
        throw failure();
      }
    }
    const target = path.join(this.home, ...parts);
    let stat: BigIntStats;
    try {
      stat = await fs.lstat(target, { bigint: true });
    } catch (error) {
      if (missing(error)) {
        signatures?.set(relative, "missing");
        return undefined;
      }
      throw failure();
    }
    if (
      !stat.isFile() ||
      stat.nlink !== 1n ||
      stat.size > 1048576n ||
      (await fs.realpath(target)) !== target
    )
      throw failure();
    const file = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if (identity(await file.stat({ bigint: true })) !== identity(stat)) throw failure();
      const bytes = Buffer.alloc(Math.min(Number(stat.size) + 1, 1048577));
      let length = 0;
      while (length < bytes.length) {
        const read = await file.read(bytes, length, bytes.length - length, null);
        if (!read.bytesRead) break;
        length += read.bytesRead;
        if (budget) {
          budget.remaining -= read.bytesRead;
          if (budget.remaining < 0) throw failure();
        }
      }
      const after = await file.stat({ bigint: true });
      if (
        length > 1048576 ||
        after.mtimeNs !== stat.mtimeNs ||
        after.size !== stat.size ||
        identity(await fs.lstat(target, { bigint: true })) !== identity(stat)
      )
        throw failure();
      await this.validate();
      if ((await fs.realpath(target)) !== target) throw failure();
      signatures?.set(relative, signature(stat));
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
    } finally {
      await file.close();
    }
  }
  async capture(options: { cached?: boolean } = {}) {
    if (options.cached) {
      const cached = await this.unchanged();
      if (cached) return cached;
    }
    this.cached = undefined;
    const signatures = new Map<string, string>();
    const directories = new Map<string, string>();
    const files = new Map<string, string>();
    const budget = { remaining: 16 * 1048576 };
    const listed = new Map<string, string[]>();
    if (!(await this.validate())) return { files, fingerprint: "uninitialized" };
    directories.set(".", signature(await fs.lstat(this.home, { bigint: true })));
    for (const name of ["config.json", "repos.json", ".mutation.lock"]) {
      const text = await this.read(name, budget, signatures);
      if (text !== undefined) files.set(name, text);
    }
    let bytes = [...files.values()].reduce((sum, text) => sum + Buffer.byteLength(text), 0);
    for (const directory of ["workspaces", "operations"]) {
      const target = path.join(this.home, directory);
      try {
        const stat = await fs.lstat(target, { bigint: true });
        directories.set(directory, signature(stat));
        if (!stat.isDirectory() || stat.isSymbolicLink() || (await fs.realpath(target)) !== target)
          throw failure();
        const dir = await fs.opendir(target);
        let count = 0;
        const names: string[] = [];
        for await (const entry of dir) {
          if (++count > 4096) throw failure();
          if (!entry.name.endsWith(".json") && !entry.name.endsWith(".lock")) continue;
          names.push(entry.name);
          const text = await this.read(`${directory}/${entry.name}`, budget, signatures);
          if (text !== undefined) {
            bytes += Buffer.byteLength(text);
            if (bytes > 16 * 1048576) throw failure();
            files.set(`${directory}/${entry.name}`, text);
          }
        }
        listed.set(directory, names.sort());
      } catch (error) {
        if (!missing(error)) throw failure();
        listed.set(directory, []);
        directories.set(directory, "missing");
      }
    }
    // Confirm the complete selected metadata view before publishing any fingerprint.
    for (const [relative, text] of files)
      if ((await this.read(relative, budget, signatures)) !== text) throw failure();
    for (const name of ["config.json", "repos.json", ".mutation.lock"])
      if (!files.has(name) && (await this.read(name, budget, signatures)) !== undefined)
        throw failure();
    for (const [directory, names] of listed) {
      const target = path.join(this.home, directory);
      const currentNames: string[] = [];
      try {
        const stat = await fs.lstat(target);
        if (!stat.isDirectory() || stat.isSymbolicLink() || (await fs.realpath(target)) !== target)
          throw failure();
        const dir = await fs.opendir(target);
        let count = 0;
        for await (const entry of dir) {
          if (++count > 4096) throw failure();
          if (entry.name.endsWith(".json") || entry.name.endsWith(".lock"))
            currentNames.push(entry.name);
        }
      } catch (error) {
        if (!missing(error)) throw failure();
      }
      if (JSON.stringify(currentNames.sort()) !== JSON.stringify(names)) throw failure();
    }
    for (const [directory, expected] of directories) {
      try {
        const stat = await fs.lstat(
          directory === "." ? this.home : path.join(this.home, directory),
          { bigint: true }
        );
        if (signature(stat) !== expected) throw failure();
      } catch (error) {
        if (!missing(error) || expected !== "missing") throw failure();
      }
    }
    const digest = createHash("sha256").update(this.homeIdentity!);
    for (const [key, value] of [...files].sort(([a], [b]) => a.localeCompare(b)))
      if (key !== ".mutation.lock") digest.update(key).update("\0").update(value).update("\0");
    await this.validate();
    const fingerprint = digest.digest("hex");
    if (options.cached)
      this.cached = { files: new Map(files), fingerprint, signatures, directories };
    return { files, fingerprint };
  }
}

export class RecordedInventory {
  private decoded?: {
    fingerprint: string;
    view: Effect.Success<ReturnType<typeof decodeRecorded>>;
  };
  private fingerprint = "";
  private token = "";
  private readonly handles = new Map<string, string>();
  constructor(readonly files: RecordedFiles) {}
  handle(key: string) {
    let token = this.handles.get(key);
    if (!token) {
      if (this.handles.size >= 16384) throw failure();
      token = randomUUID();
      this.handles.set(key, token);
    }
    return token;
  }
  resolve(handle: string) {
    for (const [key, value] of this.handles) if (value === handle) return key;
    return undefined;
  }
  read() {
    return Effect.gen({ self: this }, function* () {
      const capture = yield* Effect.tryPromise({
        try: () => this.files.capture({ cached: true }),
        catch: failure,
      });
      const { files, fingerprint } = capture;
      if (fingerprint !== this.fingerprint) {
        this.fingerprint = fingerprint;
        this.token = randomUUID();
      }
      const revision = this.token;
      const observedAt = new Date().toISOString();
      if (this.decoded?.fingerprint === fingerprint) {
        const view = this.decoded.view;
        const locked =
          files.has(".mutation.lock") ||
          [...files.keys()].some((key) => key.startsWith("workspaces/") && key.endsWith(".lock"));
        return {
          ...view,
          revision,
          observedAt,
          sourceFiles: files,
          state: locked
            ? ("updating" as const)
            : view.config
              ? view.notice
                ? ("partial" as const)
                : ("ok" as const)
              : view.state,
        };
      }
      const view = yield* decodeRecorded(
        files,
        this.files,
        (key) => this.handle(key),
        revision,
        observedAt
      );
      this.decoded = { fingerprint, view };
      return view;
    }).pipe(Effect.mapError(failure));
  }
  detail(handle: string) {
    return Effect.gen({ self: this }, function* () {
      const data = yield* this.read();
      const key = this.resolve(handle);
      if (!key?.startsWith("workspace:") || !data.config) return yield* failure();
      const ticket = key.slice(10);
      const text = data.sourceFiles.get(`workspaces/${ticket}.json`);
      if (!text) return yield* failure();
      const raw = yield* Effect.try({ try: () => JSON.parse(text) as unknown, catch: failure });
      const manifest = yield* Schema.decodeUnknownEffect(ManifestSchema)(raw, {
        onExcessProperty: "error",
      }).pipe(Effect.mapError(failure));
      if (manifest.ticket !== ticket || manifest.repositories.length > 128) return yield* failure();
      const root =
        manifest.version === undefined
          ? (data.config.legacyWorktreesRoot ?? data.config.worktreesRoot)
          : manifest.worktreesRoot;
      if (
        !root ||
        !path.isAbsolute(root) ||
        (manifest.version !== undefined && !data.config.trustedWorktreesRoots?.includes(root)) ||
        manifest.workspacePath !== ticket ||
        path.basename(ticket) !== ticket
      )
        return yield* failure();
      const workspace = path.join(root, ticket);
      const members = [];
      for (const member of manifest.repositories) {
        if (
          !member.worktreePath ||
          member.worktreePath === "." ||
          member.worktreePath === ".." ||
          path.basename(member.worktreePath) !== member.worktreePath
        )
          return yield* failure();
        members.push({
          name: member.name,
          path: path.join(workspace, member.worktreePath),
          originalBase: {
            source: member.baseSource,
            ref: member.baseRef,
            commit: member.baseCommit,
          },
        });
      }
      return {
        revision: data.revision,
        observedAt: data.observedAt,
        ticket,
        createdAt: manifest.createdAt,
        recordedBranch: manifest.branch,
        path: workspace,
        members,
      };
    });
  }
  /** Call only inside the existing home mutation lock. Lock itself is excluded from revision comparison. */
  checkRevision(token: string) {
    return Effect.gen({ self: this }, function* () {
      if (token !== this.token || !token)
        return yield* new InvocationError({
          message: "State changed. Reload before submitting another action.",
          reason: "stale-state",
        });
      const expectedFingerprint = this.fingerprint;
      // Bind to the submitted token before yielding; a concurrent poll cannot retarget this guard.
      const current = yield* Effect.tryPromise({ try: () => this.files.capture(), catch: failure });
      if (current.fingerprint !== expectedFingerprint)
        return yield* new InvocationError({
          message: "State changed. Reload before submitting another action.",
          reason: "stale-state",
        });
    });
  }
}

function decodeRecorded(
  files: Map<string, string>,
  source: RecordedFiles,
  handle: (key: string) => string,
  revision: string,
  observedAt: string
) {
  return Effect.gen(function* () {
    const configText = files.get("config.json"),
      registryText = files.get("repos.json");
    if (!configText && !registryText)
      return {
        revision,
        observedAt,
        state: files.size
          ? files.has(".mutation.lock")
            ? ("updating" as const)
            : ("invalid" as const)
          : ("uninitialized" as const),
        ...(files.size
          ? {
              notice:
                "Configuration is missing but recorded artifacts remain. Preserve them and run outpost doctor before recovery; do not initialize over this state.",
            }
          : {}),
        sourceFiles: files,
        config: undefined,
        repositories: [],
        workspaces: [...files.keys()]
          .filter((key) => key.startsWith("workspaces/") && key.endsWith(".json"))
          .map((key) => ({
            handle: handle(`workspace:${key.slice(11, -5)}`),
            ticket: key.slice(11, -5),
            repositoryCount: 0,
            metadataState: "invalid" as const,
            diagnostic:
              "Original configuration is missing. Preserve the manifest and inspect doctor recovery.",
          })),
        nextCursor: null,
      };
    if (!configText || !registryText) return yield* failure();
    const config = yield* loadConfig(source.home, {
      contents: configText,
      homeSpellings: [source.home, source.requestedHome],
    });
    const registry = yield* loadRepoRegistry(source.home, {
      contents: registryText,
      canonicalPaths: false,
    });
    const repositories = [
      ...registry.repos.map((r) => ({ ...r, kind: "managed" as const, retained: false })),
      ...(registry.retainedRepositories ?? []).map((r) => ({
        ...r,
        kind: "managed" as const,
        retained: true,
      })),
    ].map((r) => ({
      handle: handle(`repo:${r.id}`),
      name: r.name,
      kind: r.kind,
      retained: r.retained,
      tags: [...(r.tags ?? [])],
      registeredAt: r.importedAt,
      path: r.managedRepoPath,
    }));
    const borrowed = [
      ...(registry.borrowedRepositories ?? []).map((r) => ({ ...r, retained: false })),
      ...(registry.retainedBorrowedRepositories ?? []).map((r) => ({ ...r, retained: true })),
    ];
    const allRepositories = [
      ...repositories,
      ...borrowed.map((r) => ({
        handle: handle(`repo:${r.id}`),
        name: r.name,
        kind: r.kind,
        retained: r.retained,
        tags: [] as string[],
        registeredAt: r.registeredAt,
        path: r.anchor.path,
      })),
    ];
    const workspaces = [];
    for (const [filename, text] of files) {
      if (!filename.startsWith("workspaces/") || !filename.endsWith(".json")) continue;
      const ticket = filename.slice(11, -5);
      const parsed = yield* Effect.try({
        try: () => JSON.parse(text) as unknown,
        catch: failure,
      }).pipe(
        Effect.flatMap((value) =>
          Schema.decodeUnknownEffect(ManifestSchema)(value, { onExcessProperty: "error" })
        ),
        Effect.result
      );
      workspaces.push({
        handle: handle(`workspace:${ticket}`),
        ticket,
        ...(parsed._tag === "Success" &&
        parsed.success.ticket === ticket &&
        parsed.success.repositories.length <= 128
          ? {
              createdAt: parsed.success.createdAt,
              repositoryCount: parsed.success.repositories.length,
              metadataState: "recorded" as const,
            }
          : {
              repositoryCount: 0,
              metadataState: "invalid" as const,
              diagnostic: "Manifest could not be decoded. Preserve files and inspect with the CLI.",
            }),
      });
    }
    let recovery = false;
    for (const [filename, text] of files)
      if (filename.startsWith("operations/") && filename.endsWith(".json")) {
        const healthy = yield* Effect.try({
          try: () => JSON.parse(text) as unknown,
          catch: failure,
        }).pipe(
          Effect.flatMap((value) =>
            Schema.decodeUnknownEffect(CompletedFreshSchema)(value, { onExcessProperty: "error" })
          ),
          Effect.result
        );
        if (healthy._tag === "Failure") recovery = true;
      }
    const state =
      files.has(".mutation.lock") ||
      [...files.keys()].some((key) => key.startsWith("workspaces/") && key.endsWith(".lock"))
        ? ("updating" as const)
        : recovery
          ? ("partial" as const)
          : ("ok" as const);
    return {
      revision,
      observedAt,
      state,
      repositories: allRepositories,
      workspaces,
      nextCursor: null,
      config,
      sourceFiles: files,
      ...(recovery
        ? {
            notice:
              "An unfinished or uninspectable operation needs CLI doctor inspection. Preserve its recorded artifacts; unrelated checked actions remain available.",
          }
        : {}),
    };
  });
}
