import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ApplicationInvocation, type Invocation, InvocationError } from "../application/context.js";
import type { RecordedInventory } from "../application/inventory.js";
import { importRepository } from "../application/repo-import.js";
import { unregisterRepository } from "../application/repo-remove.js";
import { restoreRepository } from "../application/repo-restore.js";
import { registerRepository } from "../application/repositories.js";
import { runRepoTag, setFutureRoot, setInstructions } from "../application/settings.js";
import { verifyBorrowed } from "../borrowed-repo.js";
import { loadConfig, loadRepoRegistry } from "../config.js";
import { verifyRetainedRepository } from "../managed-repo.js";
import { RequestFailure } from "./security.js";

const text = Schema.String.check(Schema.isMaxLength(4096));
const handle = Schema.String.check(Schema.isPattern(/^[0-9a-f-]{36}$/));
const Action = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("register"), checkoutPath: text, name: text }),
  Schema.Struct({
    kind: Schema.Literal("import"),
    checkoutPath: text,
    remoteName: Schema.optional(text),
  }),
  Schema.Struct({
    kind: Schema.Literals(["verify-registration", "unregister", "restore"]),
    handle,
  }),
  Schema.Struct({
    kind: Schema.Literal("tags"),
    handle,
    add: Schema.Array(text).check(Schema.isMaxLength(128)),
    remove: Schema.Array(text).check(Schema.isMaxLength(128)),
  }),
  Schema.Struct({ kind: Schema.Literal("set-future-root"), absolutePath: text }),
  Schema.Struct({
    kind: Schema.Literal("set-instructions"),
    text: Schema.String.check(Schema.isMaxLength(65536)),
  }),
  Schema.Struct({ kind: Schema.Literal("clear-instructions") }),
]);
const Submission = Schema.Struct({ requestId: handle, revision: handle, operation: Action });
type Action = typeof Action.Type;
export type OperationState = {
  id: string;
  state: "accepted" | "running" | "draining" | "succeeded" | "failed" | "unknown";
  message?: string;
};
/** Lifetime is the process instance, deliberately independent of browser sessions. */
export class ManagerOperations {
  private readonly ledger = new Map<
    string,
    {
      input: string;
      result: OperationState;
      abort: AbortController;
      done: Promise<void>;
      admitted: Promise<void>;
      error?: RequestFailure;
    }
  >();
  private active = false;
  private stopping = false;
  constructor(
    readonly inventory: RecordedInventory,
    readonly context: Invocation
  ) {}
  get(id: string) {
    const record = this.ledger.get(id);
    if (!record)
      throw new RequestFailure(
        404,
        "operation-missing",
        "No operation with this ID is recorded in this manager instance."
      );
    return { ...record.result };
  }
  async submit(raw: unknown) {
    let input: typeof Submission.Type;
    try {
      input = Schema.decodeUnknownSync(Submission)(raw, { onExcessProperty: "error" });
    } catch {
      throw new RequestFailure(400, "invalid-input", "Invalid operation input.");
    }
    const canonical = JSON.stringify({ revision: input.revision, operation: input.operation });
    const old = this.ledger.get(input.requestId);
    if (old) {
      if (old.input !== canonical)
        throw new RequestFailure(
          409,
          "request-conflict",
          "This request ID belongs to different input."
        );
      await old.admitted;
      if (old.error) throw old.error;
      return { ...old.result };
    }
    if (this.active || this.stopping)
      throw new RequestFailure(
        409,
        "busy",
        "Another action is active or this manager is stopping."
      );
    if (this.ledger.size >= 128)
      throw new RequestFailure(
        409,
        "operation-limit",
        "This manager reached its operation limit. Inspect results before explicitly restarting."
      );
    const abort = new AbortController();
    const result: OperationState = { id: input.requestId, state: "accepted" };
    let acknowledge!: () => void;
    const admission = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    const record: {
      input: string;
      result: OperationState;
      abort: AbortController;
      done: Promise<void>;
      admitted: Promise<void>;
      error?: RequestFailure;
    } = { input: canonical, result, abort, done: Promise.resolve(), admitted: admission };
    this.ledger.set(input.requestId, record);
    this.active = true;
    let admitted = false;
    let safeImportError: string | undefined;
    const context = {
      ...this.context,
      beforeLock: Effect.tryPromise({
        try: () =>
          this.inventory.files.validate().then((exists) => {
            if (!exists) throw new Error("Missing pinned home");
          }),
        catch: () => {
          record.error = new RequestFailure(
            409,
            "identity-changed",
            "Selected home changed. Preserve state and inspect before restarting."
          );
          return new InvocationError({
            message: "Selected home identity changed. Preserve state and restart after inspection.",
            reason: "identity-changed",
          });
        },
      }),
      beforeMutation: this.inventory.checkRevision(input.revision).pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            record.error = new RequestFailure(
              409,
              "stale-state",
              "State changed. Reload before deliberately submitting again."
            );
          })
        ),
        Effect.tap(() =>
          Effect.sync(() => {
            admitted = true;
            acknowledge();
          })
        )
      ),
    };
    result.state = "running";
    record.done = Effect.runPromise(
      this.execute(input.operation, input.revision).pipe(
        Effect.tapError((error) =>
          Effect.sync(() => {
            if (
              input.operation.kind === "import" &&
              typeof error === "object" &&
              error !== null &&
              "safeInput" in error
            ) {
              if (error.safeInput === "path")
                safeImportError = "Check the absolute checkout path and try again.";
              if (error.safeInput === "remote")
                safeImportError = "Check the checkout's remote name and try again.";
              if (error.safeInput === "multiple-remotes")
                safeImportError = "Enter the name of the remote to import.";
            }
            if (!admitted && !record.error) {
              const reason: unknown =
                typeof error === "object" && error !== null && "reason" in error
                  ? error.reason
                  : undefined;
              if (reason === "stale-state")
                record.error = new RequestFailure(
                  409,
                  "stale-state",
                  "State changed. Reload before deliberately submitting again."
                );
              else if (reason === "lock-held")
                record.error = new RequestFailure(
                  409,
                  "busy",
                  "The selected home is busy. Retry after the current operation finishes."
                );
              else if (reason === "invalid-arguments")
                record.error = new RequestFailure(
                  400,
                  "invalid-input",
                  "Input was refused. Check the entered fields and platform limits."
                );
            }
          })
        ),
        Effect.provideService(ApplicationInvocation, context),
        Effect.provide(NodeServices.layer)
      ),
      { signal: abort.signal }
    )
      .then(
        () => {
          result.state = "succeeded";
          result.message =
            input.operation.kind === "verify-registration"
              ? "Registration identity verified at request time. Working content was not checked."
              : "Action completed.";
        },
        () => {
          result.state = admitted && !safeImportError ? "unknown" : "failed";
          result.message =
            safeImportError ??
            (admitted
              ? "The action did not complete normally. Preserve state and inspect with the CLI before retrying."
              : "Action refused before admission. Reload recorded state and inspect the selected input.");
        }
      )
      .finally(() => {
        this.active = false;
        acknowledge();
      });
    await admission;
    if (record.error) throw record.error;
    return { ...result };
  }
  private execute(action: Action, revision: string) {
    return Effect.gen({ self: this }, function* () {
      if (action.kind === "import") {
        const path = yield* Path.Path;
        if (!path.isAbsolute(action.checkoutPath))
          return yield* Effect.fail(new Error("Absolute path required"));
        return yield* importRepository(action.checkoutPath, {
          remoteName: action.remoteName || undefined,
        });
      }
      if (action.kind === "register") {
        const path = yield* Path.Path;
        if (!path.isAbsolute(action.checkoutPath))
          return yield* Effect.fail(new Error("Absolute path required"));
        return yield* registerRepository(action);
      }
      if (action.kind === "set-future-root") return yield* setFutureRoot(action.absolutePath);
      if (action.kind === "set-instructions") return yield* setInstructions(action.text);
      if (action.kind === "clear-instructions") return yield* setInstructions("", true);
      const key = this.inventory.resolve(action.handle);
      if (!key?.startsWith("repo:")) return yield* Effect.fail(new Error("Unknown repository"));
      const id = key.slice(5);
      if (action.kind === "tags") return yield* runRepoTag(id, action.add, action.remove);
      if (action.kind === "unregister") return yield* unregisterRepository(id);
      if (action.kind === "restore") return yield* restoreRepository(id);
      // Advisory read: no write lock, but pin its home and expected metadata before and after Git.
      yield* this.inventory.checkRevision(revision);
      const before = yield* this.inventory.read();
      if (before.state !== "ok" && before.state !== "partial")
        return yield* Effect.fail(new Error("Metadata is updating"));
      const finish = Effect.gen({ self: this }, function* () {
        yield* this.inventory.checkRevision(revision);
        const after = yield* this.inventory.read();
        if (after.state !== "ok" && after.state !== "partial")
          return yield* Effect.fail(new Error("Metadata changed during verification"));
      });
      const registry = yield* loadRepoRegistry(this.context.home, { canonicalPaths: false });
      const borrowed = [
        ...(registry.borrowedRepositories ?? []),
        ...(registry.retainedBorrowedRepositories ?? []),
      ].find((repo) => repo.id === id);
      if (borrowed) {
        yield* verifyBorrowed(borrowed);
        yield* finish;
        return;
      }
      const managed = [...registry.repos, ...(registry.retainedRepositories ?? [])].find(
        (repo) => repo.id === id
      );
      if (!managed) return yield* Effect.fail(new Error("Unknown repository"));
      // This is the existing checked owned-storage validation, not a new adoption rule.
      const config = yield* loadConfig(this.context.home);
      yield* verifyRetainedRepository(config.reposRoot, managed);
      yield* finish;
    });
  }
  async settled(id: string) {
    const record = this.ledger.get(id);
    if (!record) throw new RequestFailure(404, "operation-missing", "Unknown operation.");
    await record.done;
    return { ...record.result };
  }
  cancel(id: string) {
    const record = this.ledger.get(id);
    if (!record) throw new RequestFailure(404, "operation-missing", "Unknown operation.");
    if (record.result.state === "running" || record.result.state === "accepted") {
      record.result.state = "draining";
      record.abort.abort();
    }
    return { ...record.result };
  }
  async drain() {
    this.stopping = true;
    for (const [id] of this.ledger) this.cancel(id);
    await Promise.all([...this.ledger.values()].map((record) => record.done));
  }
}

import * as Path from "effect/Path";
