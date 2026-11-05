import * as Effect from "effect/Effect";
import { importRepository } from "../application/repo-import.js";

export { RepoAddError } from "../application/repo-import.js";

export function runRepoAdd(inputPath: string | undefined, options: { remoteName?: string } = {}) {
  return importRepository(inputPath, options).pipe(
    Effect.map((data) => ({ command: "repo add" as const, data }))
  );
}
