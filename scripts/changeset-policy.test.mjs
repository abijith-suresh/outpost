// Coverage for the pure changeset-policy classifier using `node:test`.
// Run locally with: npm run test:policy

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  changesetSatisfies,
  classifyChangesetPolicy,
  isChangesetMarkdown,
  isExemptReleasePr,
  isReleasablePath,
  releasablePathsFromEntries,
  toPosixPath,
} from "./changeset-policy.mjs";

const PKG = "@abijith-suresh/outpost";

/**
 * @param {string} status
 * @param {string} path
 */
function entry(status, path) {
  return { status, from: path, to: path };
}

/**
 * @param {string} from
 * @param {string} to
 */
function renameEntry(from, to) {
  return { status: "R100", from, to };
}

/** @param {string} summary */
function patchChangeset(summary = "fix something") {
  return `---\n"${PKG}": patch\n---\n${summary}`;
}

/**
 * @param {string} frontmatter
 * @param {string} [summary]
 */
function rawChangeset(frontmatter, summary = "note") {
  return `---\n${frontmatter}\n---\n${summary}`;
}

test("isReleasablePath matches CLI source and package behavior", () => {
  assert.equal(isReleasablePath("apps/cli/src/program.ts"), true);
  assert.equal(isReleasablePath("apps/cli/src/sub/x.ts"), true);
  assert.equal(isReleasablePath("apps/cli/scripts/build.mjs"), true);
  assert.equal(isReleasablePath("apps/cli/package.json"), true);
  assert.equal(isReleasablePath("apps/cli/tsconfig.json"), true);
  assert.equal(isReleasablePath("apps/cli/tests/store.test.ts"), false);
  assert.equal(isReleasablePath("apps/cli/dist/index.js"), false);
  assert.equal(isReleasablePath("apps/website/src/index.astro"), false);
  assert.equal(isReleasablePath("docs/CONTRIBUTING.md"), false);
  assert.equal(isReleasablePath("package.json"), false);
  assert.equal(isReleasablePath(".github/workflows/ci.yml"), false);
});

test("isChangesetMarkdown mirrors @changesets/read discovery", () => {
  assert.equal(isChangesetMarkdown(".changeset/quiet-tickets-stand.md"), true);
  assert.equal(isChangesetMarkdown(".changeset/fix.md"), true);
  assert.equal(isChangesetMarkdown(".changeset/README.md"), false);
  assert.equal(isChangesetMarkdown(".changeset/readme.md"), false);
  assert.equal(isChangesetMarkdown(".changeset/Readme.MD"), false);
  assert.equal(isChangesetMarkdown(".changeset/config.json"), false);
  assert.equal(isChangesetMarkdown(".changeset/.fake.md"), false);
  assert.equal(isChangesetMarkdown(".changeset/nested/fake.md"), false);
  assert.equal(isChangesetMarkdown(".changeset//fake.md"), false);
  assert.equal(isChangesetMarkdown(".changeset/a/b/c.md"), false);
  assert.equal(isChangesetMarkdown("apps/cli/src/foo.ts"), false);
  assert.equal(isChangesetMarkdown(".changeset"), false);
});

test("toPosixPath normalizes backslashes", () => {
  assert.equal(toPosixPath("apps\\cli\\src\\foo.ts"), "apps/cli/src/foo.ts");
});

test("source-required: CLI source without a changeset fails", () => {
  const result = classifyChangesetPolicy({
    diffEntries: [entry("M", "apps/cli/src/program.ts")],
    changesetFiles: [],
    headRef: "feat/add-thing",
  });
  assert.equal(result.ok, false);
  assert.equal(result.changesetRequired, true);
  assert.equal(result.releasePrExemption, false);
  assert.deepEqual(result.releasablePaths, ["apps/cli/src/program.ts"]);
});

