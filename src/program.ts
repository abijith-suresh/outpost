import * as FileSystem from "@effect/platform/FileSystem";
import type * as CommandExecutor from "@effect/platform/CommandExecutor";
import * as Path from "@effect/platform/Path";
import { Console, Effect, Schema } from "effect";

import { runDoctor } from "./commands/doctor.js";
import { runInit } from "./commands/init.js";
import { runRepoAdd } from "./commands/repo-add.js";
import { runRepoList } from "./commands/repo-list.js";
import { runRepoShow } from "./commands/repo-show.js";
import type { CommandOutput } from "./types.js";

const cliVersionSchema = Schema.Struct({
  argv: Schema.Array(Schema.String),
  version: Schema.String,
});

export class CliError extends Schema.TaggedError<CliError>()("CliError", {
  message: Schema.String,
}) {}

const demoItems = [
  { id: "workspace-bootstrap", title: "Workspace bootstrap", status: "ready" },
  { id: "effect-foundation", title: "Effect foundation", status: "ready" },
] as const;

function printHelp(version: string): string {
  return `outpost ${version}

Usage:
  outpost <command> [options]

Commands:
  help                 Show this help output
  doctor [--json]      Report local CLI environment status
  init [--json]        Initialize Outpost home and worktrees roots
  repo add <path> [--remote <name>]
                       Validate a local repository for Outpost registration
  repo list [--json]   List imported repositories
  repo show <id>       Show one imported repository by id
  demo list [--json]   Show placeholder command output structure

Global options:
  --help               Show help output
  --version            Show CLI version
  --json               Use JSON output for supported commands`;
}

function printJson(output: CommandOutput): Effect.Effect<void> {
  return Console.log(JSON.stringify(output, null, 2));
}

