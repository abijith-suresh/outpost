import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import {
  type BaseSelection,
  BaseSelectionError,
  requireOwnedCheckoutObjects,
  requireOwnedReuseStorage,
} from "./base-selection.js";
import { verifyBorrowed } from "./borrowed-repo.js";
import type { BorrowedRecord } from "./borrowed-schema.js";
import { checkedHooks, safeBorrowedGit } from "./borrowed-workspace.js";
import { inspectCachedRemote } from "./cached-base.js";
import { acquireBranchCreation, commandResult, readOnlyGitCommand } from "./child-process.js";
import { resolvePathWithinRoot, validatePortableFilename } from "./path-safety.js";
import { requireOwnedIncomingStorage, requireOwnedReuseObjects } from "./reuse-object-storage.js";
import { validateWindowsGitPath, validateWindowsLocalTransport } from "./windows-git-path.js";

export const freshError = (stage: string) =>
  new BaseSelectionError({
    message: `Fresh base: ${stage}. Selection is not confirmed; preserve receipts, objects and operation records. Run outpost doctor --json before any manual retry. Raw Git diagnostics are withheld; tracking refs are unchanged.`,
  });

export function freshDeadline() {
  const budget = Number(process.env.OUTPOST_GIT_TIMEOUT_MS ?? 120_000);
  return Number.isFinite(budget) && budget > 0
    ? Effect.succeed(performance.now() + budget)
    : Effect.fail(freshError("Invalid finite selection deadline"));
}
export function withinFreshDeadline<A, E, R>(effect: Effect.Effect<A, E, R>, deadline: number) {
  return Effect.suspend(() => {
    const remaining = deadline - performance.now();
    return remaining > 0
      ? effect.pipe(
          Effect.timeoutOrElse({
            duration: remaining,
            orElse: () => Effect.fail(freshError("Whole-selection deadline expired")),
          })
        )
      : Effect.fail(freshError("Whole-selection deadline expired"));
  });
}

/** Git bootstraps within the existing 220-byte common-dir budget. After -c core.longpaths,
 * known SHA256 pack names add at most 14+74 UTF16 units; no 243-unit admin limit applies to pack files.
 * Check raw/canonical bootstrap and derived containment/components without inventing a shorter internal budget.
 */
export function preflightFreshIncoming(record: BorrowedRecord, selectedOid?: string) {
  return Effect.gen(function* () {
    yield* verifyBorrowed(record);
    yield* validateWindowsGitPath(record.common.path, "gitdir");
    yield* validateWindowsGitPath(record.anchor.path, "cwd");
    yield* requireOwnedReuseStorage(
      { id: record.id, managedRepoPath: record.common.path },
      "",
      "refs/replace"
    );
    yield* requireOwnedReuseStorage(
      { id: record.id, managedRepoPath: record.common.path },
      "",
      "info/grafts"
    );
    yield* requireOwnedIncomingStorage(record.common.path, record.id, selectedOid);
    for (const name of [
      `pack-${"f".repeat(64)}.pack`,
      `pack-${"f".repeat(64)}.idx`,
      `pack-${"f".repeat(64)}.rev`,
      `pack-${"f".repeat(64)}.keep`,
      "tmp_pack_XXXXXX",
    ]) {
      yield* validatePortableFilename("incoming pack filename", name);
      yield* resolvePathWithinRoot(record.common.path, `objects/pack/${name}`);
    }
  });
}

