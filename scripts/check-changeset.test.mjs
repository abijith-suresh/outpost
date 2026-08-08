// Integration tests for the Git/CLI adapter in `check-changeset.mjs`.
//
// These tests build throwaway Git repositories under the OS temp directory,
// make commits, and invoke the adapter as a child process with explicit
// --base/--head/--head-ref/--head-repo/--base-repo arguments. They cover the
// pieces the pure-classifier tests cannot: argument handling, merge-base
// selection, NUL-delimited rename parsing, and reading changeset content from
// the head revision.
//
// Run locally with: npm run test:policy

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ADAPTER = fileURLToPath(new URL("./check-changeset.mjs", import.meta.url));
const REPO = "abijith-suresh/outpost";

/** @param {string} repo */
function git(repo) {
  return (/** @type {string[]} */ args) => {
    const result = spawnSync("git", args, {
      cwd: repo,
      encoding: "utf8",
    });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed in ${repo}: ${result.stderr || result.stdout}`);
    }
    return result.stdout.trim();
  };
}

/** @param {string} repo */
/**
 * Build a fresh throwaway repo and return helpers plus its path. Each test
 * owns its own repo and must call `cleanup()` in a `finally` block.
 */
function useRepo() {
  const root = mkdtempSync(join(tmpdir(), "outpost-policy-it-"));
  mkdirSync(join(root, "apps/cli/src"), { recursive: true });
  mkdirSync(join(root, ".changeset"), { recursive: true });
  const run = git(root);
  run(["init", "-q"]);
  run(["config", "user.email", "policy@example.com"]);
  run(["config", "user.name", "Policy IT"]);
  return {
    root,
    run,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * @param {string} cwd
 * @param {string[]} [extraArgs]
 */
function runAdapter(cwd, extraArgs = []) {
  return spawnSync(process.execPath, [ADAPTER, ...extraArgs], {
    cwd,
    encoding: "utf8",
  });
}

/**
 * Write a file under the repo, creating parent directories as needed.
 *
 * @param {string} repo
 * @param {string} rel
 * @param {string} content
 */
function writeFile(repo, rel, content) {
  const path = join(repo, rel);
  mkdirSync(join(path.slice(0, path.lastIndexOf("/"))), { recursive: true });
  writeFileSync(path, content);
}

test("missing --base and --head exit non-zero with an error", () => {
  const { root, cleanup } = useRepo();
  try {
    const result = runAdapter(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Missing required --base argument/);

    const resultBase = runAdapter(root, ["--base", "HEAD"]);
    assert.notEqual(resultBase.status, 0);
    assert.match(resultBase.stderr, /Missing required --head argument/);
  } finally {
    cleanup();
  }
});

test("source change without a changeset fails with actionable guidance", () => {
  const { root, run, cleanup } = useRepo();
  try {
    writeFile(root, "README.md", "init\n");
    run(["add", "-A"]);
    run(["commit", "-qm", "init"]);
    writeFile(root, "apps/cli/src/program.ts", "b\n");
    run(["add", "-A"]);
    run(["commit", "-qm", "change src"]);

    const result = runAdapter(root, ["--base", "HEAD~1", "--head", "HEAD", "--head-ref", "feat/x"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Releasable paths changed:/);
    assert.match(result.stderr, /apps\/cli\/src\/program\.ts/);
    assert.match(result.stderr, /npm run changeset/);
  } finally {
    cleanup();
  }
});

test("source change with a valid patch changeset passes", { timeout: 5000 }, async () => {
  const { root, run, cleanup } = useRepo();
  try {
    writeFile(root, "README.md", "init\n");
    run(["add", "-A"]);
    run(["commit", "-qm", "init"]);
    writeFile(root, "apps/cli/src/program.ts", "b\n");
    writeFileSync(
      join(root, ".changeset/fix.md"),
      `---\n"@abijith-suresh/outpost": patch\n---\nfix bug\n`
    );
    run(["add", "-A"]);
    run(["commit", "-qm", "src + changeset"]);

    const result = runAdapter(root, ["--base", "HEAD~1", "--head", "HEAD", "--head-ref", "feat/x"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /a valid patch changeset is present/);
  } finally {
    cleanup();
  }
});

test("changeset content is read from the head revision, not the working tree", () => {
  const { root, run, cleanup } = useRepo();
  try {
    writeFile(root, "README.md", "init\n");
    run(["add", "-A"]);
    run(["commit", "-qm", "init"]);
    writeFile(root, "apps/cli/src/program.ts", "b\n");
    writeFileSync(
      join(root, ".changeset/fix.md"),
      `---\n"@abijith-suresh/outpost": patch\n---\nfix bug\n`
    );
    run(["add", "-A"]);
    run(["commit", "-qm", "src + changeset"]);
    const head = run(["rev-parse", "HEAD"]);

    // Mutate the working tree after commit so a path-based read would diverge.
    writeFileSync(
      join(root, ".changeset/fix.md"),
      `---\n"@abijith-suresh/outpost": minor\n---\nspoofed\n`
    );

    const result = runAdapter(root, ["--base", "HEAD~1", "--head", head, "--head-ref", "feat/x"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /a valid patch changeset is present/);
  } finally {
    cleanup();
  }
});

test("merge-base selection excludes base-only releasable paths", () => {
  const { root, run, cleanup } = useRepo();
  try {
    writeFile(root, "README.md", "init\n");
    run(["add", "-A"]);
    run(["commit", "-qm", "init"]);
    const base = run(["rev-parse", "HEAD"]);

    // The base branch advances with a releasable change that is not in head.
    run(["checkout", "-q", "-b", "basebranch"]);
    writeFile(root, "apps/cli/src/base-only.ts", "base\n");
    run(["add", "-A"]);
    run(["commit", "-qm", "source on base"]);
    const baseSha = run(["rev-parse", "HEAD"]);

    // The head branch advances from the merge base with an exempt change.
    run(["checkout", "-q", base]);
    run(["checkout", "-q", "-b", "headbranch"]);
    writeFile(root, "docs/head-only.md", "notes\n");
    run(["add", "-A"]);
    run(["commit", "-qm", "docs on head"]);

    // A naive base..head diff reports base-only.ts as deleted and fails policy.
    // merge-base..head sees only the exempt head change and passes.
    const result = runAdapter(root, ["--base", baseSha, "--head", "HEAD", "--head-ref", "feat/x"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /no releasable CLI paths changed/);
  } finally {
    cleanup();
  }
});

test("valid pending changeset modified relative to base satisfies policy", () => {
  const { root, run, cleanup } = useRepo();
  try {
    writeFile(root, "apps/cli/src/program.ts", "a\n");
    writeFileSync(
      join(root, ".changeset/fix.md"),
      `---\n"@abijith-suresh/outpost": patch\n---\ninitial summary\n`
    );
    run(["add", "-A"]);
    run(["commit", "-qm", "init"]);

    writeFile(root, "apps/cli/src/program.ts", "b\n");
    writeFileSync(
      join(root, ".changeset/fix.md"),
      `---\n"@abijith-suresh/outpost": patch\n---\nupdated summary\n`
    );
    run(["add", "-A"]);
    run(["commit", "-qm", "src + modified changeset"]);

    const result = runAdapter(root, ["--base", "HEAD~1", "--head", "HEAD", "--head-ref", "fix/x"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /a valid patch changeset is present/);
  } finally {
    cleanup();
  }
});

test("unchanged valid pending changeset does not satisfy policy", () => {
  const { root, run, cleanup } = useRepo();
  try {
    writeFile(root, "apps/cli/src/program.ts", "a\n");
    writeFileSync(
      join(root, ".changeset/fix.md"),
      `---\n"@abijith-suresh/outpost": patch\n---\nfix bug\n`
    );
    run(["add", "-A"]);
    run(["commit", "-qm", "init"]);

    writeFile(root, "apps/cli/src/program.ts", "b\n");
    run(["add", "-A"]);
    run(["commit", "-qm", "src change"]);

    const result = runAdapter(root, ["--base", "HEAD~1", "--head", "HEAD", "--head-ref", "fix/x"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no changeset was added or modified by this PR/);
  } finally {
    cleanup();
  }
});

test("deleted valid pending changeset does not satisfy policy", () => {
  const { root, run, cleanup } = useRepo();
  try {
    writeFile(root, "apps/cli/src/program.ts", "a\n");
    writeFileSync(
      join(root, ".changeset/fix.md"),
      `---\n"@abijith-suresh/outpost": patch\n---\nfix bug\n`
    );
    run(["add", "-A"]);
    run(["commit", "-qm", "init"]);

    writeFile(root, "apps/cli/src/program.ts", "b\n");
    run(["rm", "-q", ".changeset/fix.md"]);
    run(["add", "-A"]);
    run(["commit", "-qm", "src + deleted changeset"]);

    const result = runAdapter(root, ["--base", "HEAD~1", "--head", "HEAD", "--head-ref", "fix/x"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no changeset was added or modified by this PR/);
  } finally {
    cleanup();
  }
});

test("rename from non-releasable to releasable path requires a changeset", () => {
  const { root, run, cleanup } = useRepo();
  try {
    mkdirSync(join(root, "apps/cli/docs"), { recursive: true });
    writeFile(root, "apps/cli/docs/notes.md", "notes\n");
    writeFile(root, "README.md", "init\n");
    run(["add", "-A"]);
    run(["commit", "-qm", "init"]);

    // Move docs into src as a TypeScript file (a rename).
    run(["mv", "apps/cli/docs/notes.md", "apps/cli/src/program.ts"]);
    run(["add", "-A"]);
    run(["commit", "-qm", "rename into src"]);

    const result = runAdapter(root, [
      "--base",
      "HEAD~1",
      "--head",
      "HEAD",
      "--head-ref",
      "refactor/move",
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /apps\/cli\/src\/program\.ts/);
  } finally {
    cleanup();
  }
});

test("rename entirely outside releasable paths is exempt", () => {
  const { root, run, cleanup } = useRepo();
  try {
    writeFile(root, "docs/old.md", "a\n");
    writeFile(root, "README.md", "init\n");
    run(["add", "-A"]);
    run(["commit", "-qm", "init"]);
    run(["mv", "docs/old.md", "docs/new.md"]);
    run(["add", "-A"]);
    run(["commit", "-qm", "rename docs"]);

    const result = runAdapter(root, [
      "--base",
      "HEAD~1",
      "--head",
      "HEAD",
      "--head-ref",
      "docs/rename",
    ]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /no releasable CLI paths changed/);
  } finally {
    cleanup();
  }
});

test("docs-only change does not require a changeset", () => {
  const { root, run, cleanup } = useRepo();
  try {
    writeFile(root, "README.md", "init\n");
    run(["add", "-A"]);
    run(["commit", "-qm", "init"]);
    writeFile(root, "docs/CONTRIBUTING.md", "guide\n");
    run(["add", "-A"]);
    run(["commit", "-qm", "docs"]);

    const result = runAdapter(root, [
      "--base",
      "HEAD~1",
      "--head",
      "HEAD",
      "--head-ref",
      "docs/guide",
    ]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /no releasable CLI paths changed/);
  } finally {
    cleanup();
  }
});

test("generated release PR from the same repository is exempt", () => {
  const { root, run, cleanup } = useRepo();
  try {
    writeFile(root, "README.md", "init\n");
    mkdirSync(join(root, "apps/cli"), { recursive: true });
    writeFile(root, "apps/cli/CHANGELOG.md", "# Changelog\n");
    writeFile(root, "apps/cli/package.json", `{"version":"0.0.25"}\n`);
    writeFile(root, "package-lock.json", "{}\n");
    writeFileSync(
      join(root, ".changeset/old.md"),
      `---\n"@abijith-suresh/outpost": patch\n---\nold\n`
    );
    run(["add", "-A"]);
    run(["commit", "-qm", "init"]);

    // Release version commit: deletes the pending changeset, bumps artifacts.
    run(["rm", "-q", ".changeset/old.md"]);
    writeFile(root, "apps/cli/CHANGELOG.md", "# Changelog\n\n## 0.0.26\n");
    writeFile(root, "apps/cli/package.json", `{"version":"0.0.26"}\n`);
    writeFile(root, "package-lock.json", "{}2\n");
    run(["add", "-A"]);
    run(["commit", "-qm", "release"]);

    const result = runAdapter(root, [
      "--base",
      "HEAD~1",
      "--head",
      "HEAD",
      "--head-ref",
      "changeset-release/main",
      "--head-repo",
      REPO,
      "--base-repo",
      REPO,
    ]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /generated release PR exemption applied/);
  } finally {
    cleanup();
  }
});

test("generated release PR from a fork repository is not exempt", () => {
  const { root, run, cleanup } = useRepo();
  try {
    writeFile(root, "README.md", "init\n");
    mkdirSync(join(root, "apps/cli"), { recursive: true });
    writeFile(root, "apps/cli/CHANGELOG.md", "# Changelog\n");
    writeFile(root, "apps/cli/package.json", `{"version":"0.0.25"}\n`);
    writeFile(root, "package-lock.json", "{}\n");
    writeFileSync(
      join(root, ".changeset/old.md"),
      `---\n"@abijith-suresh/outpost": patch\n---\nold\n`
    );
    run(["add", "-A"]);
    run(["commit", "-qm", "init"]);

    run(["rm", "-q", ".changeset/old.md"]);
    writeFile(root, "apps/cli/CHANGELOG.md", "# Changelog\n\n## 0.0.26\n");
    writeFile(root, "apps/cli/package.json", `{"version":"0.0.26"}\n`);
    writeFile(root, "package-lock.json", "{}2\n");
    run(["add", "-A"]);
    run(["commit", "-qm", "release"]);

    const result = runAdapter(root, [
      "--base",
      "HEAD~1",
      "--head",
      "HEAD",
      "--head-ref",
      "changeset-release/main",
      "--head-repo",
      "attacker/outpost",
      "--base-repo",
      REPO,
    ]);
    // Fork denies the exemption; package.json is releasable, so it fails.
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout, /exemption/);
    assert.match(result.stderr, /apps\/cli\/package\.json/);
  } finally {
    cleanup();
  }
});

test("spoofed branch name is not exempt even from the same repository", () => {
  const { root, run, cleanup } = useRepo();
  try {
    writeFile(root, "README.md", "init\n");
    mkdirSync(join(root, "apps/cli"), { recursive: true });
    writeFile(root, "apps/cli/CHANGELOG.md", "# Changelog\n");
    writeFile(root, "apps/cli/package.json", `{"version":"0.0.25"}\n`);
    run(["add", "-A"]);
    run(["commit", "-qm", "init"]);
    writeFile(root, "apps/cli/CHANGELOG.md", "# Changelog\n\n## 0.0.26\n");
    writeFile(root, "apps/cli/package.json", `{"version":"0.0.26"}\n`);
    run(["add", "-A"]);
    run(["commit", "-qm", "bump"]);

    const result = runAdapter(root, [
      "--base",
      "HEAD~1",
      "--head",
      "HEAD",
      "--head-ref",
      "changeset-release/feature",
      "--head-repo",
      REPO,
      "--base-repo",
      REPO,
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /apps\/cli\/package\.json/);
  } finally {
    cleanup();
  }
});
