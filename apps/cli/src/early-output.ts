import {
  findCommand,
  findCommandPrefix,
  formatCommandDetail,
  formatHelpText,
} from "./command-spec.js";
import { reasonDetails } from "./error-reasons.js";

export type EarlyOutput = { stream: "log" | "error"; text: string; exitCode: 0 | 1 };
export function commandTokens(argv: readonly string[]): string[] {
  return argv.filter((arg) => arg !== "--json" && arg !== "--help" && arg !== "--version");
}

/** Pure process prelude shared by the executable, import-safe API and Effect program. */
export function resolveEarlyOutput(
  argv: readonly string[],
  version: string
): EarlyOutput | undefined {
  const positional = commandTokens(argv);
  const duplicate = ["--json", "--help", "--version"].find(
    (option) => argv.filter((arg) => arg === option).length > 1
  );
  if (duplicate) {
    const message = `Usage: outpost <command> [options]\n${duplicate} may only be provided once.`;
    return {
      stream: "error",
      exitCode: 1,
      text: argv.includes("--json")
        ? JSON.stringify(
            {
              ok: false,
              command: findCommandPrefix(positional)?.path.join(" ") ?? null,
              error: { ...reasonDetails("invalid-arguments"), code: "INVALID_ARGUMENT", message },
              exitCode: 1,
            },
            null,
            2
          )
        : message,
    };
  }
  const help = (target: readonly string[]) => {
    const spec = findCommand(target);
    return spec ? formatCommandDetail(spec) : undefined;
  };
  if (argv.includes("--help")) {
    const target = positional[0] === "help" ? positional.slice(1) : positional;
    return { stream: "log", text: help(target) ?? formatHelpText(version), exitCode: 0 };
  }
  if (argv.includes("--version")) return { stream: "log", text: version, exitCode: 0 };
  if (positional.length === 0 || (positional[0] === "help" && positional.length === 1)) {
    return { stream: "log", text: formatHelpText(version), exitCode: 0 };
  }
  if (positional[0] === "help") {
    const text = help(positional.slice(1));
    if (text) return { stream: "log", text, exitCode: 0 };
    const message = `Unknown command: ${positional.slice(1).join(" ")}`;
    return {
      stream: "error",
      exitCode: 1,
      text: argv.includes("--json")
        ? JSON.stringify(
            {
              ok: false,
              command: "help",
              error: { ...reasonDetails("invalid-arguments"), code: "INVALID_ARGUMENT", message },
              exitCode: 1,
            },
            null,
            2
          )
        : message,
    };
  }
  return undefined;
}
