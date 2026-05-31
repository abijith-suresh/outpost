#!/usr/bin/env node

export function run(argv: readonly string[]): number {
  if (argv.includes("--version")) {
    console.log("0.0.1");
    return 0;
  }

  console.log("outpost: CLI foundation is ready.");
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = run(process.argv.slice(2));
}
