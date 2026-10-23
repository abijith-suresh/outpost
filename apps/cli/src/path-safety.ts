import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ErrorDetailFields, reasonDetails } from "./error-details.js";

export class PathSafetyError extends Schema.TaggedError<PathSafetyError>()("PathSafetyError", {
  ...ErrorDetailFields,
  message: Schema.String,
}) {}

function containsAsciiControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);

    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      return true;
    }
  }

  return false;
}

export function getSemanticIdentifierError(label: string, value: string): string | undefined {
  if (value.length === 0) {
    return `${label} may not be empty.`;
  }

  if (containsAsciiControlCharacter(value)) {
    return `${label} may not contain ASCII control characters.`;
  }

  return undefined;
}

export function semanticIdentifierSchema(label: string) {
  return Schema.String.pipe(
    Schema.check(Schema.makeFilter((value) => getSemanticIdentifierError(label, value)))
  );
}

export function validateSemanticIdentifier(
  label: string,
  value: string
): Effect.Effect<void, PathSafetyError> {
  const message = getSemanticIdentifierError(label, value);

  return message
    ? Effect.fail(new PathSafetyError({ ...reasonDetails("invalid-arguments"), message }))
    : Effect.void;
}

export function validatePathSegment(
  label: string,
  value: string,
  options: { allowTraversalSegments?: boolean } = {}
): Effect.Effect<void, PathSafetyError> {
  if (value.includes("/") || value.includes("\\")) {
    return Effect.fail(
      new PathSafetyError({
        ...reasonDetails("invalid-arguments"),
        message: `${label} may not contain path separators.`,
      })
    );
  }

  if (!options.allowTraversalSegments && (value === "." || value === "..")) {
    return Effect.fail(
      new PathSafetyError({
        ...reasonDetails("invalid-arguments"),
        message: `${label} may not contain path traversal.`,
      })
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
          ...reasonDetails("invalid-arguments"),
          message: `Path must remain within ${resolvedRoot}: ${resolvedPath}`,
        })
      );
    }

    return resolvedPath;
  });
}

export function getPortablePathKey(value: string): Effect.Effect<string, never, Path.Path> {
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
  value: string
): Effect.Effect<string, never, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const canonicalPath = yield* fs.realPath(value).pipe(Effect.orElseSucceed(() => value));

    return yield* getPortablePathKey(canonicalPath);
  });
}

/** Reserve generated workspace guidance even on case-insensitive or aliased filesystems. */
export function validateWorktreeGuidancePath(workspaceDirectory: string, worktreePath: string) {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const candidate = yield* getCanonicalPortablePathKey(worktreePath);
    const reserved = yield* getCanonicalPortablePathKey(path.join(workspaceDirectory, "AGENTS.md"));
    if (candidate === reserved)
      return yield* Effect.fail(
        new PathSafetyError({
          ...reasonDetails("invalid-state"),
          message: `Worktree collides with reserved generated path AGENTS.md: ${worktreePath}`,
        })
      );
  });
}
