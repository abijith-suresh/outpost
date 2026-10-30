import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ErrorDetailFields, reasonDetails } from "./error-details.js";
import { resolveCanonicalPath } from "./path-safety.js";
import { isWindowsLocalPath, resolveLocalRemoteTransportPath } from "./remote-identity.js";

// Git for Windows v2.56.0.windows.2 setup.c explicit GIT_DIR startup uses strlen(GIT_DIR) >
// PATH_MAX - 40. MinGW's default PATH_MAX is 260 (crt/limits.h).
export const WINDOWS_GIT_DIR_BYTES = 220;
// compat/mingw.c mingw_getcwd() stores cwd in wchar_t[MAX_PATH], including its NUL.
// Its sole direct caller, strbuf_getcwd(), grows the UTF-8 output buffer on ERANGE.
// Win32 process creation additionally reserves a trailing separator, then NUL.
export const WINDOWS_GIT_CWD_UNITS = 258;
// Linked-worktree bootstrap opens /HEAD, /commondir and optionally /config.worktree
// before configuration enables long paths. Reserve the longest suffix (16) + NUL.
export const WINDOWS_GIT_ADMIN_UNITS = 260 - 16 - 1;

export class WindowsGitPathError extends Schema.TaggedError<WindowsGitPathError>()(
  "WindowsGitPathError",
  {
    ...ErrorDetailFields,
    message: Schema.String,
  }
) {}

export type WindowsGitPathKind = "gitdir" | "cwd" | "administrative-directory";

/** Pure metrics also exercise native Windows syntax and Unicode on non-Windows CI. */
export function validateWindowsGitPathLength(value: string, kind: WindowsGitPathKind) {
  const bytes = kind === "gitdir";
  const count = bytes ? Buffer.byteLength(value, "utf8") : value.length;
  const budget = bytes
    ? WINDOWS_GIT_DIR_BYTES
    : kind === "cwd"
      ? WINDOWS_GIT_CWD_UNITS
      : WINDOWS_GIT_ADMIN_UNITS;
  const unit = bytes ? "UTF-8 bytes" : "UTF-16 code units";
  return count <= budget
    ? Effect.void
    : Effect.fail(
        new WindowsGitPathError({
          ...reasonDetails("invalid-arguments"),
          action:
            "Run from a shorter user-owned current directory, or choose a shorter user-owned Outpost home for new repositories or worktreesRoot for future workspaces. Preserve the original home and paths to inspect existing work; Outpost does not move them.",
          message: `Windows Git ${kind} path exceeds the supported budget: ${value} (${count} ${unit}; maximum ${budget}). Choose a shorter user-owned root before retrying. Existing paths and state are preserved.`,
        })
      );
}

export function validateWindowsGitPath(
  value: string,
  kind: WindowsGitPathKind,
  platform: NodeJS.Platform = process.platform
) {
  if (platform !== "win32") return Effect.void;
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const literal = path.resolve(value);
    const canonical = yield* resolveCanonicalPath(literal);
    yield* validateWindowsGitPathLength(canonical, kind);
    // Git checks explicit argv/environment spelling before resolving junctions.
    // GetCurrentDirectoryW can likewise return that spelling before realpath.
    if (literal !== canonical) yield* validateWindowsGitPathLength(literal, kind);
    if (value !== literal && value !== canonical) yield* validateWindowsGitPathLength(value, kind);
  });
}

/** Git without -C inherits this cwd even when --git-dir is absolute. */
export function validateWindowsInvocationCwd(platform: NodeJS.Platform = process.platform) {
  return validateWindowsGitPath(process.cwd(), "cwd", platform);
}

export function validateWindowsManagedGitDir(
  value: string,
  platform: NodeJS.Platform = process.platform
) {
  return validateWindowsGitPath(value, "gitdir", platform);
}

/** Local transport launches upload-pack in the canonical source directory. */
export function validateWindowsLocalTransport(
  remoteUrl: string,
  sourceRepoPath: string,
  platform: NodeJS.Platform = process.platform
) {
  if (platform !== "win32") return Effect.void;
  return resolveLocalRemoteTransportPath(remoteUrl, sourceRepoPath).pipe(
    Effect.flatMap((local) =>
      local === undefined ? Effect.void : validateWindowsGitPath(local, "cwd", platform)
    )
  );
}

/** Existing clone transports are Git configuration, not new repository import identities.
 * Only local syntax launches upload-pack from a user path that needs a cwd budget.
 */
