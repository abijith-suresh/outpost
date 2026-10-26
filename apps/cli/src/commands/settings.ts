import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import {
  loadConfig,
  loadRepoRegistry,
  prepareExtendedState,
  resolveOutpostHome,
  upgradeConfig,
  validateExtraInstructions,
  validateTag,
  writeConfig,
  writeRepoRegistry,
} from "../config.js";
import { domainDetails, ErrorDetailFields, reasonDetails } from "../error-details.js";
import { acquireHomeMutationLock } from "../mutation-lock.js";
import {
  containsAsciiControlCharacter,
  getPortablePathKey,
  resolveCanonicalPath,
} from "../path-safety.js";
import type { CommandOutput } from "../types.js";
import { validateWindowsCheckout } from "../windows-git-path.js";
import { renderAgentsMarkdown } from "../workspace-agents.js";
import { runCreate } from "./create.js";

export class SettingsError extends Schema.TaggedError<SettingsError>()("SettingsError", {
  ...ErrorDetailFields,
  message: Schema.String,
}) {}
const mapError = (error: { message: string }) =>
  new SettingsError({ message: error.message, ...domainDetails(error) });
const invalid = (message: string) =>
  Effect.fail(new SettingsError({ ...reasonDetails("invalid-arguments"), message }));

export function runConfigShow() {
  return Effect.gen(function* () {
    const outpostHome = yield* resolveOutpostHome();
    const config = yield* loadConfig(outpostHome);
    return {
      command: "config show",
      data: { ...upgradeConfig(config), storedVersion: config.version },
    } satisfies CommandOutput<"config show">;
  }).pipe(Effect.mapError(mapError));
}

/** Settings alter future creation only. No worktree or generated guidance is moved or rewritten. */
export function runConfigSet(key: string, value: string) {
  return Effect.gen(function* () {
    if (key !== "worktreesRoot")
      return yield* invalid(
        "Only worktreesRoot can be set. Use guidance set/clear for extra instructions."
      );
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* validateWorktreesRootInput(value);
    const outpostHome = yield* resolveOutpostHome();
    const mutation = yield* acquireHomeMutationLock(outpostHome, "config set");
    const currentConfig = yield* loadConfig(outpostHome);
    const config = upgradeConfig(currentConfig);
    const root = yield* resolveCanonicalPath(value);
    if (path.dirname(root) === root)
      return yield* invalid("worktreesRoot cannot be a filesystem root.");
    if ((yield* fs.exists(root)) && (yield* fs.stat(root)).type !== "Directory")
      return yield* invalid("worktreesRoot must be a directory or a new directory path.");
    const rootKey = yield* getPortablePathKey(root);
    const overlaps = (a: string, b: string) =>
      a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
    const homeKey = yield* getPortablePathKey(yield* resolveCanonicalPath(outpostHome));
    if (homeKey === rootKey || homeKey.startsWith(`${rootKey}/`))
      return yield* invalid("worktreesRoot cannot contain the Outpost home.");
    for (const reserved of [
      config.reposRoot,
      path.join(outpostHome, "workspaces"),
      path.join(outpostHome, "operations"),
      path.join(outpostHome, "config.json"),
      path.join(outpostHome, "repos.json"),
      path.join(outpostHome, ".mutation.lock"),
    ]) {
      const key = yield* getPortablePathKey(yield* resolveCanonicalPath(reserved));
      if (overlaps(rootKey, key))
        return yield* invalid(
          "worktreesRoot must not overlap managed repositories or Outpost state."
        );
    }
    for (const prior of config.trustedWorktreesRoots ?? []) {
      const key = yield* getPortablePathKey(yield* resolveCanonicalPath(prior));
      if (rootKey !== key && overlaps(rootKey, key))
        return yield* invalid(
          "worktreesRoot must not nest within or contain a previous workspace root."
        );
    }
    // Ticket/member names are chosen later. Reserve the smallest valid layout;
    // creation rechecks the exact paths and derived Git administrative directory.
    yield* validateWindowsCheckout(path.join(root, "a", "a"));
    const next = {
      ...config,
      worktreesRoot: root,
      trustedWorktreesRoots: [...new Set([...(config.trustedWorktreesRoots ?? []), root])],
    };
    yield* mutation.record({
      action: "set-worktrees-root",
      previous: config.worktreesRoot,
      next: root,
    });
    yield* prepareExtendedState(outpostHome, currentConfig);
    yield* writeConfig(outpostHome, next);
    return {
      command: "config set",
      data: { key, value: root, futureWorkspacesOnly: true },
    } satisfies CommandOutput<"config set">;
  }).pipe(Effect.scoped, Effect.mapError(mapError));
}

