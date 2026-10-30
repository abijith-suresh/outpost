import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ALL_COMMANDS, CONTRACT_VERSION, formatCommandDetail } from "../dist/command-spec.js";
import { describeCommand } from "../dist/machine-contract.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const check = process.argv.includes("--check");
const require = createRequire(import.meta.url);
const biome = require.resolve("@biomejs/biome/bin/biome");
const artifacts = new Map();
const slug = (spec) => spec.path.join("-");
const roff = (text) =>
  text
    .replaceAll("\\", "\\e")
    .replaceAll("-", "\\-")
    .split("\n")
    .map((line) => (/^[.']/.test(line) ? `\\&${line}` : line))
    .join("\n");
let reference =
  "# Command reference\n\nGenerated from the command registry. Edit the registry, then run `npm run docs:generate`.\n\nInput schemas describe normalized `{ arguments, options }`; named values are arrays.\nHelp and version remain text. All other listed commands support opt-in `--json`.\n\n";
let man =
  '.\\" Generated from the command registry; run npm run docs:generate.\n.TH OUTPOST 1\n.SH NAME\noutpost \\- manage local multi-repository Git workspaces\n.SH SYNOPSIS\n.B outpost\ncommand [options]\n.SH DESCRIPTION\nOutpost is operated by coding agents and developers. Workspace creation defaults to cached remote refs. Only explicit fresh-remote base selection fetches; dry runs never fetch.\n.SH COMMANDS\n';
const schemas = [];
for (const spec of ALL_COMMANDS) {
  const detail = describeCommand(spec);
  reference += `## ${spec.path.join(" ")}\n\n\`\`\`text\n${formatCommandDetail(spec)}\n\`\`\`\n\nNetwork: ${detail.network}. Retry: ${detail.retry}.\nSide effects: ${detail.sideEffects.join(", ") || "none"}.\n\n`;
  man += `.SS ${roff(spec.path.join(" "))}\n.nf\n${roff(formatCommandDetail(spec))}\n.fi\nNetwork: ${detail.network}. Retry: ${detail.retry}.\n`;
  for (const kind of ["input", "output"]) {
    const schema = detail[`${kind}Schema`];
    if (!schema) continue;
    const name = `${slug(spec)}.${kind}.json`;
    artifacts.set(
      `schemas/${name}`,
      JSON.stringify(
        { $schema: "https://json-schema.org/draft/2020-12/schema", ...schema },
        null,
        2
      ) + "\n"
    );
    schemas.push({ command: spec.path.join(" "), kind, path: name });
  }
}
reference +=
  "## Exit and recovery contract\n\nSuccess uses stdout and exit 0. Partial fetch/removal and partial/not-ready resume use stdout, `ok: false`, `data` and exit 1. Errors without results use stderr and exit 1, with `code`, `reason`, `retryable` and `action`. See [recovery](recovery.md) before retrying.\n";
man +=
  ".SH GLOBAL OPTIONS\n\\-\\-json opts into JSON. Help and version remain text. Duplicate global options fail before help/version short circuits.\n.SH SAFETY\nRemoval refuses dirty worktrees and unproven ownership. Dry runs acquire no locks and perform no mutations; execution rechecks state. New workspaces record requested base source/ref and actual immutable starting commits. Fresh selection must fetch successfully; cached/local modes never fetch or silently fall back. Fresh previews report that fetching is required. Resume inspects one frozen workspace without fetching, optional Git writes, new base selection, ref changes, repair or metadata/guidance replacement. Dirty or advanced owned work is normal; wrong/detached, foreign, unavailable or inconsistent members produce partial/not-ready diagnostics. Missing manifests need doctor/manual recovery. Explicit create --reuse-branch admits an existing direct owned managed branch without fetch, reset or ref updates; it is incompatible with new-base options. Version 4 manifests preserve existing-branch admission provenance. Borrowed branches never become rollback-owned. All members are checked before mutation; absent objects, symbolic branches or existing checkouts fail closed. Workspace removal preserves local branches. Repository removal unregisters while retaining the mirror, all refs and objects. Inspect repo list or repo show with --retained, then explicitly repo restore after ownership validation. Restore never fetches or adopts arbitrary directories. No storage purge is provided; network operations require explicit authorization. Modified or foreign generated AGENTS.md requires explicit consent. Crash records require manual inspection, never automatic recovery. Borrowed new workspaces require explicit local full-ref-or-SHA bases and freeze external common/owned checkout identity in manifest v5. Explicit borrowed create, resume/status and normal remove trust configured clean/smudge/process/LFS tools, which may have side effects or network access. Local means no implicit Outpost Git fetch, not a sandbox. Metadata-only registration/listing stays offline. Hooks/fsmonitor and lazy fetch remain disabled. Failed/cancelled borrowed admission retains branches/reflogs and uncertain checkout/admin for doctor/manual recovery, never destructive retry. Named borrowed cached selection requires --remote NAME and --base branch/full-heads-ref, reads only refs/remotes/NAME/BRANCH and available objects without transport/helper, and writes frozen named provenance in manifest v6. Custom mappings/defaults/fallbacks are not inferred; cache is unverified, not fresh. Local borrowed v5 and managed formats remain unchanged.\n.SH EXIT STATUS\n0 means success. 1 means an error on stderr, or a partial result on stdout. Inspect structured results before retrying.\n.SH ENVIRONMENT\nOUTPOST_HOME selects the state home, default ~/.outpost. OUTPOST_GIT_TIMEOUT_MS sets the Git timeout in milliseconds.\n.SH OFFLINE GUIDANCE\nUse outpost docs, outpost docs recovery, outpost skill show, or outpost skill path \\-\\-json.\n";
artifacts.set("skills/outpost/references/commands.md", reference);
artifacts.set("man/outpost.1", man);
artifacts.set(
  "schemas/index.json",
  JSON.stringify({ contractVersion: CONTRACT_VERSION, schemas }, null, 2) + "\n"
);
// Hash the exact formatted bytes that ship; the compiled map binds each command
// to the generator's intended schema without runtime schema compilation.
const formatArtifact = (relative, raw) =>
  relative.endsWith(".json") || relative.endsWith(".ts")
    ? execFileSync(
        process.execPath,
        [biome, "format", `--stdin-file-path=${join(root, relative)}`],
        { input: raw, encoding: "utf8" }
      )
    : raw;
const formatted = new Map(
  [...artifacts].map(([relative, raw]) => [relative, formatArtifact(relative, raw)])
);
const digests = Object.fromEntries(
  [...formatted]
    .filter(([relative]) => relative.startsWith("schemas/") && relative.endsWith(".output.json"))
    .map(([relative, content]) => [
      relative.slice("schemas/".length),
      createHash("sha256").update(content).digest("hex"),
    ])
);
const integrityPath = "src/schema-integrity.ts";
formatted.set(
  integrityPath,
  formatArtifact(
    integrityPath,
    "// Generated by scripts/generate-docs.mjs. Do not edit.\n" +
      "// Detects changed/stale individual assets relative to compiled package code; not package authenticity.\n" +
      `export const SCHEMA_ASSET_SHA256: Readonly<Record<string, string>> = ${JSON.stringify(digests, null, 2)};\n`
  )
);
let failed = false;
for (const [relative, content] of formatted) {
  const file = join(root, relative);
  if (check) {
    if (!existsSync(file) || readFileSync(file, "utf8") !== content) {
      process.stderr.write(`Generated artifact drift: ${relative}\n`);
      failed = true;
    }
  } else {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}
// Stale schema files can otherwise silently describe commands no longer registered.
for (const file of existsSync(join(root, "schemas")) ? readdirSync(join(root, "schemas")) : []) {
  if (!artifacts.has(`schemas/${file}`)) {
    process.stderr.write(`Unexpected schema artifact: schemas/${file}\n`);
    failed = true;
  }
}
if (failed) {
  process.stderr.write("Run npm run docs:generate and remove obsolete artifacts.\n");
  process.exitCode = 1;
}
