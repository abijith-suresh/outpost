import { randomUUID } from "node:crypto";

import type { PlatformError } from "@effect/platform/Error";
import * as FileSystem from "@effect/platform/FileSystem";
import * as Path from "@effect/platform/Path";
import { Effect, Exit, Schema } from "effect";

export class StoreError extends Schema.TaggedError<StoreError>()("StoreError", {
  message: Schema.String,
}) {}

export function writeTextFileAtomic(
  filePath: string,
  contents: string,
): Effect.Effect<void, PlatformError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const temporaryPath = path.join(
      path.dirname(filePath),
      `.${path.basename(filePath)}.${randomUUID()}.tmp`,
    );

    yield* fs.writeFileString(temporaryPath, contents).pipe(
      Effect.andThen(fs.rename(temporaryPath, filePath)),
      Effect.onExit((exit) =>
        Exit.isFailure(exit)
          ? fs.remove(temporaryPath, { force: true }).pipe(Effect.ignore)
          : Effect.void,
      ),
    );
  });
}

export function writeJsonFileAtomic(
  filePath: string,
  value: unknown,
): Effect.Effect<
  void,
  StoreError | PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const contents = yield* Effect.try({
      try: () => {
        const serialized = JSON.stringify(value, null, 2);
        if (serialized === undefined) {
          throw new TypeError("Value is not JSON serializable");
        }
        return `${serialized}\n`;
      },
      catch: (error) =>
        new StoreError({
          message: `Failed to serialize JSON for ${filePath}: ${String(error)}`,
        }),
    });

    yield* writeTextFileAtomic(filePath, contents);
  });
}