test("valid patch: CLI source with a patch changeset passes", () => {
  const result = classifyChangesetPolicy({
    diffEntries: [entry("M", "apps/cli/src/program.ts"), entry("A", ".changeset/fix-thing.md")],
    changesetFiles: [{ path: ".changeset/fix-thing.md", content: patchChangeset() }],
    headRef: "feat/add-thing",
  });
  assert.equal(result.ok, true);
  assert.equal(result.changesetRequired, true);
});

test("valid patch across apps/cli/package.json and tsconfig.json", () => {
  const result = classifyChangesetPolicy({
    diffEntries: [
      entry("M", "apps/cli/package.json"),
      entry("M", "apps/cli/tsconfig.json"),
      entry("A", ".changeset/bump-deps.md"),
    ],
    changesetFiles: [{ path: ".changeset/bump-deps.md", content: patchChangeset("bump deps") }],
    headRef: "chore/deps",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.releasablePaths, ["apps/cli/package.json", "apps/cli/tsconfig.json"]);
});

test("unchanged pending changeset on main does not satisfy policy", () => {
  const result = classifyChangesetPolicy({
    diffEntries: [entry("M", "apps/cli/src/program.ts")],
    changesetFiles: [],
    headRef: "feat/add-thing",
  });
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /no changeset was added or modified/);
});

test("deleted changeset does not satisfy policy", () => {
  const result = classifyChangesetPolicy({
    diffEntries: [entry("M", "apps/cli/src/program.ts"), entry("D", ".changeset/old-note.md")],
    changesetFiles: [],
    headRef: "feat/add-thing",
  });
  assert.equal(result.ok, false);
  assert.equal(result.changesetRequired, true);
});

test("malformed changeset does not satisfy policy", () => {
  const result = classifyChangesetPolicy({
    diffEntries: [entry("M", "apps/cli/src/program.ts"), entry("A", ".changeset/bad.md")],
    changesetFiles: [{ path: ".changeset/bad.md", content: "this is not a changeset" }],
    headRef: "feat/add-thing",
  });
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /no valid patch changeset/);
  assert.match(result.reason ?? "", /bad\.md/);
});

test("wrong package does not satisfy policy", () => {
  const result = classifyChangesetPolicy({
    diffEntries: [entry("M", "apps/cli/src/program.ts"), entry("A", ".changeset/wrong-pkg.md")],
    changesetFiles: [
      {
        path: ".changeset/wrong-pkg.md",
        content: rawChangeset('"some-other-package": patch'),
      },
    ],
    headRef: "feat/add-thing",
  });
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /expected @abijith-suresh\/outpost: patch/);
});

test("patch mixed with the private website package does not satisfy policy", () => {
  const result = changesetSatisfies([
    {
      path: ".changeset/mixed-releases.md",
      content: rawChangeset(`"${PKG}": patch\n"outpost-website": major`),
    },
  ]);

  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /as the only release/);
  assert.match(result.reason ?? "", /outpost-website: major/);
});

test("unknown package entry does not satisfy policy", () => {
  const result = changesetSatisfies([
    {
      path: ".changeset/unknown-package.md",
      content: rawChangeset('"unknown-package": patch'),
    },
  ]);

  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /unknown-package: patch/);
});

test("minor bump does not satisfy policy", () => {
  const result = classifyChangesetPolicy({
    diffEntries: [entry("M", "apps/cli/src/program.ts"), entry("A", ".changeset/minor.md")],
    changesetFiles: [
      {
        path: ".changeset/minor.md",
        content: rawChangeset(`"${PKG}": minor`),
      },
    ],
    headRef: "feat/add-thing",
  });
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /found .*: minor/);
});

test("major bump does not satisfy policy", () => {
  const result = classifyChangesetPolicy({
    diffEntries: [entry("M", "apps/cli/src/program.ts"), entry("A", ".changeset/major.md")],
    changesetFiles: [
      {
        path: ".changeset/major.md",
        content: rawChangeset(`"${PKG}": major`),
      },
    ],
    headRef: "feat/add-thing",
  });
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /found .*: major/);
});

