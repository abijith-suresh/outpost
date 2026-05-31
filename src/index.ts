#!/usr/bin/env node

import { createRequire } from "node:module";
import process from "node:process";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

type CommandOutput = {
  command: string;
  data: Record<string, unknown>;
};

type DemoItem = {
  id: string;
  title: string;
  status: "ready" | "planned";
};

const demoItems: readonly DemoItem[] = [
  { id: "workspace-bootstrap", title: "Workspace bootstrap", status: "ready" },
  { id: "repo-registry", title: "Repository registry", status: "planned" },
];

function printHelp(): void {
  console.log(`outpost ${version}

Usage:
  outpost <command> [options]

Commands:
  help                 Show this help output
  doctor [--json]      Report local CLI environment status
  demo list [--json]   Show placeholder command output structure

Global options:
  --help               Show help output
  --version            Show CLI version
  --json               Use JSON output for supported commands`);
}

function printJson(output: CommandOutput): void {
  console.log(JSON.stringify(output, null, 2));
}

function runDoctor(asJson: boolean): number {
  const doctor = {
    node: process.version,
    platform: process.platform,
    cwd: process.cwd(),
    packageVersion: version,
    status: "ok",
  };

  if (asJson) {
    printJson({ command: "doctor", data: doctor });
    return 0;
  }

  console.log("outpost doctor");
  console.log(`status: ${doctor.status}`);
  console.log(`node: ${doctor.node}`);
  console.log(`platform: ${doctor.platform}`);
  console.log(`cwd: ${doctor.cwd}`);
  return 0;
}

function runDemoList(asJson: boolean): number {
  if (asJson) {
    printJson({
      command: "demo list",
      data: { items: demoItems },
    });
    return 0;
  }

  console.log("outpost demo list");
  for (const item of demoItems) {
    console.log(`- ${item.id}: ${item.title} [${item.status}]`);
  }

  return 0;
}

function printUnknownCommand(command: string): number {
  console.error(`Unknown command: ${command}`);
  console.error("Run `outpost --help` to see available commands.");
  return 1;
}

export function run(argv: readonly string[]): number {
  const args = [...argv];
  const asJson = args.includes("--json");
  const positionalArgs = args.filter((arg) => arg !== "--json");

  if (
    positionalArgs.length === 0 ||
    positionalArgs[0] === "help" ||
    (positionalArgs.length === 1 && positionalArgs[0] === "--help")
  ) {
    printHelp();
    return 0;
  }

  if (positionalArgs.length === 1 && positionalArgs[0] === "--version") {
    console.log(version);
    return 0;
  }

  if (positionalArgs[0] === "doctor") {
    return runDoctor(asJson);
  }

  if (positionalArgs[0] === "demo" && positionalArgs[1] === "list") {
    return runDemoList(asJson);
  }

  return printUnknownCommand(positionalArgs.join(" "));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = run(process.argv.slice(2));
}
