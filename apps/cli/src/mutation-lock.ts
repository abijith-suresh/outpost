import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ErrorDetailFields, reasonDetails } from "./error-details.js";
import { type CompletedFresh, CompletedFreshSchema, isCompletedFresh } from "./fresh-inventory.js";
import { observeReceipt, type ReceiptObservation } from "./receipt-observation.js";
import { writeJsonFileAtomic } from "./store.js";

export class MutationError extends Schema.TaggedError<MutationError>()("MutationError", {
  ...ErrorDetailFields,
  message: Schema.String,
}) {}

/** Lock order is home mutation lock, then ticket lock. Never reap by age or PID. */
export function acquireHomeMutationLock(outpostHome: string, operation: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const id = randomUUID();
    const lockPath = path.join(outpostHome, ".mutation.lock");
    const operationsRoot = path.join(outpostHome, "operations");
    const journalPath = path.join(operationsRoot, `${id}.json`);
    const metadata = {
      id,
      operation,
      pid: process.pid,
      hostname: hostname(),
      startedAt: new Date().toISOString(),
      journalPath,
    };
    const contents = `${JSON.stringify(metadata)}\n`;
    const steps: Array<Record<string, unknown>> = [];
    let retained = false;
    yield* Effect.acquireRelease(
      fs.writeFileString(lockPath, contents, { flag: "wx" }).pipe(
        Effect.mapError(
          (error) =>
            new MutationError({
              ...reasonDetails(
                error.reason._tag === "AlreadyExists" ? "lock-held" : "invalid-state"
              ),
              message:
                error.reason._tag === "AlreadyExists"
                  ? `Outpost home is locked by another mutation at ${lockPath}. Retry after it finishes. If it crashed, run outpost doctor and inspect the recorded owner and artifacts before manually removing any lock.`
                  : `Failed to acquire home mutation lock: ${error.message}`,
            })
        )
      ),
      (_, exit) =>
        Effect.gen(function* () {
          if (Exit.isSuccess(exit) && !retained) {
            yield* fs.remove(journalPath, { force: true });
          } else if (!retained && steps.length > 0) {
            yield* writeJsonFileAtomic(journalPath, {
              ...metadata,
              status: "interrupted-or-failed",
              steps,
            });
          }
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              const actual = yield* fs.readFileString(lockPath);
              if (actual === contents) yield* fs.remove(lockPath);
            }).pipe(Effect.ignore)
          ),
          Effect.ignore
        )
    );
    return {
      id,
      journalPath,
      completeFresh: (ticket: string, members: CompletedFresh["members"]) =>
        Effect.gen(function* () {
          const inventory = yield* Schema.decodeUnknownEffect(CompletedFreshSchema)(
            {
              version: 1,
              kind: "fresh-receipt-inventory",
              status: "completed-retained",
              id,
              ticket,
              members,
            },
            { onExcessProperty: "error" }
          );
          yield* writeJsonFileAtomic(journalPath, inventory);
          const confirmed = yield* fs.readFileString(journalPath);
          if (confirmed !== `${JSON.stringify(inventory, null, 2)}\n`)
            return yield* Effect.fail(
              new MutationError({
                message:
                  "Fresh completed inventory confirmation failed; preserve manifest and receipts.",
              })
            );
          retained = true;
        }),
      record: (step: Record<string, unknown>) =>
        Effect.gen(function* () {
          yield* fs.makeDirectory(operationsRoot, { recursive: true });
          steps.push({ recordedAt: new Date().toISOString(), ...step });
          yield* writeJsonFileAtomic(journalPath, { ...metadata, status: "in-progress", steps });
        }).pipe(
          Effect.mapError(
            (error) =>
              new MutationError({
                message: `Failed to record operation progress before mutation: ${error.message}`,
              })
          )
        ),
    };
  });
}

/** Inspection only: metadata never grants permission to adopt or remove artifacts. */
export function inspectMutationState(
  outpostHome: string,
  options: { observeReceipts?: boolean } = {}
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const records: Array<{
      kind: string;
      path?: string;
      metadata?: unknown;
      receiptObservations?: Array<{ ref: string; status: ReceiptObservation }>;
      error?: string;
    }> = [];
    const inspect = (filePath: string, kind: string) =>
      Effect.gen(function* () {
        const stat = yield* fs.stat(filePath);
        if (Number(stat.size) > 1024 * 1024) {
          records.push({
            kind,
            path: filePath,
            error: "Operation metadata exceeds inspection byte bound.",
          });
          return;
        }
        const raw = yield* fs.readFileString(filePath);
        const metadata = yield* Effect.try({
          try: () => JSON.parse(raw) as unknown,
          catch: () => new Error("invalid JSON metadata"),
        });
        const receiptObservations =
          options.observeReceipts && isCompletedFresh(metadata)
            ? yield* Effect.forEach((metadata as CompletedFresh).members, (member) =>
                observeReceipt(member.common, member.fetchReceipt).pipe(
                  Effect.map((status) => ({ ref: member.fetchReceipt.ref, status }))
                )
              )
            : undefined;
        records.push({
          kind: isCompletedFresh(metadata) ? "completed-fresh" : kind,
          path: filePath,
          metadata,
          ...(receiptObservations ? { receiptObservations } : {}),
        });
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            records.push({ kind, path: filePath, error: error.message });
          })
        )
      );
    const lockPath = path.join(outpostHome, ".mutation.lock");
    if (yield* fs.exists(lockPath)) yield* inspect(lockPath, "home-lock");
    for (const [directory, kind, suffix] of [
      ["operations", "operation", ".json"],
      ["workspaces", "ticket-lock", ".lock"],
    ] as const) {
      const root = path.join(outpostHome, directory);
      if (!(yield* fs.exists(root))) continue;
      const files = yield* fs.readDirectory(root);
      for (const file of files.filter((file) => file.endsWith(suffix)).sort()) {
        yield* inspect(path.join(root, file), kind);
      }
    }
    return records;
  }).pipe(
    Effect.catch((error) => Effect.succeed([{ kind: "inspection-error", error: error.message }]))
  );
}
