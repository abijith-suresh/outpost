// Git + CLI adapter for the changeset policy.
//
// This script is the only place that invokes Git. It gathers the pull
// request diff and the contents of every changeset added or modified by the
// PR, hands the structured inputs to the pure classifier in
// `changeset-policy.mjs`, then prints an actionable result and exits with a
// non-zero status when the policy is violated.
//
// Invoke locally:
//
//   node scripts/check-changeset.mjs --base <base-sha> --head <head-sha> --head-ref <ref>
//
// In CI, `npm run changeset:check -- --base ... --head ... --head-ref ...`
// passes through extra arguments after the fixed script name.

import { execFileSync } from "node:child_process";
import process from "node:process";

import {
  classifyChangesetPolicy,
  isChangesetMarkdown,
  toPosixPath,
} from "./changeset-policy.mjs";

const RELEASE_PACKAGE = "@abijith-suresh/outpost";

/**
 * Parse command-line arguments of the form `--key value`.
 *
 * @param {string[]} argv
 * @returns {Record<string, string>}
 */
function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index];
    if (!entry.startsWith("--")) continue;
    const key = entry.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for argument --${key}`);
    }
    args[key] = value;
    index += 1;
  }
  return args;
}

/**
 * Run Git with an argument array and return its stdout as a Buffer. Git is
 * never invoked through an interpolated shell string.
 *
 * @param {string[]} gitArgs
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @returns {Buffer}
 */
function runGit(gitArgs, options = {}) {
  return execFileSync("git", gitArgs, {
    cwd: options.cwd ?? process.cwd(),
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * Run Git and return stdout decoded as UTF-8 text.
 *
 * @param {string[]} gitArgs
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @returns {string}
 */
function runGitText(gitArgs, options = {}) {
  return runGit(gitArgs, options).toString("utf8");
}

/**
 * Parse the NUL-delimited output of `git diff --name-status -z
 * --find-renames`.
 *
 * Each record is a status token followed by one path (for add/modify/delete)
 * or two paths (for rename/copy, where the similarity score has already been
 * stripped to a single letter by `git diff` when `-z` is used... actually
 * `git diff` emits the score like `R100`; the first character determines the
 * arity).
 *
 * @param {Buffer} stdout
 * @returns {Array<{ status: string, from: string, to: string }>}
 */
function parseNameStatusZ(stdout) {
  const tokens = stdout
    .toString("utf8")
    .split("\0")
    .filter((token) => token !== "");
  const entries = [];
  let index = 0;
  while (index < tokens.length) {
    const status = tokens[index];
    index += 1;
    const first = status === "" ? "" : status[0];
    if (first === "R" || first === "C") {
      const from = tokens[index];
      const to = tokens[index + 1];
      index += 2;
      entries.push({ status, from, to });
    } else {
      const path = tokens[index];
      index += 1;
      entries.push({ status, from: path, to: path });
    }
  }
  return entries;
}

/**
 * Collect the pull-request diff between a base and head commit.
 *
 * Uses `git diff --name-status -z --find-renames` so renames surface both
 * the old and new path. The merge-base is computed first so the comparison
 * matches what GitHub reports for `base...head`.
 *
 * @param {string} base
 * @param {string} head
 * @returns {Array<{ status: string, from: string, to: string }>}
 */
function collectDiffEntries(base, head) {
  const mergeBase = runGitText(["merge-base", base, head]).trim();
  const stdout = runGit([
    "diff",
    "--name-status",
    "-z",
    "--find-renames",
    `${mergeBase}`,
    `${head}`,
  ]);
  return parseNameStatusZ(stdout);
}

/**
 * Whether a path still exists at the head revision (without checking out the
 * working tree).
 *
 * @param {string} head
 * @param {string} path
 * @returns {boolean}
 */
function existsAtHead(head, path) {
  try {
    runGit(["cat-file", "-e", `${head}:${path}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a file's content at the head revision.
 *
 * @param {string} head
 * @param {string} path
 * @returns {string}
 */
function readAtHead(head, path) {
  return runGitText(["show", `${head}:${path}`]);
}

/**
 * Collect non-generated `.changeset/*.md` files added or modified by the PR
 * that still exist at head, each paired with its content read at head.
 *
 * Deleted changesets, `.changeset/README.md`, and changesets already pending
 * on `base` (unchanged by the PR) are excluded.
 *
 * @param {Array<{ status: string, from: string, to: string }>} diffEntries
 * @param {string} head
 * @returns {Array<{ path: string, content: string }>}
 */
function collectChangesetFiles(diffEntries, head) {
  const files = [];
  for (const entry of diffEntries) {
    const status = entry.status === "" ? "" : entry.status[0];
    if (status !== "A" && status !== "M") continue;
    const path = toPosixPath(entry.to);
    if (!isChangesetMarkdown(path)) continue;
    if (!existsAtHead(head, path)) continue;
    files.push({ path, content: readAtHead(head, path) });
  }
  return files;
}

/**
 * Format the human-readable failure message shown to contributors.
 *
 * @param {{ releasablePaths: string[], reason?: string }} result
 * @returns {string}
 */
function formatFailure(result) {
  const lines = [];
  lines.push(
    "Changeset policy: releasable CLI paths changed without a valid patch changeset.",
  );
  lines.push("");
  lines.push("Releasable paths changed:");
  for (const path of result.releasablePaths) {
    lines.push(`  - ${path}`);
  }
  lines.push("");
  if (result.reason) {
    lines.push(`Reason: ${result.reason}`);
    lines.push("");
  }
  lines.push(`Add a patch changeset for ${RELEASE_PACKAGE} by running:`);
  lines.push("");
  lines.push("  npm run changeset");
  lines.push("");
  lines.push(
    "While Outpost is pre-v1, all changesets use the patch bump level.",
  );
  return lines.join("\n");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const { base, head, "head-ref": headRef = "" } = args;
  if (!base) throw new Error("Missing required --base argument");
  if (!head) throw new Error("Missing required --head argument");

  const diffEntries = collectDiffEntries(base, head);
  const changesetFiles = collectChangesetFiles(diffEntries, head);
  const result = classifyChangesetPolicy({
    diffEntries,
    changesetFiles,
    headRef,
  });

  if (result.ok) {
    if (result.releasePrExemption) {
      process.stdout.write(
        "Changeset policy: generated release PR exemption applied.\n",
      );
    } else if (result.changesetRequired) {
      process.stdout.write(
        "Changeset policy: a valid patch changeset is present.\n",
      );
    } else {
      process.stdout.write(
        "Changeset policy: no releasable CLI paths changed.\n",
      );
    }
    process.exit(0);
  }

  process.stderr.write(`${formatFailure(result)}\n`);
  process.exit(1);
}

main();
