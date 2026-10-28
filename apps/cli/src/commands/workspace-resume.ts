import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  commandResult,
  commandString,
  readOnlyGitCommand as gitCommand,
} from "../child-process.js";
import {
  loadConfig,
  loadRepoRegistry,
  type OutpostConfig,
  type RepoRegistry,
  resolveOutpostHome,
} from "../config.js";
import { domainDetails, ErrorDetailFields, reasonDetails } from "../error-details.js";
import { verifyManagedRepository } from "../managed-repo.js";
import {
  getCanonicalPortablePathKey,
  validatePathSegment,
  validateSemanticIdentifier,
} from "../path-safety.js";
import { resolveRecordedRemoteIdentity } from "../remote-identity.js";
import type { ResultData } from "../result-schemas.js";
import type { CommandOutput } from "../types.js";
import {
  validateWindowsExistingWorktree,
  validateWindowsInvocationCwd,
} from "../windows-git-path.js";
import {
  getLockFilePath,
  getManifestFilePath,
  type Manifest,
  type RepositoryEntry,
  readManifest,
  resolveManagedPath,
  resolveManifestWorkspacePath,
  resolveWorktreePath,
} from "../workspace-manifest.js";

export const RESUME_LIMITS = {
  manifestBytes: 1024 * 1024,
  registryBytes: 4 * 1024 * 1024,
  members: 128,
  statusBytes: 256 * 1024,
  metadataBytes: 64 * 1024,
  indexBytes: 4 * 1024 * 1024,
} as const;
export class WorkspaceResumeError extends Schema.TaggedError<WorkspaceResumeError>()(
  "WorkspaceResumeError",
  { ...ErrorDetailFields, message: Schema.String }
) {}
class InspectionError extends Schema.TaggedError<InspectionError>()("ResumeInspectionError", {
  code: Schema.String,
  message: Schema.String,
}) {}
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type ResumeData = Mutable<ResultData["workspace resume"]>;
type Member = Mutable<ResumeData["worktrees"][number]>;
type Diagnostic = ResumeData["diagnostics"][number];
const recovery =
  "Run outpost doctor --json and inspect the recorded workspace, registration and Git state. Preserve local work; resume never repairs or adopts it.";
const problem = (code: string, message: string) =>
  Effect.fail(new InspectionError({ code, message }));
const diagnostic = (code: string, message: string, action = recovery): Diagnostic => ({
  code,
  message: message.slice(0, 2048),
  action,
});
const oid = (value: string) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
const redirectedRepositoryVariables = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_SHALLOW_FILE",
  "GIT_REPLACE_REF_BASE",
  "GIT_GRAFT_FILE",
  "GIT_ATTR_SOURCE",
] as const;

