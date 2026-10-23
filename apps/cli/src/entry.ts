import { commandTokens, resolveEarlyOutput } from "./early-output.js";

/** Only process-boundary output happens here; state and discovery workflows still use Effect. */
export async function runEarly(
  argv: readonly string[],
  version: string
): Promise<number | undefined> {
  const early = resolveEarlyOutput(argv, version);
  if (early) {
    // Match Console's process boundary and preserve programmatic console capture.
    console[early.stream](early.text);
    return early.exitCode;
  }
  const positional = commandTokens(argv);
  if (positional[0] === "describe") {
    const { runDiscovery } = await import("./discovery-runtime.js");
    return runDiscovery(positional.slice(1), version, argv.includes("--json"));
  }
  return undefined;
}
