import { randomUUID } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  commandExitCode,
  commandResult,
  commandString,
  noLazyFetchGitCommand as gitCommand,
} from "./child-process.js";
import type { RepoRecord } from "./config.js";
import { domainDetails, ErrorDetailFields, reasonDetails } from "./error-details.js";

export const BaseSourceSchema = Schema.Literals(["local", "cached-remote", "fresh-remote"]);
export type BaseSource = typeof BaseSourceSchema.Type;
export const CommitSchema = Schema.String.check(
  Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)
);
export const ProvenanceFields = {
  baseSource: Schema.optional(BaseSourceSchema),
  requestedBase: Schema.optional(Schema.NullOr(Schema.String)),
  baseRef: Schema.optional(Schema.String),
  baseCommit: Schema.optional(CommitSchema),
};
export type BaseSelection = {
  base: string;
  baseSource: BaseSource;
  requestedBase: string | null;
  baseRef: string;
  startPoint: string | null;
  receiptRef?: string;
};
export class BaseSelectionError extends Schema.TaggedError<BaseSelectionError>()(
  "BaseSelectionError",
  {
    ...ErrorDetailFields,
    message: Schema.String,
  }
) {}
const invalid = (message: string) =>
  Effect.fail(new BaseSelectionError({ ...reasonDetails("invalid-arguments"), message }));
const mapError = (error: { message: string }) =>
  new BaseSelectionError({ message: error.message, ...domainDetails(error) });
const validOid = (value: string) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);

/** Only the selected commit/tree is inspected; no ancestor history or promisor fetch is needed. */
export function requireOwnedCheckoutObjects(repo: RepoRecord, commit: string) {
  return commandExitCode(
    gitCommand(
      "--git-dir",
      repo.managedRepoPath,
      "rev-list",
      "--objects",
      "--missing=error",
      "--no-walk",
      commit
    )
  ).pipe(
    Effect.flatMap((status) =>
      status === 0
        ? Effect.void
        : invalid(
            `Required checkout objects for ${commit} are not available in owned storage for ${repo.id}. Implicit promisor fetching is disabled; preserve source work and use a supported explicit import/refresh.`
          )
    ),
    Effect.mapError(mapError)
  );
}

export function resolveBase(repo: RepoRecord, source: BaseSource, requested: string | undefined) {
  return Effect.gen(function* () {
    let base = requested;
    if (base === undefined) {
      const head = (yield* commandString(
        gitCommand("--git-dir", repo.managedRepoPath, "symbolic-ref", "--quiet", "HEAD")
      ).pipe(
        Effect.mapError(
          () =>
            new BaseSelectionError({
              ...reasonDetails("invalid-arguments"),
              message: `Cannot resolve the recorded managed HEAD branch for ${repo.id}; provide --base explicitly.`,
            })
        )
      )).trim();
      if (!head.startsWith("refs/heads/"))
        return yield* invalid(
          `No recorded branch default for ${repo.id}; provide --base explicitly.`
        );
      base = head.slice("refs/heads/".length);
    }
    let baseRef: string;
    if (source === "local" && validOid(base)) baseRef = base;
    else if (source === "local") baseRef = base.startsWith("refs/") ? base : `refs/heads/${base}`;
    else {
      let branch = base;
      if (branch.startsWith("refs/heads/")) branch = branch.slice("refs/heads/".length);
      else if (source === "cached-remote" && branch.startsWith("refs/remotes/origin/"))
        branch = branch.slice("refs/remotes/origin/".length);
      else if (branch.startsWith("refs/"))
        return yield* invalid(
          `${source} accepts a branch name or refs/heads/<branch>, not ${base}.`
        );
      base = branch;
      baseRef = `refs/remotes/origin/${branch}`;
    }
    if (!validOid(baseRef)) {
      const valid = yield* commandExitCode(gitCommand("check-ref-format", baseRef));
      if (valid !== 0)
        return yield* invalid(`Invalid ${source} base ref for ${repo.id}: ${baseRef}`);
    }
    let startPoint: string | null = null;
    if (source !== "local") {
      const symbolic = yield* commandExitCode(
        gitCommand("--git-dir", repo.managedRepoPath, "symbolic-ref", "--quiet", baseRef)
      );
      if (symbolic === 0)
        return yield* invalid(
          `Refusing symbolic remote-tracking ref ${baseRef} for ${repo.id}; inspect it without changing user branches.`
        );
    }
    if (source !== "fresh-remote") {
      const resolved = yield* commandString(
        gitCommand(
          "--git-dir",
          repo.managedRepoPath,
          "rev-parse",
          "--verify",
          "--end-of-options",
          `${baseRef}^{commit}`
        )
      ).pipe(
        Effect.mapError(
          () =>
            new BaseSelectionError({
              ...reasonDetails("invalid-arguments"),
              message: `Base ${baseRef} is not an available owned commit for ${repo.id} in ${source} mode. No fallback or source import was performed.`,
            })
        )
      );
      startPoint = resolved.trim();
      if (!validOid(startPoint)) return yield* invalid(`Invalid resolved commit for ${repo.id}.`);
      yield* requireOwnedCheckoutObjects(repo, startPoint);
    }
    return {
      base,
      baseSource: source,
      requestedBase: requested ?? null,
      baseRef,
      startPoint,
    } satisfies BaseSelection;
  }).pipe(Effect.mapError(mapError));
}