function printCommandOutput(
  output: CommandOutput,
  asJson: boolean,
): Effect.Effect<void> {
  if (asJson) {
    return printJson(output);
  }

  switch (output.command) {
    case "doctor":
      return Effect.all([
        Console.log("outpost doctor"),
        Console.log(`status: ${String(output.data.status)}`),
        Console.log(
          `resolved outpost home: ${String(output.data.outpostHome)}`,
        ),
        Console.log(`initialized: ${String(output.data.initialized)}`),
        Console.log(`missing repos: ${String(output.data.missingRepoCount)}`),
        ...(output.data.initialized === true
          ? [
              Console.log(
                `config file path: ${String(output.data.configFilePath)}`,
              ),
              Console.log(
                `repo registry file path: ${String(output.data.repoRegistryFilePath)}`,
              ),
              Console.log(`repos root: ${String(output.data.reposRoot)}`),
              Console.log(
                `worktrees root: ${String(output.data.worktreesRoot)}`,
              ),
              Console.log(`repo count: ${String(output.data.repoCount)}`),
              ...(Array.isArray(output.data.missingRepos)
                ? output.data.missingRepos.map((missingRepoPath) =>
                    Console.log(
                      `missing managed repo: ${String(missingRepoPath)}`,
                    ),
                  )
                : []),
            ]
          : []),
        Console.log(`node: ${String(output.data.node)}`),
        Console.log(`platform: ${String(output.data.platform)}`),
        Console.log(`cwd: ${String(output.data.cwd)}`),
      ]).pipe(Effect.asVoid);
    case "init":
      return Effect.all([
        Console.log("outpost init"),
        Console.log(`outpost home: ${String(output.data.outpostHome)}`),
        Console.log(`repos root: ${String(output.data.reposRoot)}`),
        Console.log(`worktrees root: ${String(output.data.worktreesRoot)}`),
      ]).pipe(Effect.asVoid);
    case "demo list":
      return Effect.all([
        Console.log("outpost demo list"),
        ...demoItems.map((item) =>
          Console.log(`- ${item.id}: ${item.title} [${item.status}]`),
        ),
      ]).pipe(Effect.asVoid);
    case "repo add":
      return Effect.all([
        Console.log("outpost repo add"),
        Console.log(`source repo path: ${String(output.data.sourceRepoPath)}`),
        Console.log(`remote name: ${String(output.data.remoteName)}`),
        Console.log(`remote url: ${String(output.data.remoteUrl)}`),
        Console.log(`repo name: ${String(output.data.repoName)}`),
        Console.log(`managed repo path: ${String(output.data.repoPath)}`),
        Console.log(`action: ${String(output.data.action)}`),
        Console.log(`registry action: ${String(output.data.registryAction)}`),
        Console.log(`ready: ${String(output.data.ready)}`),
        ...(Array.isArray(output.data.blockers) &&
        output.data.blockers.length > 0
          ? output.data.blockers.map((blocker) =>
              Console.log(`blocker: ${String(blocker)}`),
            )
          : []),
      ]).pipe(Effect.asVoid);
    case "repo list":
      return Effect.all([
        Console.log("outpost repo list"),
        Console.log(
          `repos: ${Array.isArray(output.data.repos) ? output.data.repos.length : 0}`,
        ),
        Console.log(
          `missing repos: ${typeof output.data.missingRepoCount === "number" ? output.data.missingRepoCount : 0}`,
        ),
        ...(Array.isArray(output.data.repos)
          ? output.data.repos.map((repo) => {
              const name =
                typeof repo === "object" && repo !== null && "name" in repo
                  ? String(repo.name)
                  : "";
              const id =
                typeof repo === "object" && repo !== null && "id" in repo
                  ? String(repo.id)
                  : "";
              const status =
                typeof repo === "object" && repo !== null && "status" in repo
                  ? String(repo.status)
                  : "";
              const managedRepoPath =
                typeof repo === "object" &&
                repo !== null &&
                "managedRepoPath" in repo
                  ? String(repo.managedRepoPath)
                  : "";

              return Console.log(
                `- ${name} (id: ${id}) [${status}]: ${managedRepoPath}`,
              );
            })
          : []),
      ]).pipe(Effect.asVoid);
    case "repo show":
      return Effect.all([
        Console.log("outpost repo show"),
        Console.log(`id: ${String(output.data.id)}`),
        Console.log(`name: ${String(output.data.name)}`),
        Console.log(`status: ${String(output.data.status)}`),
        Console.log(
          `managed repo path: ${String(output.data.managedRepoPath)}`,
        ),
        Console.log(`source repo path: ${String(output.data.sourceRepoPath)}`),
        Console.log(`remote name: ${String(output.data.remoteName)}`),
        Console.log(`remote url: ${String(output.data.remoteUrl)}`),
        Console.log(`imported at: ${String(output.data.importedAt)}`),
        Console.log(`last fetched at: ${String(output.data.lastFetchedAt)}`),
      ]).pipe(Effect.asVoid);
    default:
      return Console.log(JSON.stringify(output));
  }
}

function printUnknownCommand(command: string): Effect.Effect<number> {
  return Effect.all([
    Console.error(`Unknown command: ${command}`),
    Console.error("Run `outpost --help` to see available commands."),
  ]).pipe(Effect.as(1));
}

function printError(message: string): Effect.Effect<number> {
  return Console.error(message).pipe(Effect.as(1));
}

function isKnownCommand(positionalArgs: ReadonlyArray<string>): boolean {
  return (
    positionalArgs[0] === "doctor" ||
    positionalArgs[0] === "init" ||
    (positionalArgs[0] === "repo" &&
      ["add", "list", "show"].includes(positionalArgs[1] ?? "")) ||
    (positionalArgs[0] === "demo" && positionalArgs[1] === "list")
  );
}

function runDemoList(): Effect.Effect<CommandOutput> {
  return Effect.succeed({
    command: "demo list",
    data: {
      items: demoItems,
    },
  });
}