export function runGuidanceSet(filePath?: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    let content = "";
    if (filePath !== undefined) {
      const stat = yield* fs.stat(filePath);
      if (stat.type !== "File" || stat.size > 65536n)
        return yield* invalid(
          "Instructions must be a regular UTF-8 text file at most 65536 bytes."
        );
      const file = yield* fs.open(filePath, { flag: "r" });
      const openedStat = yield* file.stat;
      if (openedStat.type !== "File")
        return yield* invalid("Instructions must be a regular UTF-8 text file.");
      const bounded = new Uint8Array(65537);
      let length = 0;
      while (length < bounded.length) {
        const count = yield* file.read(bounded.subarray(length));
        if (count === 0) break;
        length += count;
      }
      if (length > 65536) return yield* invalid("Instructions must be at most 65536 bytes.");
      const bytes = bounded.subarray(0, length);
      content = yield* Effect.try({
        try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        catch: () => new SettingsError({ message: "Instructions must be valid UTF-8 text." }),
      });
      yield* validateExtraInstructions(content);
    }
    const outpostHome = yield* resolveOutpostHome();
    const mutation = yield* acquireHomeMutationLock(outpostHome, "guidance settings");
    const config = yield* loadConfig(outpostHome);
    // Do not put instruction content into recovery journals.
    yield* mutation.record({
      action: "set-extra-instructions",
      bytes: Buffer.byteLength(content, "utf8"),
    });
    const upgraded = yield* prepareExtendedState(outpostHome, config);
    yield* writeConfig(outpostHome, { ...upgraded, extraInstructions: content });
    return {
      command: filePath === undefined ? "guidance clear" : "guidance set",
      data: { bytes: Buffer.byteLength(content, "utf8"), futureWorkspacesOnly: true },
    } satisfies CommandOutput<"guidance set" | "guidance clear">;
  }).pipe(Effect.scoped, Effect.mapError(mapError));
}

export function runRepoTag(id: string, add: readonly string[], remove: readonly string[]) {
  return Effect.gen(function* () {
    if (!add.length && !remove.length)
      return yield* invalid("Provide at least one --add or --remove tag.");
    for (const tag of [...add, ...remove]) yield* validateTag(tag);
    if (add.some((tag) => remove.includes(tag)))
      return yield* invalid("A tag cannot be both added and removed in one operation.");
    const outpostHome = yield* resolveOutpostHome();
    const mutation = yield* acquireHomeMutationLock(outpostHome, "repo tag");
    const config = yield* loadConfig(outpostHome);
    const registry = yield* loadRepoRegistry(outpostHome);
    const repo = registry.repos.find((repo) => repo.id === id);
    if (!repo)
      return yield* Effect.fail(
        new SettingsError({ ...reasonDetails("repo-missing"), message: `Unknown repo id: ${id}` })
      );
    const tags = [
      ...new Set([...(repo.tags ?? []).filter((tag) => !remove.includes(tag)), ...add]),
    ].sort();
    yield* mutation.record({ action: "tag-repository", id, tags });
    // Install the version barrier before metadata that an old binary would strip.
    if (config.version === 1) yield* writeConfig(outpostHome, upgradeConfig(config));
    yield* writeRepoRegistry(outpostHome, {
      ...registry,
      version: registry.version === 3 ? 3 : 2,
      repos: registry.repos.map((repo) => (repo.id === id ? { ...repo, tags } : repo)),
    });
    return { command: "repo tag", data: { id, tags } } satisfies CommandOutput<"repo tag">;
  }).pipe(Effect.scoped, Effect.mapError(mapError));
}

export function runGuidancePreview(args: readonly string[]) {
  return Effect.gen(function* () {
    const plan = yield* runCreate([...args, "--dry-run"], { interactive: false });
    const path = yield* Path.Path;
    const outpostHome = yield* resolveOutpostHome();
    const config = yield* loadConfig(outpostHome);
    const registry = yield* loadRepoRegistry(outpostHome);
    const content = yield* renderAgentsMarkdown(
      {
        ...(config.version === 2
          ? { version: 2 as const, worktreesRoot: config.worktreesRoot }
          : {}),
        ticket: plan.data.ticket,
        type: plan.data.type,
        branch: plan.data.branch,
        createdAt: "preview",
        workspacePath: plan.data.ticket,
        repositories: plan.data.worktrees.map((worktree) => ({
          id: worktree.repoId,
          name: worktree.repoName,
          base: worktree.base,
          managedPath: path.relative(
            config.reposRoot,
            registry.repos.find((repo) => repo.id === worktree.repoId)?.managedRepoPath ?? ""
          ),
          worktreePath: path.relative(plan.data.ticketDirectory, worktree.path),
        })),
      },
      config
    );
    return {
      command: "guidance preview",
      data: { ticketDirectory: plan.data.ticketDirectory, content },
    } satisfies CommandOutput<"guidance preview">;
  }).pipe(Effect.mapError(mapError));
}

/** Native path syntax only; validation does not access UNC servers or the filesystem. */
export function validateWorktreesRootInput(value: string) {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    if (!path.isAbsolute(value) || containsAsciiControlCharacter(value))
      return yield* invalid(
        "worktreesRoot must be an absolute native path without control characters."
      );
    // A Windows rooted path without a drive still depends on the caller's current drive.
    if (path.sep === "\\" && !/^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/.test(value))
      return yield* invalid(
        "Windows worktreesRoot requires a drive-qualified or UNC absolute path."
      );
  });
}
