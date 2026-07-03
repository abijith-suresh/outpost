// Pure changeset-policy classifier.
//
// This module performs no I/O and never invokes Git. Callers collect the
// pull-request diff (see `check-changeset.mjs`) and the contents of every
// changeset added or modified by the PR, then hand those structured inputs
// to `classifyChangesetPolicy`. Keeping Git acquisition out of this module
// makes the policy deterministic and testable without GitHub state.

import parse from "@changesets/parse";

const RELEASE_PACKAGE = "@abijith-suresh/outpost";
const REQUIRED_RELEASE_TYPE = "patch";

/**
 * Normalize a Git path to forward slashes so matching is deterministic
 * across platforms.
 *
 * @param {string} path
 * @returns {string}
 */
export function toPosixPath(path) {
  return path.split("\\").join("/");
}

/**
 * True when a changed path is releasable CLI source or package behavior.
 *
 * Releasable paths:
 *   - apps/cli/src/**
 *   - apps/cli/scripts/**
 *   - apps/cli/package.json
 *   - apps/cli/tsconfig.json
 *
 * Tests, dist output, documentation, website files, typecheck/test
 * configuration, workflows, and root tooling are exempt unless mixed with a
 * releasable path.
 *
 * @param {string} path
 * @returns {boolean}
 */
export function isReleasablePath(path) {
  const normalized = toPosixPath(path);
  if (normalized === "apps/cli/package.json") return true;
  if (normalized === "apps/cli/tsconfig.json") return true;
  if (normalized.startsWith("apps/cli/src/")) return true;
  if (normalized.startsWith("apps/cli/scripts/")) return true;
  return false;
}

/**
 * True when a path is a pending changeset Markdown file that Changesets
 * itself recognizes. Mirrors `@changesets/read`'s discovery:
 *
 *   - the file must be a direct child of `.changeset/` (not nested);
 *   - the basename must not start with `.` (dotfiles are ignored);
 *   - the basename must end with `.md`;
 *   - the basename must not match `README.md` case-insensitively.
 *
 * Anything else (`.changeset/nested/fake.md`, `.changeset/.fake.md`,
 * `.changeset/readme.md`, `.changeset/config.json`) is not a usable
 * changeset and cannot satisfy the policy.
 *
 * @param {string} path
 * @returns {boolean}
 */
export function isChangesetMarkdown(path) {
  const normalized = toPosixPath(path);
  const prefix = ".changeset/";
  if (!normalized.startsWith(prefix)) return false;
  const basename = normalized.slice(prefix.length);
  if (basename === "") return false;
  if (basename.includes("/")) return false;
  if (basename.startsWith(".")) return false;
  if (!basename.endsWith(".md")) return false;
  if (/^readme\.md$/i.test(basename)) return false;
  return true;
}

/**
 * A diff entry mirrors `git diff --name-status -z` output:
 *   { status, from, to }
 * For renames (status starts with `R`) and copies (`C`) both `from` and `to`
 * are meaningful; otherwise `from === to`.
 *
 * @typedef {Object} DiffEntry
 * @property {string} status
 * @property {string} from
 * @property {string} to
 */

/**
 * Normalize a raw status token from `git diff --name-status`. Renames and
 * copies carry a similarity score (e.g. `R100`); strip it so the classifier
 * only cares about the kind of change.
 *
 * @param {string} status
 * @returns {string}
 */
function normalizeStatus(status) {
  if (status === "") return "";
  const first = status[0];
  if (first === "R") return "R";
  if (first === "C") return "C";
  return status;
}

/**
 * Is this entry a rename or copy that carries two paths?
 *
 * @param {DiffEntry} entry
 * @returns {boolean}
 */
function isRenameOrCopy(entry) {
  const kind = normalizeStatus(entry.status);
  return kind === "R" || kind === "C";
}

/**
 * Paths that must be inspected for this entry. For renames and copies both
 * the old and the new path are returned so the caller can classify each.
 *
 * @param {DiffEntry} entry
 * @returns {string[]}
 */
export function entryRelevantPaths(entry) {
  if (isRenameOrCopy(entry))
    return [toPosixPath(entry.from), toPosixPath(entry.to)];
  return [toPosixPath(entry.to)];
}

/**
 * Releasable paths touched by the diff, deduplicated and sorted.
 *
 * @param {DiffEntry[]} entries
 * @returns {string[]}
 */
export function releasablePathsFromEntries(entries) {
  const releasable = new Set();
  for (const entry of entries) {
    for (const path of entryRelevantPaths(entry)) {
      if (isReleasablePath(path)) releasable.add(path);
    }
  }
  return [...releasable].sort();
}

/**
 * True when a single diff entry is structurally valid generated release
 * output. Acceptable entries:
 *   - a deleted non-generated `.changeset/*.md` file (pending changeset
 *     consumed by `changeset version`)
 *   - `apps/cli/CHANGELOG.md`, `apps/cli/package.json`, or
 *     `package-lock.json` added or modified by the release PR
 *
 * Any source path, unexpected path, or rename/copy disables the exemption.
 *
 * @param {DiffEntry} entry
 * @returns {boolean}
 */
function isGeneratedReleaseEntry(entry) {
  if (isRenameOrCopy(entry)) return false;
  const status = normalizeStatus(entry.status);
  const path = toPosixPath(entry.to);
  if (status === "D") {
    return isChangesetMarkdown(path);
  }
  if (status === "A" || status === "M") {
    return (
      path === "apps/cli/CHANGELOG.md" ||
      path === "apps/cli/package.json" ||
      path === "package-lock.json"
    );
  }
  return false;
}