function resolveRepoAddArgs(
  args: ReadonlyArray<string>,
): Effect.Effect<{ inputPath: string; remoteName?: string }, CliError> {
  if (args.length === 0) {
    return Effect.fail(
      new CliError({
        message: "Usage: outpost repo add <path> [--remote <name>]",
      }),
    );
  }

  const inputPath = args[0];

  if (!inputPath) {
    return Effect.fail(
      new CliError({
        message: "Usage: outpost repo add <path> [--remote <name>]",
      }),
    );
  }

  let remoteName: string | undefined;
  let index = 1;

  while (index < args.length) {
    const arg = args[index];

    if (arg !== "--remote") {
      return Effect.fail(
        new CliError({
          message: "Usage: outpost repo add <path> [--remote <name>]",
        }),
      );
    }

    if (remoteName) {
      return Effect.fail(
        new CliError({
          message:
            "Usage: outpost repo add <path> [--remote <name>]\n--remote may only be provided once.",
        }),
      );
    }

    const value = args[index + 1];

    if (!value || value.startsWith("--")) {
      return Effect.fail(
        new CliError({
          message:
            "Usage: outpost repo add <path> [--remote <name>]\n--remote requires a value.",
        }),
      );
    }

    remoteName = value;
    index += 2;
  }

  return Effect.succeed({ inputPath, remoteName });
}

function resolveCommand(
  positionalArgs: ReadonlyArray<string>,
): Effect.Effect<
  CommandOutput,
  CliError,
  FileSystem.FileSystem | Path.Path | CommandExecutor.CommandExecutor
> {
  if (positionalArgs[0] === "doctor") {
    return runDoctor();
  }

  if (positionalArgs[0] === "init") {
    return runInit().pipe(
      Effect.mapError((error) => new CliError({ message: error.message })),
    );
  }

  if (positionalArgs[0] === "repo" && positionalArgs[1] === "add") {
    return resolveRepoAddArgs(positionalArgs.slice(2)).pipe(
      Effect.flatMap(({ inputPath, remoteName }) =>
        runRepoAdd(inputPath, { remoteName }),
      ),
      Effect.mapError((error) => new CliError({ message: error.message })),
    );
  }

  if (positionalArgs[0] === "repo" && positionalArgs[1] === "list") {
    return runRepoList().pipe(
      Effect.mapError((error) => new CliError({ message: error.message })),
    );
  }

  if (positionalArgs[0] === "repo" && positionalArgs[1] === "show") {
    return runRepoShow(positionalArgs[2], positionalArgs.slice(3)).pipe(
      Effect.mapError((error) => new CliError({ message: error.message })),
    );
  }

  if (positionalArgs[0] === "demo" && positionalArgs[1] === "list") {
    return runDemoList();
  }

  return Effect.fail(new CliError({ message: positionalArgs.join(" ") }));
}

export function run(
  argv: readonly string[],
  version: string,
): Effect.Effect<
  number,
  never,
  FileSystem.FileSystem | Path.Path | CommandExecutor.CommandExecutor
> {
  const program = Effect.gen(function* () {
    const input = yield* Schema.decodeUnknown(cliVersionSchema)({
      argv: [...argv],
      version,
    }).pipe(
      Effect.mapError(
        (error) =>
          new CliError({
            message: error.message,
          }),
      ),
    );

    const asJson = input.argv.includes("--json");
    const positionalArgs = input.argv.filter((arg) => arg !== "--json");

    if (
      positionalArgs.length === 0 ||
      positionalArgs[0] === "help" ||
      (positionalArgs.length === 1 && positionalArgs[0] === "--help")
    ) {
      yield* Console.log(printHelp(input.version));
      return 0;
    }

    if (positionalArgs.length === 1 && positionalArgs[0] === "--version") {
      yield* Console.log(input.version);
      return 0;
    }

    const output = yield* resolveCommand(positionalArgs).pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          isKnownCommand(positionalArgs)
            ? printError(error.message)
            : printUnknownCommand(error.message),
        onSuccess: (commandOutput) =>
          printCommandOutput(commandOutput, asJson).pipe(Effect.as(0)),
      }),
    );

    return output;
  });

  return program.pipe(
    Effect.catchTag("CliError", (error) => printError(error.message)),
  );
}