/** Bound reads before decoding and retain bytes plus identity for a final optimistic recheck. */
function snapshot(file: string, maximum = RESUME_LIMITS.metadataBytes) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const stat = yield* fs.lstat(file);
    if (stat.type !== "File")
      return yield* problem(
        "invalid-metadata",
        `Expected an ordinary metadata file, not a symlink or directory: ${file}`
      );
    if (Number(stat.size) > maximum)
      return yield* problem(
        "inspection-limit",
        `Metadata exceeds the ${maximum}-byte inspection limit: ${file}`
      );
    const bytes = yield* Effect.scoped(
      Effect.gen(function* () {
        const opened = yield* fs.open(file, { flag: "r" });
        const actual = yield* opened.stat;
        if (
          actual.type !== "File" ||
          actual.dev !== stat.dev ||
          actual.ino._tag !== stat.ino._tag ||
          (actual.ino._tag === "Some" &&
            stat.ino._tag === "Some" &&
            actual.ino.value !== stat.ino.value)
        )
          return yield* problem(
            "state-changed",
            `Metadata identity changed while opening: ${file}`
          );
        const buffer = new Uint8Array(maximum + 1);
        let length = 0;
        while (length < buffer.length) {
          const read = yield* opened.read(buffer.subarray(length));
          if (read === 0) break;
          length += read;
        }
        if (length > maximum)
          return yield* problem(
            "inspection-limit",
            `Metadata grew beyond the ${maximum}-byte inspection limit: ${file}`
          );
        return buffer.subarray(0, length);
      })
    );
    const canonical = yield* fs.realPath(file);
    const identity = `${stat.dev}:${stat.ino._tag === "Some" ? stat.ino.value : "unknown"}:${stat.mtime._tag === "Some" ? stat.mtime.value.toISOString() : "unknown"}:${createHash("sha256").update(bytes).digest("hex")}:${canonical}`;
    return { file, maximum, identity, bytes, text: new TextDecoder().decode(bytes) };
  });
}
type Snapshot = Effect.Success<ReturnType<typeof snapshot>>;
function unchanged(before: ReadonlyArray<Snapshot>) {
  return Effect.gen(function* () {
    for (const old of before) {
      const actual = yield* snapshot(old.file, old.maximum);
      if (actual.identity !== old.identity)
        return yield* problem("state-changed", `Metadata changed during inspection: ${old.file}`);
    }
  });
}
function checkLocks(home: string, ticket: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const ticketLock = yield* getLockFilePath(home, ticket);
    for (const file of [path.join(home, ".mutation.lock"), ticketLock]) {
      // lstat notices broken symbolic locks as held too; no lock bytes grant authority.
      const found = yield* fs.lstat(file).pipe(Effect.result);
      if (found._tag === "Success")
        return yield* problem(
          "lock-held",
          `Workspace inspection is not ready while a mutation/ticket lock exists: ${file}`
        );
      if (found.failure.reason._tag !== "NotFound")
        return yield* problem("lock-unavailable", `Cannot establish lock state at ${file}`);
    }
  });
}
function directory(file: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const info = yield* fs.lstat(file);
    if (info.type !== "Directory")
      return yield* problem(
        "foreign-path",
        `Expected an existing ordinary directory, not a replacement symlink or file: ${file}`
      );
    return yield* fs.realPath(file);
  });
}

/** Split-index reads renew sharedindex mtimes even with optional locks disabled.
 * Inspect the bounded index structure before asking Git to read it. No index
 * entries are interpreted as working-state facts and nothing is repaired. */
function requireNonRefreshingIndex(bytes: Uint8Array, objectHexLength: number) {
  const unsupported = () =>
    problem(
      "index-status-unavailable",
      "The existing index format cannot be inspected without risking metadata renewal. Preserve it and inspect Git state explicitly outside resume."
    );
  return Effect.gen(function* () {
    const hashBytes = objectHexLength / 2;
    const end = bytes.length - hashBytes;
    const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (end < 12 || data.toString("ascii", 0, 4) !== "DIRC") return yield* unsupported();
    const version = data.readUInt32BE(4);
    if (
      ![2, 3, 4].includes(version) ||
      !createHash(hashBytes === 20 ? "sha1" : "sha256")
        .update(data.subarray(0, end))
        .digest()
        .equals(data.subarray(end))
    )
      return yield* unsupported();
    let offset = 12;
    const count = data.readUInt32BE(8);
    for (let entry = 0; entry < count; entry++) {
      const start = offset;
      const fixed = 40 + hashBytes + 2;
      if (offset + fixed > end) return yield* unsupported();
      const flags = data.readUInt16BE(offset + fixed - 2);
      offset += fixed;
      if (flags & 0x4000) {
        if (version < 3 || offset + 2 > end) return yield* unsupported();
        offset += 2;
      }
      if (version === 4) {
        let length = 0;
        do {
          if (offset >= end || ++length > 10) return yield* unsupported();
        } while (data[offset++] & 0x80);
      }
      const nul = data.indexOf(0, offset);
      if (nul < 0 || nul >= end) return yield* unsupported();
      offset = version === 4 ? nul + 1 : start + Math.ceil((nul + 1 - start) / 8) * 8;
      if (offset > end) return yield* unsupported();
    }
    while (offset < end) {
      if (offset + 8 > end) return yield* unsupported();
      const signature = data.toString("ascii", offset, offset + 4);
      const size = data.readUInt32BE(offset + 4);
      if (offset + 8 + size > end) return yield* unsupported();
      if (signature === "link")
        return yield* problem(
          "split-index-status-unavailable",
          "The existing split index renews shared-index metadata when Git reads it. Resume preserves those bytes and timestamps and leaves working state unknown; inspect it explicitly outside resume."
        );
      if (!/^[A-Z]/.test(signature)) return yield* unsupported();
      offset += 8 + size;
    }
  });
}