test("website-only changes do not require a changeset", () => {
  const result = classifyChangesetPolicy({
    diffEntries: [
      entry("M", "apps/website/src/pages/index.astro"),
      entry("M", "apps/website/package.json"),
    ],
    changesetFiles: [],
    headRef: "docs/site",
  });
  assert.equal(result.ok, true);
  assert.equal(result.changesetRequired, false);
  assert.deepEqual(result.releasablePaths, []);
});

test("tests-only changes do not require a changeset", () => {
  const result = classifyChangesetPolicy({
    diffEntries: [
      entry("M", "apps/cli/tests/store.test.ts"),
      entry("A", "apps/cli/tests/helpers.ts"),
    ],
    changesetFiles: [],
    headRef: "test/store",
  });
  assert.equal(result.ok, true);
  assert.equal(result.changesetRequired, false);
});

test("docs-only changes do not require a changeset", () => {
  const result = classifyChangesetPolicy({
    diffEntries: [entry("M", "docs/CONTRIBUTING.md"), entry("M", "apps/cli/README.md")],
    changesetFiles: [],
    headRef: "docs/readme",
  });
  assert.equal(result.ok, true);
  assert.equal(result.changesetRequired, false);
});

test("workflow-only changes do not require a changeset", () => {
  const result = classifyChangesetPolicy({
    diffEntries: [entry("M", ".github/workflows/ci.yml")],
    changesetFiles: [],
    headRef: "chore/ci",
  });
  assert.equal(result.ok, true);
  assert.equal(result.changesetRequired, false);
});

test("root tooling-only changes do not require a changeset", () => {
  const result = classifyChangesetPolicy({
    diffEntries: [
      entry("M", "eslint.config.mjs"),
      entry("M", "prettier.config.mjs"),
      entry("M", "package.json"),
    ],
    changesetFiles: [],
    headRef: "chore/tooling",
  });
  assert.equal(result.ok, true);
  assert.equal(result.changesetRequired, false);
});

test("mixed changes with releasable CLI source still require a changeset", () => {
  const result = classifyChangesetPolicy({
    diffEntries: [
      entry("M", "apps/cli/src/program.ts"),
      entry("M", "docs/CONTRIBUTING.md"),
      entry("M", "apps/website/src/index.astro"),
    ],
    changesetFiles: [],
    headRef: "feat/mixed",
  });
  assert.equal(result.ok, false);
  assert.equal(result.changesetRequired, true);
  assert.deepEqual(result.releasablePaths, ["apps/cli/src/program.ts"]);
});

