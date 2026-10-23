import { execFileSync } from "node:child_process";
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
  '.\\" Generated from the command registry; run npm run docs:generate.\n.TH OUTPOST 1\n.SH NAME\noutpost \\- manage local multi-repository Git workspaces\n.SH SYNOPSIS\n.B outpost\ncommand [options]\n.SH DESCRIPTION\nOutpost is operated by coding agents and developers. Workspace creation uses local state and never implicitly fetches.\n.SH COMMANDS\n';
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
  "## Exit and recovery contract\n\nSuccess uses stdout and exit 0. Partial fetch/removal uses stdout, `ok: false`, `data` and exit 1. Errors without results use stderr and exit 1, with `code`, `reason`, `retryable` and `action`. See [recovery](recovery.md) before retrying.\n";
man +=
  ".SH GLOBAL OPTIONS\n\\-\\-json opts into JSON. Help and version remain text. Duplicate global options fail before help/version short circuits.\n.SH SAFETY\nRemoval refuses dirty worktrees and unproven ownership. Dry runs acquire no locks and perform no mutations; execution rechecks state. Local branches are preserved. Modified or foreign generated AGENTS.md requires explicit consent. Crash records require manual inspection, never automatic recovery.\n.SH EXIT STATUS\n0 means success. 1 means an error on stderr, or a partial result on stdout. Inspect structured results before retrying.\n.SH ENVIRONMENT\nOUTPOST_HOME selects the state home, default ~/.outpost. OUTPOST_GIT_TIMEOUT_MS sets the Git timeout in milliseconds.\n.SH OFFLINE GUIDANCE\nUse outpost docs, outpost docs recovery, outpost skill show, or outpost skill path \\-\\-json.\n";
artifacts.set("skills/outpost/references/commands.md", reference);
artifacts.set("man/outpost.1", man);
artifacts.set(
  "schemas/index.json",
  JSON.stringify({ contractVersion: CONTRACT_VERSION, schemas }, null, 2) + "\n"
);
let failed = false;
for (const [relative, raw] of artifacts) {
  const file = join(root, relative);
  const content = relative.endsWith(".json")
    ? execFileSync(process.execPath, [biome, "format", `--stdin-file-path=${file}`], {
        input: raw,
        encoding: "utf8",
      })
    : raw;
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