/** Git status may execute conversion filters and recurse into arbitrary child
 * repositories. Inspect index/attributes first without conversion, and fail
 * honestly rather than execute those programs or describe uninspected work clean. */
function statusPreflight(git: (...args: string[]) => ChildProcess.Command, repoId: string) {
  return Effect.gen(function* () {
    const indexed = yield* commandResult(git("ls-files", "--stage", "-z"), {
      maxOutputBytes: RESUME_LIMITS.statusBytes,
    });
    if (
      indexed.exitCode !== 0 ||
      indexed.stdout.truncated ||
      indexed.stderr.truncated ||
      indexed.stdout.text.includes("\ufffd")
    )
      return yield* problem(
        "status-unavailable",
        `Cannot safely establish a bounded tracked-path inventory for ${repoId}; no working state is claimed.`
      );
    const paths = new Set<string>();
    for (const entry of indexed.stdout.text.split("\0").filter(Boolean)) {
      const match = /^([0-7]{6}) ([0-9a-f]+) [0-3]\t([\s\S]+)$/.exec(entry);
      if (!match || !oid(match[2]))
        return yield* problem(
          "status-unavailable",
          `Unexpected index record for ${repoId}; no working state is claimed.`
        );
      if (match[1] === "160000")
        return yield* problem(
          "submodule-status-unavailable",
          `Tracked submodules require explicit inspection outside resume for ${repoId}. Resume does not recurse into their repositories or execute their filters.`
        );
      paths.add(match[3]);
    }
    if (paths.size) {
      const raw = git("check-attr", "--all", "-z", "--stdin");
      if (raw._tag !== "StandardCommand")
        return yield* problem(
          "status-unavailable",
          "Cannot establish a safe attribute-inspection command."
        );
      const attributes = yield* commandResult(
        ChildProcess.make(raw.command, raw.args, {
          ...raw.options,
          stdin: Stream.make(new TextEncoder().encode(`${[...paths].join("\0")}\0`)),
        }),
        { maxOutputBytes: RESUME_LIMITS.statusBytes }
      );
      if (attributes.exitCode !== 0 || attributes.stdout.truncated || attributes.stderr.truncated)
        return yield* problem(
          "status-unavailable",
          `Cannot safely establish bounded filter attributes for ${repoId}; no working state is claimed.`
        );
      const values = attributes.stdout.text.split("\0");
      if (values.at(-1) === "") values.pop();
      if (values.length % 3 !== 0)
        return yield* problem(
          "status-unavailable",
          `Unexpected attribute records for ${repoId}; no working state is claimed.`
        );
      for (let index = 1; index < values.length; index += 3)
        if (values[index] === "filter")
          return yield* problem(
            "filter-status-unavailable",
            `Tracked filter attributes require explicit inspection outside resume for ${repoId}. Resume does not execute clean/process filters or claim their converted working state.`
          );
    }
    const configured = yield* commandResult(
      git("config", "--null", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|process)$"),
      { maxOutputBytes: RESUME_LIMITS.metadataBytes }
    );
    if (
      ![0, 1].includes(configured.exitCode) ||
      configured.stdout.truncated ||
      configured.stderr.truncated ||
      configured.stdout.text.includes("\ufffd")
    )
      return yield* problem(
        "status-unavailable",
        `Cannot safely bound conversion-filter configuration for ${repoId}.`
      );
    const drivers = new Set(
      configured.stdout.text
        .split("\0")
        .filter(Boolean)
        .map((key) => /^filter\.(.+)\.(?:clean|process)$/.exec(key)?.[1])
    );
    if (drivers.has(undefined) || drivers.size > 64)
      return yield* problem(
        "inspection-limit",
        `Conversion-filter configuration exceeds the bounded status preflight for ${repoId}.`
      );
    const overrides = [...drivers].flatMap((name) => [
      "-c",
      `filter.${name}.clean=`,
      "-c",
      `filter.${name}.process=`,
      "-c",
      `filter.${name}.required=false`,
    ]);
    if (overrides.join(" ").length > 8192)
      return yield* problem(
        "inspection-limit",
        `Conversion-filter overrides exceed the safe invocation bound for ${repoId}.`
      );
    return overrides;
  });
}

