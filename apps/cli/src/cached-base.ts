import * as Effect from "effect/Effect";
import * as ChildProcess from "effect/process/ChildProcess";
import {
  type BaseSelection,
  BaseSelectionError,
  requireOwnedCheckoutObjects,
  requireOwnedReuseStorage,
} from "./base-selection.js";
import { verifyBorrowed } from "./borrowed-repo.js";
import type { BorrowedRecord } from "./borrowed-schema.js";
import { commandResult, readOnlyGitCommand } from "./child-process.js";
import { reasonDetails } from "./error-details.js";
import { requireOwnedReuseObjects } from "./reuse-object-storage.js";

export const cachedError = (message: string) =>
  new BaseSelectionError({
    ...reasonDetails("invalid-state"),
    message: `Cached base: ${message}`,
  });

/** Metadata only. Never emit Git's raw diagnostics, URLs or nested causes. */
export function inspectCachedRemote(record: BorrowedRecord, remote: string) {
  return Effect.gen(function* () {
    yield* verifyBorrowed(record).pipe(
      Effect.mapError(() =>
        cachedError(
          "Saved anchor/private/common identity or Git configuration is unavailable. Preserve storage and inspect the saved clone outside Outpost."
        )
      )
    );
    const configured = yield* commandResult(
      readOnlyGitCommand("config", "--get-all", `remote.${remote}.url`).pipe(
        ChildProcess.setCwd(record.anchor.path)
      ),
      { maxOutputBytes: 4096 }
    ).pipe(Effect.mapError(() => cachedError("Cannot inspect bounded named-remote metadata.")));
    if (
      configured.exitCode !== 0 ||
      configured.stdout.truncated ||
      configured.stderr.truncated ||
      configured.stdout.text.trimEnd().split(/\r?\n/).length !== 1 ||
      !configured.stdout.text.trim()
    )
      return yield* cachedError(
        "Named remote requires exactly one configured fetch URL; metadata is missing, ambiguous or invalid. No URL or diagnostic is emitted."
      );
    const result = yield* commandResult(
      readOnlyGitCommand("remote", "get-url", "--all", remote).pipe(
        ChildProcess.setCwd(record.anchor.path)
      ),
      { maxOutputBytes: 4096 }
    ).pipe(
      Effect.mapError(() =>
        cachedError(
          "Cannot inspect bounded named-remote metadata in the saved anchor. No transport or helper was invoked."
        )
      )
    );
    const urls = result.stdout.text.trimEnd().split(/\r?\n/);
    if (
      result.exitCode !== 0 ||
      result.stdout.truncated ||
      result.stderr.truncated ||
      urls.length !== 1 ||
      !urls[0] ||
      [...urls[0]].some(
        (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 || char === "\ufffd"
      )
    )
      return yield* cachedError(
        "Named remote must have exactly one bounded effective fetch URL in the saved anchor; metadata is missing, ambiguous or invalid. No URL or Git diagnostic is emitted."
      );
    yield* verifyBorrowed(record).pipe(
      Effect.mapError(() =>
        cachedError(
          "Saved anchor identity/configuration changed during metadata inspection. No replacement is adopted."
        )
      )
    );
  });
}

export function resolveBorrowedCache(
  record: BorrowedRecord,
  remote: string | undefined,
  requested: string | undefined
) {
  return Effect.gen(function* () {
    if (!remote || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(remote) || remote.includes(".."))
      return yield* cachedError(
        "Provide --remote as a 1-64 character single component starting with a letter/number; use letters, numbers, dot, underscore or hyphen, without '..'."
      );
    const branch = requested?.startsWith("refs/heads/") ? requested.slice(11) : requested;
    if (
      !branch ||
      ["HEAD", "default", "@"].includes(branch) ||
      branch.startsWith("-") ||
      branch.startsWith("refs/") ||
      /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(branch)
    )
      return yield* cachedError(
        "Provide --base as an explicit branch suffix or full refs/heads/branch, never a default/HEAD, tag, SHA, tracking ref or revision expression."
      );
    const baseRef = `refs/remotes/${remote}/${branch}`;
    const remoteRef = `refs/heads/${branch}`;
    const git = (...args: string[]) =>
      readOnlyGitCommand(...args).pipe(ChildProcess.setCwd(record.anchor.path));
    for (const ref of [baseRef, remoteRef]) {
      const valid = yield* commandResult(git("check-ref-format", ref), {
        maxOutputBytes: 4096,
      }).pipe(Effect.mapError(() => cachedError("Cannot validate requested ref names.")));
      if (valid.exitCode !== 0)
        return yield* cachedError(
          "Invalid remote or branch ref syntax; no revision expressions are supported."
        );
    }
    yield* inspectCachedRemote(record, remote);
    yield* requireOwnedReuseStorage(
      { id: record.id, managedRepoPath: record.common.path },
      branch,
      baseRef
    ).pipe(
      Effect.mapError(() =>
        cachedError(
          "Selected tracking ref or object storage aliases external/unsupported storage. Preserve all source work."
        )
      )
    );
    const symbolic = yield* commandResult(git("symbolic-ref", "--quiet", baseRef), {
      maxOutputBytes: 4096,
    });
    if (symbolic.exitCode !== 1)
      return yield* cachedError(
        `Required tracking ref ${baseRef} is symbolic or unavailable; no local/source fallback is supported.`
      );
    const found = yield* commandResult(git("show-ref", "--verify", "--hash", baseRef), {
      maxOutputBytes: 4096,
    });
    const commit = found.stdout.text.trim();
    if (
      found.exitCode !== 0 ||
      found.stdout.truncated ||
      found.stderr.truncated ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)
    )
      return yield* cachedError(
        `Required direct tracking ref ${baseRef} is unavailable. Custom fetch mappings are not inferred; populate this exact cache explicitly outside Outpost.`
      );
    const peeled = yield* commandResult(
      git("rev-parse", "--verify", "--end-of-options", `${commit}^{commit}`),
      { maxOutputBytes: 4096 }
    );
    if (
      peeled.exitCode !== 0 ||
      peeled.stdout.truncated ||
      peeled.stderr.truncated ||
      peeled.stdout.text.trim() !== commit
    )
      return yield* cachedError(
        "Selected direct tracking ref must identify an available commit, never a tag or revision view."
      );
    yield* requireOwnedReuseObjects(record.common.path, commit, record.id).pipe(
      Effect.mapError(() =>
        cachedError(
          "Selected cached objects are missing or use unsupported aliases/pools/replacement views; implicit fetching is disabled."
        )
      )
    );
    yield* requireOwnedCheckoutObjects(
      { id: record.id, managedRepoPath: record.common.path },
      commit
    ).pipe(
      Effect.mapError(() =>
        cachedError(
          "Required cached checkout objects are unavailable; implicit fetching is disabled."
        )
      )
    );
    yield* inspectCachedRemote(record, remote);
    yield* requireOwnedReuseStorage(
      { id: record.id, managedRepoPath: record.common.path },
      branch,
      baseRef
    ).pipe(
      Effect.mapError(() =>
        cachedError("Selected tracking storage changed during inspection; no aliases are adopted.")
      )
    );
    const finalSymbolic = yield* commandResult(git("symbolic-ref", "--quiet", baseRef), {
      maxOutputBytes: 4096,
    });
    if (finalSymbolic.exitCode !== 1)
      return yield* cachedError(
        "Tracking ref became symbolic/unavailable during inspection. Preserve original work."
      );
    return {
      base: branch,
      baseSource: "cached-remote",
      requestedBase: requested ?? "",
      baseRef,
      startPoint: commit,
      baseRemote: remote,
      remoteRef,
    } satisfies BaseSelection;
  });
}