/** Metadata-only preparation. No remote connection and no tracking-ref inspection. */
export function prepareBorrowedFresh(record: BorrowedRecord, remote?: string, requested?: string) {
  return Effect.gen(function* () {
    if (
      !remote ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(remote) ||
      remote.includes("..") ||
      remote.endsWith(".lock")
    )
      return yield* freshError("An explicit valid single-component --remote is required");
    const branch = requested?.startsWith("refs/heads/") ? requested.slice(11) : requested;
    if (
      !branch ||
      ["HEAD", "default", "@"].includes(branch) ||
      branch.startsWith("refs/") ||
      branch.startsWith("-") ||
      /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(branch)
    )
      return yield* freshError("An explicit --base branch suffix or full heads ref is required");
    if (
      Object.entries(process.env).some(
        ([key, value]) => value && (/^GIT_TRACE/.test(key) || key === "GIT_CURL_VERBOSE")
      )
    )
      return yield* freshError("Inherited Git transport tracing is unsupported");
    const remoteRef = `refs/heads/${branch}`;
    // Allow the longest supported OID, separator and CRLF within the complete advertisement bound.
    if (Buffer.byteLength(remoteRef, "utf8") + 64 + 1 + 2 > 4096)
      return yield* freshError(
        "Requested server ref exceeds the complete advertisement byte budget"
      );
    const git = (...args: string[]) =>
      readOnlyGitCommand(...args).pipe(ChildProcess.setCwd(record.anchor.path));
    const valid = yield* commandResult(git("check-ref-format", `refs/heads/${branch}`), {
      maxOutputBytes: 4096,
    });
    const shallow = yield* commandResult(git("rev-parse", "--is-shallow-repository"), {
      maxOutputBytes: 4096,
    });
    if (valid.exitCode !== 0 || shallow.exitCode !== 0 || shallow.stdout.text.trim() !== "false")
      return yield* freshError("Invalid branch or unsupported shallow repository");
    const format = yield* commandResult(git("rev-parse", "--show-object-format"), {
      maxOutputBytes: 4096,
    });
    if (
      format.exitCode !== 0 ||
      format.stdout.truncated ||
      format.stderr.truncated ||
      !["sha1", "sha256"].includes(format.stdout.text.trim())
    )
      return yield* freshError("Unsupported source object format");
    const binding = yield* inspectCachedRemote(record, remote);
    yield* validateWindowsLocalTransport(binding, record.anchor.path);
    yield* preflightFreshIncoming(record);
    return {
      base: branch,
      baseSource: "fresh-remote",
      requestedBase: requested!,
      baseRemote: remote,
      remoteRef,
      baseRef: `refs/heads/${branch}`,
      startPoint: null,
    } satisfies BaseSelection;
  }).pipe(
    Effect.mapError((error) =>
      error instanceof BaseSelectionError && error.message.startsWith("Fresh base:")
        ? error
        : freshError("Saved-anchor fresh preflight unavailable")
    )
  );
}

