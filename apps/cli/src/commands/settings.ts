import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { SettingsError, setInstructions } from "../application/settings.js";
import { reasonDetails } from "../error-details.js";

export {
  runConfigSet,
  runConfigShow,
  runGuidancePreview,
  runRepoTag,
  SettingsError,
  validateWorktreesRootInput,
} from "../application/settings.js";
export function runGuidanceSet(filePath?: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    let content = "";
    if (filePath !== undefined) {
      const stat = yield* fs.stat(filePath);
      if (stat.type !== "File" || stat.size > 65536n)
        return yield* invalid(
          "Instructions must be a regular UTF-8 text file at most 65536 bytes."
        );
      const file = yield* fs.open(filePath, { flag: "r" });
      const openedStat = yield* file.stat;
      if (openedStat.type !== "File")
        return yield* invalid("Instructions must be a regular UTF-8 text file.");
      const bounded = new Uint8Array(65537);
      let length = 0;
      while (length < bounded.length) {
        const count = yield* file.read(bounded.subarray(length));
        if (count === 0) break;
        length += count;
      }
      if (length > 65536) return yield* invalid("Instructions must be at most 65536 bytes.");
      const bytes = bounded.subarray(0, length);
      content = yield* Effect.try({
        try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        catch: () => new SettingsError({ message: "Instructions must be valid UTF-8 text." }),
      });
    }
    return yield* setInstructions(content, filePath === undefined);
  }).pipe(Effect.scoped);
}
function invalid(message: string) {
  return Effect.fail(new SettingsError({ ...reasonDetails("invalid-arguments"), message }));
}