/**
 * True only when the head ref is exactly `changeset-release/main`, the head
 * and base repositories are identical (so a fork reusing the branch name
 * cannot claim the exemption), and every diff entry is structurally valid
 * generated output. A branch-name prefix alone never grants the exemption;
 * an unexpected path or a cross-repository (fork) PR disables it.
 *
 * Repository identity (`headRepository === baseRepository`) is supplied by the
 * caller from trusted GitHub event data. When both are empty (e.g. a local
 * invocation without repository context) they are treated as equal so local
 * release-PR testing continues to work; CI always supplies real values, so a
 * fork is denied there.
 *
 * @param {DiffEntry[]} entries
 * @param {string} headRef
 * @param {string} [headRepository]
 * @param {string} [baseRepository]
 * @returns {boolean}
 */
export function isExemptReleasePr(
  entries,
  headRef,
  headRepository,
  baseRepository,
) {
  if (headRef !== "changeset-release/main") return false;
  const headRepo = headRepository ?? "";
  const baseRepo = baseRepository ?? "";
  if (headRepo !== baseRepo) return false;
  if (entries.length === 0) return false;
  return entries.every(isGeneratedReleaseEntry);
}

/**
 * Parse a single changeset's Markdown content using `@changesets/parse`.
 * Returns `{ ok, releases, reason }`. Malformed content (missing or invalid
 * frontmatter, invalid YAML, invalid release type) is reported as not
 * satisfying the policy rather than thrown.
 *
 * @param {string} content
 * @returns {{ ok: boolean, releases: Array<{name: string, type: string}>, reason?: string }}
 */
function tryParseChangeset(content) {
  try {
    const parsed = parse(content);
    return { ok: true, releases: parsed.releases ?? [] };
  } catch (error) {
    return {
      ok: false,
      releases: [],
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Evaluate whether a set of changeset files satisfies the policy.
 *
 * A changeset satisfies the policy when at least one of the supplied files
 * — each a non-generated `.changeset/*.md` added or modified by the PR and
 * still present at head — has an `@abijith-suresh/outpost: patch` release
 * entry. Malformed, wrong-package, minor, and major entries do not satisfy
 * the policy.
 *
 * @param {Array<{ path: string, content: string }>} changesetFiles
 * @returns {{ ok: boolean, reason?: string }}
 */
export function changesetSatisfies(changesetFiles) {
  if (changesetFiles.length === 0) {
    return {
      ok: false,
      reason: "no changeset was added or modified by this PR",
    };
  }

  const failureReasons = [];
  for (const file of changesetFiles) {
    if (!isChangesetMarkdown(file.path)) continue;
    const parsed = tryParseChangeset(file.content);
    if (!parsed.ok) {
      failureReasons.push(`${file.path}: ${parsed.reason}`);
      continue;
    }
    const match = parsed.releases.find(
      (release) =>
        release.name === RELEASE_PACKAGE &&
        release.type === REQUIRED_RELEASE_TYPE,
    );
    if (match) {
      return { ok: true };
    }
    const releaseSummary = parsed.releases
      .map((release) => `${release.name}: ${release.type}`)
      .join(", ");
    failureReasons.push(
      `${file.path}: expected ${RELEASE_PACKAGE}: ${REQUIRED_RELEASE_TYPE}, found ${releaseSummary || "no releases"}`,
    );
  }

  return {
    ok: false,
    reason: `no valid patch changeset for ${RELEASE_PACKAGE}. ${failureReasons.join("; ")}`,
  };
}

/**
 * @typedef {Object} PolicyInput
 * @property {DiffEntry[]} diffEntries
 * @property {Array<{ path: string, content: string }>} changesetFiles
 *   Non-generated `.changeset/*.md` files added or modified by the PR and
 *   still existing at head, each with its content read at head.
 * @property {string} headRef Head ref name (may be empty for push events).
 * @property {string} [headRepository] Full name of the head repository
 *   (e.g. `owner/repo`); checked against `baseRepository` for the release-PR
 *   exemption so a fork reusing the `changeset-release/main` branch name
 *   cannot claim it.
 * @property {string} [baseRepository] Full name of the base repository.
 */

/**
 * @typedef {Object} PolicyResult
 * @property {boolean} ok
 * @property {boolean} changesetRequired
 * @property {boolean} releasePrExemption
 * @property {string[]} releasablePaths
 * @property {string} [reason]
 */

/**
 * Classify a pull request against the changeset policy.
 *
 * Order of evaluation:
 *   1. A generated release PR (head ref `changeset-release/main` whose diff
 *      is entirely generated output) is always allowed.
 *   2. Otherwise, when no releasable path changed, no changeset is required.
 *   3. When a releasable path changed, a satisfying changeset is required.
 *
 * @param {PolicyInput} input
 * @returns {PolicyResult}
 */
export function classifyChangesetPolicy(input) {
  const entries = input.diffEntries ?? [];
  const headRef = input.headRef ?? "";
  const headRepository = input.headRepository;
  const baseRepository = input.baseRepository;

  if (isExemptReleasePr(entries, headRef, headRepository, baseRepository)) {
    return {
      ok: true,
      changesetRequired: false,
      releasePrExemption: true,
      releasablePaths: [],
    };
  }

  const releasablePaths = releasablePathsFromEntries(entries);
  if (releasablePaths.length === 0) {
    return {
      ok: true,
      changesetRequired: false,
      releasePrExemption: false,
      releasablePaths,
    };
  }

  const satisfaction = changesetSatisfies(input.changesetFiles ?? []);
  if (satisfaction.ok) {
    return {
      ok: true,
      changesetRequired: true,
      releasePrExemption: false,
      releasablePaths,
    };
  }

  return {
    ok: false,
    changesetRequired: true,
    releasePrExemption: false,
    releasablePaths,
    reason: satisfaction.reason,
  };
}