/** No config/URL/raw process contents may cross this boundary. */
export function selectBorrowedFresh(
  record: BorrowedRecord,
  selection: BaseSelection,
  receiptRef: string,
  operationId: string,
  hooks: string,
  deadline: number,
  recordStep: (
    step: Record<string, unknown>
  ) => Effect.Effect<void, { message: string }, FileSystem.FileSystem | Path.Path>
) {
  return withinFreshDeadline(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const remote = selection.baseRemote!;
      const binding = yield* inspectCachedRemote(record, remote);
      const verify = () =>
        Effect.gen(function* () {
          yield* checkedHooks(hooks);
          if ((yield* inspectCachedRemote(record, remote)) !== binding)
            return yield* freshError("Observed remote binding change");
          yield* requireOwnedReuseStorage(
            { id: record.id, managedRepoPath: record.common.path },
            "",
            receiptRef
          );
        });
      const command = (...args: string[]) => {
        const base = safeBorrowedGit(
          hooks,
          "-c",
          "core.askPass=",
          "-c",
          "credential.interactive=false",
          "-c",
          "trace2.normalTarget=0",
          "-c",
          "trace2.eventTarget=0",
          "-c",
          "trace2.perfTarget=0",
          ...args
        ).pipe(
          ChildProcess.setCwd(record.anchor.path),
          ChildProcess.setEnv({
            GIT_ASKPASS: "",
            SSH_ASKPASS: "",
            SSH_ASKPASS_REQUIRE: "never",
            GIT_TRACE: "0",
            GIT_TRACE_PACKET: "0",
            GIT_TRACE_CURL: "0",
            GIT_TRACE2: "0",
            GIT_TRACE2_EVENT: "0",
            GIT_TRACE2_PERF: "0",
            GIT_TRACE_SETUP: "0",
            GIT_TRACE_PERFORMANCE: "0",
          })
        );
        // Git enables curl verbosity by presence, including the value "0". Node omits undefined env entries.
        return base._tag === "StandardCommand"
          ? ChildProcess.make(base.command, base.args, {
              ...base.options,
              stdin: "ignore",
              env: { ...base.options.env, GIT_CURL_VERBOSE: undefined },
            })
          : base;
      };
      const run = (limit: number, ...args: string[]) =>
        Effect.gen(function* () {
          if (deadline <= performance.now())
            return yield* freshError("Whole-selection deadline expired");
          const result = yield* commandResult(command(...args), {
            timeoutMs: deadline - performance.now(),
            maxOutputBytes: limit,
          });
          if (result.exitCode !== 0 || result.stdout.truncated || result.stderr.truncated)
            return yield* freshError("Transport failed or bounded output incomplete");
          return result.stdout.text;
        });
      const step = (stage: string, commit?: string) =>
        recordStep({
          action: "borrowed-fresh",
          stage,
          repoId: record.id,
          receiptRef,
          operationId,
          remote,
          remoteRef: selection.remoteRef,
          ...(commit ? { commit } : {}),
        });
      yield* verify();
      if (yield* fs.exists(join(record.common.path, receiptRef)))
        return yield* freshError("Receipt already exists");
      yield* step("advertising");
      const advertisement = yield* run(
        4096,
        "ls-remote",
        "--exit-code",
        "--refs",
        remote,
        selection.remoteRef!
      );
      const format = yield* commandResult(command("rev-parse", "--show-object-format"), {
        maxOutputBytes: 4096,
        timeoutMs: Math.max(1, deadline - performance.now()),
      });
      const length =
        format.stdout.text.trim() === "sha256" ? 64 : format.stdout.text.trim() === "sha1" ? 40 : 0;
      const match = new RegExp(
        `^([0-9a-f]{${length}})\\t${selection.remoteRef!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\r?\\n$`
      ).exec(advertisement);
      if (
        format.exitCode !== 0 ||
        format.stdout.truncated ||
        format.stderr.truncated ||
        !length ||
        !match
      )
        return yield* freshError("Advertisement or object format is not a complete exact record");
      const commit = match[1];
      yield* step("advertised", commit);
      yield* verify();
      yield* step("fetching", commit);
      // Repeat after durable intent, immediately before the external object write.
      yield* verify();
      yield* preflightFreshIncoming(record, commit);
      yield* run(
        8192,
        "fetch",
        "--quiet",
        "--keep",
        "--atomic",
        "--no-tags",
        "--no-prune",
        "--no-prune-tags",
        "--no-recurse-submodules",
        "--no-auto-maintenance",
        "--no-write-commit-graph",
        "--no-write-fetch-head",
        "--refmap=",
        remote,
        commit
      );
      yield* verify();
      yield* requireOwnedReuseObjects(record.common.path, commit, record.id);
      yield* requireOwnedCheckoutObjects(
        { id: record.id, managedRepoPath: record.common.path },
        commit
      );
      yield* step("fetch-confirmed", commit);
      yield* step("receipt-preparing", commit);
      const locked = yield* acquireBranchCreation(
        record.common.path,
        receiptRef,
        commit,
        command,
        true
      );
      yield* verify();
      const symbolic = yield* commandResult(command("symbolic-ref", "--quiet", receiptRef), {
        timeoutMs: Math.max(1, deadline - performance.now()),
        maxOutputBytes: 4096,
      });
      if (symbolic.exitCode !== 1 || (yield* fs.exists(join(record.common.path, receiptRef))))
        return yield* freshError("Receipt appeared or became symbolic under lock");
      const lockPath = join(record.common.path, `${receiptRef}.lock`);
      const lockIdentity = yield* Effect.tryPromise(async () => {
        const stat = await lstat(lockPath, { bigint: true });
        if (!stat.isFile() || stat.isSymbolicLink() || (await realpath(lockPath)) !== lockPath)
          throw new Error("lock alias");
        return `${stat.dev}:${stat.ino}`;
      });
      yield* step("receipt-commit-requested", commit);
      yield* verify();
      yield* Effect.tryPromise(async () => {
        const stat = await lstat(lockPath, { bigint: true });
        if (!stat.isFile() || stat.isSymbolicLink() || `${stat.dev}:${stat.ino}` !== lockIdentity)
          throw new Error("lock replaced");
      });
      yield* locked.verify;
      yield* locked.commit;
      yield* verify();
      const direct = yield* run(4096, "show-ref", "--verify", "--hash", receiptRef);
      const sym = yield* commandResult(command("symbolic-ref", "--quiet", receiptRef), {
        maxOutputBytes: 4096,
        timeoutMs: Math.max(1, deadline - performance.now()),
      });
      if (sym.exitCode !== 1 || direct.trim() !== commit)
        return yield* freshError("Receipt confirmation unavailable");
      yield* requireOwnedReuseObjects(record.common.path, commit, record.id);
      yield* step("receipt-confirmed", commit);
      const selected = {
        ...selection,
        verifyFreshBinding: verify().pipe(
          Effect.mapError(() =>
            freshError("Fresh remote binding changed or became unavailable before admission")
          )
        ),
        startPoint: commit,
        baseRef: receiptRef,
        fetchReceipt: {
          operationId,
          ref: receiptRef,
          commit,
          selection: "advertised-branch-sha" as const,
        },
      };
      // Keep sensitive binding state exclusively in this closure, never in a plan/journal/result.
      Object.defineProperty(selected, "verifyFreshBinding", { enumerable: false });
      return selected;
    }),
    deadline
  ).pipe(Effect.mapError(() => freshError("Fresh transport or receipt protocol incomplete")));
}