export function validateWindowsConfiguredTransport(
  transport: string,
  anchor: string,
  platform: NodeJS.Platform = process.platform
) {
  if (platform !== "win32") return Effect.void;
  if (/^file:\/\//i.test(transport))
    return validateWindowsLocalTransport(transport, anchor, platform);
  const drive = isWindowsLocalPath(transport, "win32");
  const colon = transport.indexOf(":");
  const separator = transport.search(/[\\/]/);
  // URL, SCP and configured remote-helper syntax are non-local. Git validates their transport.
  if (!drive && colon >= 0 && (separator < 0 || colon < separator)) return Effect.void;
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    yield* validateWindowsGitPath(path.resolve(anchor, transport), "cwd", platform);
  });
}

/** Creation/removal children export the checkout's .git path, not its resolved admin directory. */
export function validateWindowsCheckout(
  value: string,
  platform: NodeJS.Platform = process.platform
) {
  if (platform !== "win32") return Effect.void;
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    yield* validateWindowsGitPath(value, "cwd", platform);
    yield* validateWindowsGitPath(path.join(value, ".git"), "gitdir", platform);
  });
}

/** Git v2.56.0.windows.2 refs.c check_or_sanitize_refname(), for one portable filename component.
 * Replacement/removal cannot expand it; the single '@' special case adds '-/'.
 */
export function sanitizedWorktreeName(name: string): string {
  if (name === "@") return "-/@";
  let sanitized = Array.from(name, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 32 || code === 127 || "~^:?*[\\".includes(character) ? "-" : character;
  })
    .join("")
    .replace(/\.{2,}/g, ".")
    .replace(/@\{/g, "@-");
  if (sanitized.startsWith(".")) sanitized = `-${sanitized.slice(1)}`;
  while (sanitized.endsWith(".lock")) sanitized = sanitized.slice(0, -5);
  return sanitized;
}

/** builtin/worktree.c add_worktree() tries basename, basename1, basename2, ... . With K entries
 * in its parent, one of the first K+1 candidates is free. Count all entries, including
 * files/case aliases; home locking excludes cooperating Outpost writers.
 */
export function administrativeNameBudget(name: string, existingEntries: number) {
  return `${sanitizedWorktreeName(name)}${"9".repeat(String(existingEntries + 1).length)}`;
}

export function validateWindowsWorktreePlan(
  managed: string,
  checkout: string,
  platform: NodeJS.Platform = process.platform
) {
  if (platform !== "win32") return Effect.void;
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* validateWindowsManagedGitDir(managed, platform);
    yield* validateWindowsCheckout(checkout, platform);
    const adminRoot = path.join(managed, "worktrees");
    const parent = path.dirname(
      path.join(adminRoot, sanitizedWorktreeName(path.basename(checkout)))
    );
    const entries = (yield* fs.exists(parent)) ? yield* fs.readDirectory(parent) : [];
    const name = administrativeNameBudget(path.basename(checkout), entries.length);
    const candidate = path.join(adminRoot, name);
    // This is a length representative, not necessarily Git's next free name.
    // An occupied representative may be a junction to a shorter directory.
    // Resolve only its parent so it cannot undercount the prospective free path.
    const canonicalParent = yield* resolveCanonicalPath(path.dirname(candidate));
    yield* validateWindowsGitPathLength(
      path.join(canonicalParent, path.basename(candidate)),
      "administrative-directory"
    );
    yield* validateWindowsGitPathLength(path.resolve(candidate), "administrative-directory");
  });
}

/** Existing records remain readable; removal validates the actual Git back-pointer. */
export function validateWindowsExistingWorktree(
  managed: string,
  checkout: string,
  platform: NodeJS.Platform = process.platform,
  gitfileContents?: string
) {
  if (platform !== "win32") return Effect.void;
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* validateWindowsManagedGitDir(managed, platform);
    yield* validateWindowsCheckout(checkout, platform);
    const file = path.join(checkout, ".git");
    if (gitfileContents !== undefined || (yield* fs.exists(file))) {
      const text = gitfileContents ?? (yield* fs.readFileString(file));
      const match = /^gitdir:\s*(.+)\s*$/m.exec(text);
      if (match?.[1])
        yield* validateWindowsGitPath(
          path.resolve(checkout, match[1]),
          "administrative-directory",
          platform
        );
    }
  });
}