function inspectMember(
  config: OutpostConfig,
  registry: RepoRegistry,
  manifest: Manifest,
  workspace: string,
  repo: RepositoryEntry,
  member: Member
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const registered = registry.repos.find((entry) => entry.id === repo.id);
    const retained = registry.retainedRepositories?.find((entry) => entry.id === repo.id);
    member.registration = registered ? "active" : retained ? "retained" : "unregistered";
    if (!registered)
      return yield* problem(
        retained ? "repository-retained" : "repository-unregistered",
        retained
          ? `Repository ${repo.id} has retained registration. Inspect repo show ${repo.id} --retained and explicitly restore registration; no storage is adopted by resume.`
          : `Repository ${repo.id} is not registered. Inspect saved registration and ownership; resume does not import or adopt storage.`
      );
    const managed = yield* resolveManagedPath(config.reposRoot, repo.managedPath);
    const checkout = yield* resolveWorktreePath(workspace, repo.worktreePath);
    member.recordedPath = checkout;
    member.recordedManagedPath = managed;
    if (
      registered.name !== repo.name ||
      (yield* getCanonicalPortablePathKey(registered.managedRepoPath)) !==
        (yield* getCanonicalPortablePathKey(managed))
    )
      return yield* problem(
        "registration-mismatch",
        `Frozen manifest identity/path does not match active registration for ${repo.id}.`
      );
    const registeredIdentity = yield* resolveRecordedRemoteIdentity(registered.remoteUrl);
    if (registeredIdentity.id !== repo.id || registeredIdentity.name !== repo.name)
      return yield* problem(
        "registration-mismatch",
        `Saved repository URL identity does not match the frozen id/name for ${repo.id}.`
      );
    const canonicalManaged = yield* directory(managed);
    const canonicalCheckout = yield* directory(checkout);
    const gitfile = yield* snapshot(path.join(checkout, ".git"));
    yield* validateWindowsExistingWorktree(managed, checkout, process.platform, gitfile.text);
    const match = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(gitfile.text);
    if (!match?.[1])
      return yield* problem(
        "foreign-worktree",
        `Checkout has no valid linked-worktree gitfile: ${checkout}`
      );
    const admin = path.resolve(checkout, match[1]);
    const expectedAdminRoot = yield* fs.realPath(path.join(managed, "worktrees"));
    const canonicalAdmin = yield* directory(admin);
    if (
      path.dirname(canonicalAdmin) !== expectedAdminRoot ||
      (yield* getCanonicalPortablePathKey(path.dirname(path.dirname(canonicalAdmin)))) !==
        (yield* getCanonicalPortablePathKey(managed))
    )
      return yield* problem(
        "foreign-worktree",
        `Linked administrative directory does not belong to the recorded repository for ${repo.id}.`
      );
    const back = yield* snapshot(path.join(admin, "gitdir"));
    const common = yield* snapshot(path.join(admin, "commondir"));
    const adminHead = yield* snapshot(path.join(admin, "HEAD"));
    const managedConfig = yield* snapshot(path.join(managed, "config"));
    yield* verifyManagedRepository(config.reposRoot, registered, gitCommand);
    if (
      !back.text.trim() ||
      !common.text.trim() ||
      (yield* getCanonicalPortablePathKey(path.resolve(admin, back.text.trim()))) !==
        (yield* getCanonicalPortablePathKey(path.join(checkout, ".git"))) ||
      (yield* getCanonicalPortablePathKey(path.resolve(admin, common.text.trim()))) !==
        (yield* getCanonicalPortablePathKey(managed))
    )
      return yield* problem(
        "inconsistent-worktree",
        `Linked gitdir/commondir back-pointers do not match the frozen checkout for ${repo.id}.`
      );
    // An admin directory under the right parent alone is not ownership proof.
    const git = (...args: string[]) =>
      gitCommand(
        "-C",
        checkout,
        "--git-dir",
        ".git",
        "--work-tree",
        checkout,
        "-c",
        "core.bare=false",
        ...args
      );
    const absoluteAdmin = (yield* commandString(git("rev-parse", "--absolute-git-dir"))).trim();
    const commonDir = (yield* commandString(git("rev-parse", "--git-common-dir"))).trim();
    if (
      (yield* getCanonicalPortablePathKey(absoluteAdmin)) !==
        (yield* getCanonicalPortablePathKey(admin)) ||
      (yield* getCanonicalPortablePathKey(path.resolve(checkout, commonDir))) !==
        (yield* getCanonicalPortablePathKey(managed))
    )
      return yield* problem(
        "inconsistent-worktree",
        `Git resolved a different repository/admin identity for ${repo.id}.`
      );
    const branch = yield* commandResult(git("symbolic-ref", "--quiet", "HEAD"));
    if (branch.exitCode !== 0 && branch.exitCode !== 1)
      return yield* problem(
        "branch-unavailable",
        `Cannot inspect current branch attachment for ${repo.id}.`
      );
    if (branch.stdout.truncated)
      return yield* problem(
        "inspection-limit",
        `Branch inspection exceeded its output bound for ${repo.id}.`
      );
    member.currentBranch =
      branch.exitCode === 1 ? null : branch.stdout.text.trim().replace(/^refs\/heads\//, "");
    const head = (yield* commandString(
      git("rev-parse", "--verify", "--end-of-options", "HEAD^{commit}")
    ).pipe(
      Effect.mapError(
        () =>
          new InspectionError({
            code: "head-unavailable",
            message: `Current HEAD commit is unavailable in owned storage for ${repo.id}. Implicit fetching is disabled; preserve work and inspect local objects.`,
          })
      )
    )).trim();
    if (!oid(head))
      return yield* problem(
        "head-unavailable",
        `Current HEAD is not an available owned commit for ${repo.id}.`
      );
    member.currentHead = head;
    member.path = checkout;
    member.managedRepoPath = managed;
    if (member.currentBranch !== manifest.branch)
      return yield* problem(
        member.currentBranch === null ? "detached-head" : "wrong-branch",
        `Current branch ${member.currentBranch ?? "(detached)"} does not match frozen branch ${manifest.branch} for ${repo.id}; preserve work and select a branch deliberately outside resume.`
      );
    member.workingState = {
      status: "unknown",
      trackedEntries: 0,
      untrackedEntries: 0,
      conflictedEntries: 0,
      truncated: false,
    };
    const index = yield* snapshot(path.join(admin, "index"), RESUME_LIMITS.indexBytes);
    yield* requireNonRefreshingIndex(index.bytes, head.length);
    const filterOverrides = yield* statusPreflight(git, repo.id);
    const status = yield* commandResult(
      git(
        ...filterOverrides,
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=normal",
        "--ignore-submodules=all",
        "--no-renames"
      ),
      { maxOutputBytes: RESUME_LIMITS.statusBytes }
    );
    member.workingState = {
      status: "unknown",
      trackedEntries: 0,
      untrackedEntries: 0,
      conflictedEntries: 0,
      truncated: status.stdout.truncated || status.stderr.truncated,
    };
    if (status.exitCode !== 0)
      return yield* problem(
        "status-unavailable",
        `Working state cannot be established without fetching missing objects or changing state for ${repo.id}. ${status.stderr.text.slice(0, 1024)}`
      );
    if (member.workingState.truncated)
      return yield* problem(
        "inspection-limit",
        `Working-state output exceeded the ${RESUME_LIMITS.statusBytes}-byte bound for ${repo.id}; no clean state is claimed.`
      );
    let trackedEntries = 0;
    let untrackedEntries = 0;
    let conflictedEntries = 0;
    for (const record of status.stdout.text.split("\0").filter(Boolean)) {
      if (!/^[ MARCUD?!]{2} .+$/s.test(record))
        return yield* problem(
          "status-unavailable",
          `Unexpected Git status record for ${repo.id}; no clean state is claimed.`
        );
      const code = record.slice(0, 2);
      if (code === "??") untrackedEntries++;
      else {
        trackedEntries++;
        if (["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(code)) conflictedEntries++;
      }
    }
    member.workingState = {
      status: trackedEntries || untrackedEntries ? "dirty" : "clean",
      trackedEntries,
      untrackedEntries,
      conflictedEntries,
      truncated: false,
    };
    // Recheck attachment and identities after status, without modifying or renewing them.
    const finalHead = (yield* commandString(git("rev-parse", "--verify", "HEAD^{commit}"))).trim();
    const finalBranch = (yield* commandString(git("symbolic-ref", "--quiet", "HEAD"))).trim();
    yield* statusPreflight(git, repo.id);
    yield* unchanged([gitfile, back, common, adminHead, managedConfig, index]);
    if (
      head !== finalHead ||
      finalBranch !== `refs/heads/${manifest.branch}` ||
      canonicalManaged !== (yield* fs.realPath(managed)) ||
      canonicalCheckout !== (yield* fs.realPath(checkout))
    )
      return yield* problem(
        "state-changed",
        `Checkout identity, branch or HEAD changed during inspection for ${repo.id}; retry after inspecting concurrent work.`
      );
    member.resumable = true;
    member.status = "ready";
  });
}

export function runWorkspaceResume(ticket: string | undefined, extraArgs: ReadonlyArray<string>) {
  return Effect.gen(function* () {
    if (!ticket || extraArgs.length)
      return yield* Effect.fail(
        new WorkspaceResumeError({
          ...reasonDetails("invalid-arguments"),
          message: "Usage: outpost workspace resume <ticket> [--json]",
        })
      );
    yield* validateSemanticIdentifier("ticket", ticket);
    yield* validatePathSegment("ticket", ticket);
    const path = yield* Path.Path;
    const home = yield* resolveOutpostHome();
    const manifestPath = yield* getManifestFilePath(home, ticket);
    const data: ResumeData = {
      ticket,
      status: "not-ready",
      resumable: false,
      manifestPath,
      worktrees: [],
      diagnostics: [],
    };
    const inspection = yield* Effect.gen(function* () {
      yield* checkLocks(home, ticket);
      const redirects = redirectedRepositoryVariables.filter(
        (name) => process.env[name] !== undefined
      );
      if (redirects.length)
        return yield* problem(
          "repository-environment",
          `Inherited repository-layout variables prevent verified resume: ${redirects.join(", ")}. Run from a shell without these overrides after inspecting the intended workspace; variable values are not reported.`
        );
      const configBefore = yield* snapshot(
        path.join(home, "config.json"),
        RESUME_LIMITS.manifestBytes
      );
      const manifestBefore = yield* snapshot(manifestPath, RESUME_LIMITS.manifestBytes).pipe(
        Effect.mapError(
          () =>
            new InspectionError({
              code: "manifest-unavailable",
              message: `A valid existing manifest is required for ticket ${ticket}. Use outpost doctor --json to inspect incomplete or interrupted creation; no directory is adopted.`,
            })
        )
      );
      const registryBefore = yield* snapshot(
        path.join(home, "repos.json"),
        RESUME_LIMITS.registryBytes
      );
      const config = yield* loadConfig(home, { contents: configBefore.text });
      const raw = yield* Effect.try({
        try: () => JSON.parse(manifestBefore.text) as { repositories?: unknown[] },
        catch: () =>
          new InspectionError({
            code: "manifest-invalid",
            message: "Manifest JSON is invalid; preserve it and inspect doctor recovery guidance.",
          }),
      });
      if (Array.isArray(raw?.repositories) && raw.repositories.length > RESUME_LIMITS.members)
        return yield* problem(
          "inspection-limit",
          `Workspace exceeds the ${RESUME_LIMITS.members}-member inspection bound.`
        );
      const manifest = yield* readManifest(home, ticket, undefined, {
        memberPaths: "lexical",
        contents: manifestBefore.text,
        config,
      });
      const registry = yield* loadRepoRegistry(home, {
        canonicalPaths: false,
        contents: registryBefore.text,
      });
      if (
        manifest.repositories.length === 0 ||
        manifest.repositories.length > RESUME_LIMITS.members
      )
        return yield* problem(
          "inspection-limit",
          `Workspace must have 1-${RESUME_LIMITS.members} frozen members for bounded resume inspection.`
        );
      const workspace = yield* resolveManifestWorkspacePath(config, manifest);
      yield* directory(workspace);
      data.ticketDirectory = workspace;
      data.expectedBranch = manifest.branch;
      data.createdAt = manifest.createdAt;
      yield* validateWindowsInvocationCwd();
      const members: Member[] = [];
      for (const repo of manifest.repositories) {
        const member: Member = {
          id: repo.id,
          name: repo.name,
          status: "not-ready",
          resumable: false,
          registration: "unregistered",
          originalBase: {
            base: repo.base,
            ...(repo.baseSource === undefined
              ? {}
              : {
                  baseSource: repo.baseSource,
                  requestedBase: repo.requestedBase,
                  baseRef: repo.baseRef,
                  baseCommit: repo.baseCommit,
                }),
          },
          diagnostics: [],
        };
        const result = yield* inspectMember(
          config,
          registry,
          manifest,
          workspace,
          repo,
          member
        ).pipe(Effect.result);
        if (result._tag === "Failure") {
          member.diagnostics = [
            diagnostic(
              result.failure instanceof InspectionError
                ? result.failure.code
                : "member-unavailable",
              result.failure.message
            ),
          ];
          if (member.workingState)
            member.workingState = { ...member.workingState, status: "unknown" };
        }
        members.push(member);
      }
      data.worktrees = members;
      yield* checkLocks(home, ticket);
      yield* unchanged([configBefore, manifestBefore, registryBefore]);
    }).pipe(Effect.result);
    if (inspection._tag === "Failure") {
      const error = inspection.failure;
      data.diagnostics = [
        diagnostic(
          error instanceof InspectionError ? error.code : "workspace-unavailable",
          error.message
        ),
      ];
      data.worktrees = data.worktrees.map((member) => ({
        ...member,
        status: "not-ready",
        resumable: false,
        diagnostics: [
          ...member.diagnostics,
          diagnostic(
            "snapshot-unavailable",
            "The workspace snapshot could not be verified consistently; preserve work and inspect diagnostics."
          ),
        ],
      }));
    }
    const ready = data.worktrees.filter((member) => member.resumable).length;
    data.status =
      ready && ready === data.worktrees.length && data.diagnostics.length === 0
        ? "ready"
        : ready
          ? "partial"
          : "not-ready";
    data.resumable = data.status === "ready";
    return {
      command: "workspace resume",
      data,
      ...(data.resumable ? {} : { exitCode: 1 as const }),
    } satisfies CommandOutput<"workspace resume">;
  }).pipe(
    Effect.mapError(
      (error) => new WorkspaceResumeError({ ...domainDetails(error), message: error.message })
    )
  );
}