test("releases into apps/cli/scripts require a changeset", () => {
  const result = classifyChangesetPolicy({
    diffEntries: [entry("A", "apps/cli/scripts/pack.mjs")],
    changesetFiles: [],
    headRef: "feat/pack",
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.releasablePaths, ["apps/cli/scripts/pack.mjs"]);
});

test("renames inspect both old and new paths: rename into releasable path", () => {
  const result = classifyChangesetPolicy({
    diffEntries: [renameEntry("apps/cli/src/old.ts", "apps/cli/src/new.ts")],
    changesetFiles: [],
    headRef: "refactor/rename",
  });
  assert.equal(result.ok, false);
  assert.deepEqual(
    [
      ...releasablePathsFromEntries([renameEntry("apps/cli/src/old.ts", "apps/cli/src/new.ts")]),
    ].sort(),
    ["apps/cli/src/new.ts", "apps/cli/src/old.ts"]
  );
});

test("rename from non-releasable to releasable path requires a changeset", () => {
  const result = classifyChangesetPolicy({
    diffEntries: [renameEntry("apps/cli/docs/notes.md", "apps/cli/src/notes.ts")],
    changesetFiles: [],
    headRef: "refactor/move",
  });
  assert.equal(result.ok, false);
  assert.equal(result.changesetRequired, true);
});

test("rename entirely outside releasable paths is exempt", () => {
  const result = classifyChangesetPolicy({
    diffEntries: [renameEntry("docs/old.md", "docs/new.md")],
    changesetFiles: [],
    headRef: "docs/rename",
  });
  assert.equal(result.ok, true);
  assert.equal(result.changesetRequired, false);
});

const REPO = "abijith-suresh/outpost";

test("generated release PR with deleted changesets is exempt", () => {
  const result = classifyChangesetPolicy({
    diffEntries: [
      entry("D", ".changeset/fix-thing.md"),
      entry("D", ".changeset/another.md"),
      entry("M", "apps/cli/CHANGELOG.md"),
      entry("M", "apps/cli/package.json"),
      entry("M", "package-lock.json"),
    ],
    changesetFiles: [],
    headRef: "changeset-release/main",
    headRepository: REPO,
    baseRepository: REPO,
  });
  assert.equal(result.ok, true);
  assert.equal(result.releasePrExemption, true);
  assert.equal(result.changesetRequired, false);
});

test("fork reusing the changeset-release/main branch name is not exempt", () => {
  const diffEntries = [
    entry("D", ".changeset/fix-thing.md"),
    entry("M", "apps/cli/CHANGELOG.md"),
    entry("M", "apps/cli/package.json"),
    entry("M", "package-lock.json"),
  ];
  const result = classifyChangesetPolicy({
    diffEntries,
    changesetFiles: [],
    headRef: "changeset-release/main",
    headRepository: "attacker/outpost",
    baseRepository: REPO,
  });
  assert.equal(result.releasePrExemption, false);
  // After the exemption is denied, the releasable package.json change still
  // requires a changeset that the release PR does not carry.
  assert.equal(result.ok, false);
  assert.equal(result.changesetRequired, true);
  assert.deepEqual(result.releasablePaths, ["apps/cli/package.json"]);
});

test("fork release PR with only non-releasable generated paths is denied exemption but allowed", () => {
  const result = classifyChangesetPolicy({
    diffEntries: [entry("D", ".changeset/fix-thing.md"), entry("M", "apps/cli/CHANGELOG.md")],
    changesetFiles: [],
    headRef: "changeset-release/main",
    headRepository: "attacker/outpost",
    baseRepository: REPO,
  });
  assert.equal(result.releasePrExemption, false);
  // CHANGELOG only is not releasable, so no changeset is required.
  assert.equal(result.ok, true);
  assert.equal(result.changesetRequired, false);
});

test("generated release PR must not include README deletion", () => {
  const result = classifyChangesetPolicy({
    diffEntries: [entry("D", ".changeset/README.md"), entry("M", "apps/cli/CHANGELOG.md")],
    changesetFiles: [],
    headRef: "changeset-release/main",
  });
  // README deletion is unexpected generated output, so the exemption is
  // disabled. Neither path is releasable CLI source, so no changeset is
  // required and the PR is allowed via the ordinary path.
  assert.equal(result.releasePrExemption, false);
  assert.equal(result.ok, true);
  assert.equal(result.changesetRequired, false);
});

test("spoofed release branch name is not exempt and package.json requires a changeset", () => {
  const result = classifyChangesetPolicy({
    diffEntries: [entry("M", "apps/cli/CHANGELOG.md"), entry("M", "apps/cli/package.json")],
    changesetFiles: [],
    headRef: "changeset-release/feature",
  });
  assert.equal(result.releasePrExemption, false);
  assert.equal(result.ok, false);
  assert.equal(result.changesetRequired, true);
  assert.deepEqual(result.releasablePaths, ["apps/cli/package.json"]);
});

test("unexpected source path on a release PR disables the exemption", () => {
  const result = classifyChangesetPolicy({
    diffEntries: [
      entry("D", ".changeset/fix-thing.md"),
      entry("M", "apps/cli/CHANGELOG.md"),
      entry("M", "apps/cli/package.json"),
      entry("M", "package-lock.json"),
      entry("M", "apps/cli/src/program.ts"),
    ],
    changesetFiles: [],
    headRef: "changeset-release/main",
  });
  assert.equal(result.releasePrExemption, false);
  assert.equal(result.ok, false);
  assert.equal(result.changesetRequired, true);
  assert.deepEqual(result.releasablePaths, ["apps/cli/package.json", "apps/cli/src/program.ts"]);
});

test("unexpected non-generated path on a release PR disables the exemption", () => {
  const result = classifyChangesetPolicy({
    diffEntries: [entry("M", "apps/cli/CHANGELOG.md"), entry("A", "docs/notes.md")],
    changesetFiles: [],
    headRef: "changeset-release/main",
  });
  assert.equal(result.releasePrExemption, false);
  assert.equal(result.ok, true); // no releasable CLI source after exemption fails
  assert.equal(result.changesetRequired, false);
});

test("isExemptReleasePr requires the exact head ref and matching repositories", () => {
  const releaseEntries = [entry("D", ".changeset/a.md"), entry("M", "apps/cli/package.json")];
  assert.equal(isExemptReleasePr(releaseEntries, "changeset-release/main", REPO, REPO), true);
  // Default empty repositories are treated as equal for local use.
  assert.equal(isExemptReleasePr(releaseEntries, "changeset-release/main"), true);
  // A fork (mismatched repo identity) is never exempt.
  assert.equal(
    isExemptReleasePr(releaseEntries, "changeset-release/main", "fork/outpost", REPO),
    false
  );
  assert.equal(isExemptReleasePr(releaseEntries, "changeset-release/next", REPO, REPO), false);
  assert.equal(isExemptReleasePr(releaseEntries, "", REPO, REPO), false);
  assert.equal(isExemptReleasePr([], "changeset-release/main", REPO, REPO), false);
});

test("multiple changesets: any valid patch entry satisfies policy", () => {
  const result = classifyChangesetPolicy({
    diffEntries: [
      entry("M", "apps/cli/src/program.ts"),
      entry("A", ".changeset/wrong.md"),
      entry("A", ".changeset/right.md"),
    ],
    changesetFiles: [
      {
        path: ".changeset/wrong.md",
        content: rawChangeset('"other-pkg": patch'),
      },
      { path: ".changeset/right.md", content: patchChangeset("real fix") },
    ],
    headRef: "feat/multi",
  });
  assert.equal(result.ok, true);
  assert.equal(result.changesetRequired, true);
});

test("changeset present but for a non-changeset markdown file is ignored", () => {
  const result = classifyChangesetPolicy({
    diffEntries: [entry("M", "apps/cli/src/program.ts"), entry("A", ".changeset/README.md")],
    changesetFiles: [{ path: ".changeset/README.md", content: patchChangeset() }],
    headRef: "feat/odd",
  });
  assert.equal(result.ok, false);
  assert.equal(result.changesetRequired, true);
});

test("nested changeset path does not satisfy policy even with patch content", () => {
  const result = classifyChangesetPolicy({
    diffEntries: [entry("M", "apps/cli/src/program.ts"), entry("A", ".changeset/nested/fake.md")],
    changesetFiles: [
      {
        path: ".changeset/nested/fake.md",
        content: patchChangeset("bypass"),
      },
    ],
    headRef: "feat/bypass",
  });
  assert.equal(result.ok, false);
  assert.equal(result.changesetRequired, true);
});

test("dotfile changeset path does not satisfy policy", () => {
  const result = classifyChangesetPolicy({
    diffEntries: [entry("M", "apps/cli/src/program.ts"), entry("A", ".changeset/.hidden.md")],
    changesetFiles: [
      {
        path: ".changeset/.hidden.md",
        content: patchChangeset("bypass"),
      },
    ],
    headRef: "feat/bypass",
  });
  assert.equal(result.ok, false);
  assert.equal(result.changesetRequired, true);
});

test("case-variant readme changeset path does not satisfy policy", () => {
  const result = classifyChangesetPolicy({
    diffEntries: [entry("M", "apps/cli/src/program.ts"), entry("A", ".changeset/readme.md")],
    changesetFiles: [
      {
        path: ".changeset/readme.md",
        content: patchChangeset("bypass"),
      },
    ],
    headRef: "feat/bypass",
  });
  assert.equal(result.ok, false);
  assert.equal(result.changesetRequired, true);
});
