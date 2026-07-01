import * as FileSystem from "@effect/platform/FileSystem";
import * as Path from "@effect/platform/Path";
import { Effect, Schema } from "effect";

export class PathSafetyError extends Schema.TaggedError<PathSafetyError>()(
  "PathSafetyError",
  {
    message: Schema.String,
  },
) {}

export function validatePathSegment(
  label: string,
  value: string,
  options: { allowTraversalSegments?: boolean } = {},
): Effect.Effect<void, PathSafetyError> {
  if (value.includes("/") || value.includes("\\")) {
    return Effect.fail(
      new PathSafetyError({
        message: `${label} may not contain path separators.`,
      }),
    );
  }

  if (!options.allowTraversalSegments && (value === "." || value === "..")) {
    return Effect.fail(
      new PathSafetyError({
        message: `${label} may not contain path traversal.`,
      }),
    );
  }

  return Effect.void;
}

export function resolvePathWithinRoot(
  root: string,
  ...segments: ReadonlyArray<string>
): Effect.Effect<string, PathSafetyError, Path.Path> {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const resolvedRoot = path.resolve(root);
    const resolvedPath = path.resolve(resolvedRoot, ...segments);
    const relativePath = path.relative(resolvedRoot, resolvedPath);
    const isOutsideRoot =
      path.isAbsolute(relativePath) ||
      relativePath === ".." ||
      relativePath.startsWith(`..${path.sep}`);

    if (isOutsideRoot) {
      return yield* Effect.fail(
        new PathSafetyError({
          message: `Path must remain within ${resolvedRoot}: ${resolvedPath}`,
        }),
      );
    }

    return resolvedPath;
  });
}

export function getPortablePathKey(
  value: string,
): Effect.Effect<string, never, Path.Path> {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    return path
      .resolve(value)
      .split(/[\\/]/)
      .map((segment) => segment.replace(/[ .]+$/g, "").toLowerCase())
      .join("/");
  });
}

export function getCanonicalPortablePathKey(
  value: string,
): Effect.Effect<string, never, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const canonicalPath = yield* fs
      .realPath(value)
      .pipe(Effect.orElseSucceed(() => value));

    return yield* getPortablePathKey(canonicalPath);
  });
}
