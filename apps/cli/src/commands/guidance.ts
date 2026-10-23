import { fileURLToPath } from "node:url";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { domainDetails, ErrorDetailFields, reasonDetails } from "../error-details.js";
import type { CommandOutput } from "../types.js";

export const GUIDANCE_PATHS = {
  skillPath: fileURLToPath(new URL("../../skills/outpost/SKILL.md", import.meta.url)),
  skillDirectory: fileURLToPath(new URL("../../skills/outpost/", import.meta.url)),
  referencesPath: fileURLToPath(new URL("../../skills/outpost/references/", import.meta.url)),
  manPath: fileURLToPath(new URL("../../man/outpost.1", import.meta.url)),
  schemasPath: fileURLToPath(new URL("../../schemas/", import.meta.url)),
};
export class GuidanceError extends Schema.TaggedError<GuidanceError>()("GuidanceError", {
  ...ErrorDetailFields,
  message: Schema.String,
}) {}
const mapError = (error: { message: string }) =>
  new GuidanceError({ message: error.message, ...domainDetails(error) });

export function runDocs(topic = "overview") {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const topics = new Map<string, string>([
      ["overview", GUIDANCE_PATHS.skillPath],
      ["commands", path.join(GUIDANCE_PATHS.referencesPath, "commands.md")],
      ["recovery", path.join(GUIDANCE_PATHS.referencesPath, "recovery.md")],
      ["schemas", path.join(GUIDANCE_PATHS.schemasPath, "index.json")],
    ]);
    const filePath = topics.get(topic);
    if (!filePath)
      return yield* Effect.fail(
        new GuidanceError({
          ...reasonDetails("invalid-arguments"),
          message: `Unknown docs topic: ${topic}. Available topics: ${[...topics.keys()].join(", ")}.`,
        })
      );
    const content = yield* fs.readFileString(filePath).pipe(Effect.mapError(mapError));
    return {
      command: "docs",
      data: { topic, path: filePath, format: topic === "schemas" ? "json" : "markdown", content },
    } satisfies CommandOutput<"docs">;
  });
}
export function runSkillPath(): Effect.Effect<CommandOutput<"skill path">> {
  return Effect.succeed({ command: "skill path", data: GUIDANCE_PATHS });
}
export function runSkillShow() {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const content = yield* fs
      .readFileString(GUIDANCE_PATHS.skillPath)
      .pipe(Effect.mapError(mapError));
    return {
      command: "skill show",
      data: { path: GUIDANCE_PATHS.skillPath, content },
    } satisfies CommandOutput<"skill show">;
  });
}

/** Only this explicitly selected export directory is written. Existing destinations are never merged. */
export function runSkillExport(directory: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const selected = path.resolve(directory);
    const destination = path.join(selected, "outpost");
    if (yield* fs.exists(destination))
      return yield* Effect.fail(
        new GuidanceError({
          ...reasonDetails("invalid-state"),
          message: `Refusing existing skill destination: ${destination}. Select a directory without an outpost entry.`,
        })
      );
    yield* fs.makeDirectory(selected, { recursive: true });
    // Exclusive directory creation also rejects dangling symlinks and competing exports.
    yield* fs.makeDirectory(destination);
    const files: string[] = [];
    const copy = (
      source: string,
      target: string
    ): Effect.Effect<void, import("effect/PlatformError").PlatformError, FileSystem.FileSystem> =>
      Effect.gen(function* () {
        for (const name of (yield* fs.readDirectory(source)).sort()) {
          const from = path.join(source, name);
          const to = path.join(target, name);
          const stat = yield* fs.stat(from);
          if (stat.type === "Directory") {
            yield* fs.makeDirectory(to);
            yield* copy(from, to);
          } else {
            const bytes = yield* fs.readFile(from);
            yield* fs.writeFile(to, bytes, { flag: "wx" });
            files.push(path.relative(destination, to));
          }
        }
      });
    yield* copy(GUIDANCE_PATHS.skillDirectory, destination);
    return {
      command: "skill export",
      data: { directory: selected, skillPath: path.join(destination, "SKILL.md"), files },
    } satisfies CommandOutput<"skill export">;
  }).pipe(Effect.mapError(mapError));
}