/** Fetch only into a new operation-owned ref. A tracking symref must never dereference into user heads. */
export function refreshBase<R>(
  repo: RepoRecord,
  selection: BaseSelection,
  record: (step: Record<string, unknown>) => Effect.Effect<void, { message: string }, R>
) {
  return Effect.gen(function* () {
    const git = (...args: string[]) => gitCommand("--git-dir", repo.managedRepoPath, ...args);
    const receiptRef = `refs/outpost/base-fetch/${randomUUID()}`;
    const remoteRef = `refs/heads/${selection.base}`;
    const trackingRef = selection.baseRef;
    const symbolic = yield* commandExitCode(git("symbolic-ref", "--quiet", trackingRef));
    if (symbolic === 0)
      return yield* invalid(
        `Refusing symbolic remote-tracking ref ${trackingRef} for ${repo.id}; inspect it without changing user branches.`
      );
    const oldResult = yield* commandString(
      git("rev-parse", "--verify", "--end-of-options", trackingRef)
    ).pipe(Effect.result);
    const oldOid = oldResult._tag === "Success" ? oldResult.success.trim() : undefined;
    if (oldOid !== undefined && !validOid(oldOid))
      return yield* invalid(`Cannot establish tracking ref identity for ${repo.id}.`);
    const existingReceipt = yield* commandExitCode(
      git("show-ref", "--verify", "--quiet", receiptRef)
    );
    if (existingReceipt !== 1)
      return yield* invalid(`Cannot reserve a fresh base receipt ref for ${repo.id}.`);
    yield* record({
      action: "fetch-workspace-base",
      phase: "intent",
      repoId: repo.id,
      remoteRef,
      trackingRef,
      receiptRef,
    });
    const fetched = yield* commandResult(
      git(
        "-c",
        "gc.auto=0",
        "-c",
        "maintenance.auto=false",
        "fetch",
        "--porcelain",
        "--verbose",
        "--atomic",
        "--no-tags",
        "--no-prune",
        "--no-prune-tags",
        "--no-recurse-submodules",
        "--no-auto-maintenance",
        "--no-write-commit-graph",
        "--no-write-fetch-head",
        "--refmap=",
        "origin",
        `+${remoteRef}:${receiptRef}`
      )
    );
    if (fetched.exitCode !== 0 || fetched.stdout.truncated)
      return yield* Effect.fail(
        new BaseSelectionError({
          ...reasonDetails("operation-failed"),
          message: `Fresh base fetch failed for ${repo.id} (${remoteRef}, exit ${fetched.exitCode}). No cached/local fallback was used. Earlier refreshes or receipt refs may remain; inspect the operation journal. ${fetched.stderr.text.split(/\r?\n/).slice(0, 40).join("\n").slice(0, 8192) + (fetched.stderr.truncated || fetched.stderr.text.length > 8192 || fetched.stderr.text.split(/\r?\n/).length > 40 ? " [stderr truncated]" : "")}`,
        })
      );
    const lines = fetched.stdout.text
      .split(/\r?\n/)
      .map((line) => /^(.) ([0-9a-f]+) ([0-9a-f]+) (.+)$/.exec(line))
      .filter((entry) => entry?.[4] === receiptRef);
    if (lines.length !== 1 || !validOid(lines[0]?.[3] ?? ""))
      return yield* Effect.fail(
        new BaseSelectionError({
          ...reasonDetails("operation-failed"),
          message: `Cannot establish immutable fresh fetch receipt for ${repo.id}; preserve ${receiptRef} and inspect the journal.`,
        })
      );
    const commit = lines[0]?.[3] as string;
    const receiptOid = (yield* commandString(
      git("rev-parse", "--verify", "--end-of-options", `${receiptRef}^{commit}`)
    )).trim();
    if (receiptOid !== commit)
      return yield* Effect.fail(
        new BaseSelectionError({
          ...reasonDetails("invalid-state"),
          message: `Fresh receipt changed for ${repo.id}; preserve it and inspect the journal.`,
        })
      );
    yield* record({
      action: "fetch-workspace-base",
      phase: "confirmed",
      repoId: repo.id,
      remoteRef,
      trackingRef,
      receiptRef,
      baseCommit: commit,
    });
    // --no-deref protects user heads even if a concurrent writer installs a symbolic tracking ref.
    const updated = yield* commandExitCode(
      git("update-ref", "--no-deref", trackingRef, commit, oldOid ?? "0".repeat(commit.length))
    );
    if (updated !== 0)
      return yield* Effect.fail(
        new BaseSelectionError({
          ...reasonDetails("invalid-state"),
          message: `Remote-tracking ref changed during fresh selection for ${repo.id}. The fetched commit remains at ${receiptRef}; inspect the journal. No user branch was reset.`,
        })
      );
    yield* record({
      action: "update-base-tracking",
      phase: "confirmed",
      repoId: repo.id,
      trackingRef,
      baseCommit: commit,
      receiptRef,
    });
    yield* requireOwnedCheckoutObjects(repo, commit);
    return { ...selection, startPoint: commit, receiptRef };
  }).pipe(Effect.mapError(mapError));
}

/** Only a confirmed operation receipt at its expected commit may be removed. */
export function releaseBaseReceipt(repoPath: string, selection: BaseSelection) {
  if (!selection.receiptRef || !selection.startPoint) return Effect.void;
  return commandExitCode(
    gitCommand(
      "--git-dir",
      repoPath,
      "update-ref",
      "--no-deref",
      "-d",
      selection.receiptRef,
      selection.startPoint
    )
  ).pipe(
    Effect.flatMap((status) =>
      status === 0
        ? Effect.void
        : Effect.fail(
            new BaseSelectionError({
              ...reasonDetails("invalid-state"),
              message: `Fresh receipt changed; preserved ${selection.receiptRef} for inspection.`,
            })
          )
    )
  );
}
export function baseOutput(selection: BaseSelection) {
  return {
    baseSource: selection.baseSource,
    requestedBase: selection.requestedBase,
    baseRef: selection.baseRef,
    baseCommit: selection.startPoint,
    baseResolution:
      selection.startPoint === null ? ("fetch-required" as const) : ("resolved" as const),
  };
}
