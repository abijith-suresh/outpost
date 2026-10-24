import process from "node:process";
import { Console, Effect, Schema } from "effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import {
  findCommand,
  findCommandPrefix,
  formatCommandDetail,
  formatHelpText,
  parseCommandInput,
  requireCommand,
} from "./command-spec.js";
import { runCreate } from "./commands/create.js";
import { runDescribe } from "./commands/describe.js";
import { runDoctor } from "./commands/doctor.js";
import { runDocs, runSkillExport, runSkillPath, runSkillShow } from "./commands/guidance.js";
import { runInit } from "./commands/init.js";
import { runRepoAdd } from "./commands/repo-add.js";
import { runRepoFetch } from "./commands/repo-fetch.js";
import { runRepoList } from "./commands/repo-list.js";
import { runRepoRemove } from "./commands/repo-remove.js";
import { runRepoShow } from "./commands/repo-show.js";
import { runWorkspaceList } from "./commands/workspace-list.js";
import { runWorkspaceRemove } from "./commands/workspace-remove.js";
import { runWorkspaceShow } from "./commands/workspace-show.js";
import { domainDetails, ErrorDetailFields, reasonDetails } from "./error-details.js";
import { jsonErrorEnvelope, printCommandOutput } from "./renderer.js";
import { DiagnosticSchema, DiagnosticTruncationSchema } from "./result-schemas.js";
import type {
  CliErrorCode,
  CliErrorDiagnostic,
  CommandOutput,
  JsonErrorEnvelope,
} from "./types.js";
import { CLI_ERROR_CODES } from "./types.js";

const cliVersionSchema = Schema.Struct({
  argv: Schema.Array(Schema.String),
  version: Schema.String,
});

export class CliError extends Schema.TaggedError<CliError>()("CliError", {
  ...ErrorDetailFields,
  message: Schema.String,
  code: Schema.Literals(CLI_ERROR_CODES),
  diagnostics: Schema.optional(Schema.Array(DiagnosticSchema)),
  diagnosticTruncation: Schema.optional(DiagnosticTruncationSchema),
}) {}

function cliError(
  code: CliErrorCode,
  message: string,
  diagnostics?: ReadonlyArray<CliErrorDiagnostic>,
  source?: unknown
): CliError {
  return new CliError({
    message,
    code,
    ...domainDetails(
      source,
      code === "INVALID_ARGUMENT" || code === "UNKNOWN_COMMAND"
        ? "invalid-arguments"
        : "invalid-state"
    ),
    ...(typeof source === "object" && source !== null && "diagnosticTruncation" in source
      ? {
          diagnosticTruncation:
            source.diagnosticTruncation as import("./types.js").DiagnosticTruncation,
        }
      : {}),
    ...(diagnostics && diagnostics.length > 0 ? { diagnostics } : {}),
  });
}

function printHelp(version: string): string {
  return formatHelpText(version);
}

function commandHelp(commandPath: ReadonlyArray<string>): string | undefined {
  const spec = findCommand(commandPath);
  return spec ? formatCommandDetail(spec) : undefined;
}

function printUnknownCommand(command: string, asJson: boolean): Effect.Effect<number> {
  if (asJson) {
    return Console.error(
      jsonErrorEnvelope(null, {
        ...reasonDetails("invalid-arguments"),
        code: "UNKNOWN_COMMAND",
        message: `Unknown command: ${command}`,
      })
    ).pipe(Effect.as(1));
  }
  return Effect.all([
    Console.error(`Unknown command: ${command}`),
    Console.error("Run `outpost --help` to see available commands."),
  ]).pipe(Effect.as(1));
}

function printError(
  command: string | null,
  error: JsonErrorEnvelope["error"],
  asJson: boolean
): Effect.Effect<number> {
  if (asJson) {
    return Console.error(
      jsonErrorEnvelope(command, {
        ...domainDetails(error),
        ...(error.diagnosticTruncation ? { diagnosticTruncation: error.diagnosticTruncation } : {}),
        code: error.code,
        message: error.message,
        ...(error.diagnostics === undefined ? {} : { diagnostics: error.diagnostics }),
      })
    ).pipe(Effect.as(1));
  }
  return Console.error(error.message).pipe(Effect.as(1));
}

function validateGlobalOptions(args: ReadonlyArray<string>): Effect.Effect<void, CliError> {
  const duplicateOption = ["--json", "--help", "--version"].find(
    (option) => args.filter((arg) => arg === option).length > 1
  );

  if (duplicateOption) {
    return Effect.fail(
      new CliError({
        ...reasonDetails("invalid-arguments"),
        code: "INVALID_ARGUMENT",
        message: `Usage: outpost <command> [options]\n${duplicateOption} may only be provided once.`,
      })
    );
  }

  return Effect.void;
}

type KnownCommand = Exclude<ReturnType<typeof resolveCommandIdentity>, null>;

function resolveCommandIdentity(args: ReadonlyArray<string>): string | null {
  const positionalArgs = args.filter(
    (arg) => arg !== "--json" && arg !== "--help" && arg !== "--version"
  );
  return findCommandPrefix(positionalArgs)?.path.join(" ") ?? null;
}

function resolveCommand(
  command: KnownCommand,
  rawArgs: ReadonlyArray<string>,
  options: { interactive: boolean; version: string }
): Effect.Effect<
  CommandOutput,
  CliError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  let positionalArgs = rawArgs;
  const spec = findCommand(command.split(" "));
  const legacyCodes: Record<string, CliErrorCode> = {
    create: "CREATE_FAILED",
    "repo fetch": "REPO_FETCH_FAILED",
    "repo show": "REPO_SHOW_FAILED",
    "repo remove": "REPO_REMOVE_FAILED",
    "workspace show": "WORKSPACE_SHOW_FAILED",
    "workspace remove": "WORKSPACE_REMOVE_FAILED",
  };
  if (spec) {
    try {
      const parsed = parseCommandInput(
        spec,
        positionalArgs.slice(spec.path.length),
        options.interactive
      );
      positionalArgs = [
        ...spec.path,
        ...(spec.arguments ?? []).flatMap((argument) => parsed.arguments[argument.name]),
        ...Object.entries(parsed.options).flatMap(([name, values]) =>
          Array.isArray(values) ? values.flatMap((value) => [name, value]) : [name]
        ),
      ];
    } catch (error) {
      let usage = formatCommandDetail(spec).split("\n\n")[0].replace("Usage:\n  ", "Usage: ");
      if (command === "repo add" || command === "create") usage = usage.replace(" [--json]", "");
      // Existing no-argument commands keep their concise usage-only error.
      const message = `${usage}${command !== "create" && command !== "repo add" ? "" : `\n${error instanceof Error ? error.message : String(error)}`}`;
      return Effect.fail(
        cliError(
          legacyCodes[command] ?? "INVALID_ARGUMENT",
          message,
          undefined,
          reasonDetails("invalid-arguments")
        )
      );
    }
  }
  switch (command) {
    case "help":
      return Effect.fail(cliError("INVALID_ARGUMENT", "Usage: outpost help"));
    case "describe":
      return runDescribe(positionalArgs.slice(1), options.version).pipe(
        Effect.mapError((error) => cliError("INVALID_ARGUMENT", error.message, undefined, error))
      );
    case "docs":
      return runDocs(positionalArgs[1]).pipe(
        Effect.mapError((error) => cliError("GUIDANCE_FAILED", error.message, undefined, error))
      );
    case "skill show":
      return runSkillShow().pipe(
        Effect.mapError((error) => cliError("GUIDANCE_FAILED", error.message, undefined, error))
      );
    case "skill path":
      return runSkillPath();
    case "skill export":
      return runSkillExport(positionalArgs[2]).pipe(
        Effect.mapError((error) => cliError("GUIDANCE_FAILED", error.message, undefined, error))
      );
    case "doctor":
      if (positionalArgs.length > 1) {
        return Effect.fail(cliError("INVALID_ARGUMENT", "Usage: outpost doctor [--json]"));
      }
      return runDoctor();
    case "create":
      return runCreate(positionalArgs.slice(1), {
        interactive: options.interactive,
      }).pipe(
        Effect.mapError((error) => cliError("CREATE_FAILED", error.message, undefined, error))
      );
    case "init":
      if (positionalArgs.length > 1) {
        return Effect.fail(cliError("INVALID_ARGUMENT", "Usage: outpost init [--json]"));
      }
      return runInit().pipe(
        Effect.mapError((error) => cliError("INIT_FAILED", error.message, undefined, error))
      );
    case "repo add":
      return Effect.sync(() => {
        const parsed = parseCommandInput(requireCommand(["repo", "add"]), positionalArgs.slice(2));
        const remote = parsed.options["--remote"];
        return {
          inputPath: parsed.arguments.path[0],
          remoteName: Array.isArray(remote) ? remote[0] : undefined,
        };
      }).pipe(
        Effect.flatMap(({ inputPath, remoteName }) =>
          runRepoAdd(inputPath, { remoteName }).pipe(
            Effect.mapError((error) =>
              cliError("REPO_ADD_FAILED", error.message, error.diagnostics, error)
            )
          )
        )
      );
    case "repo list":
      if (positionalArgs.length > 2) {
        return Effect.fail(cliError("INVALID_ARGUMENT", "Usage: outpost repo list [--json]"));
      }
      return runRepoList().pipe(
        Effect.mapError((error) => cliError("REPO_LIST_FAILED", error.message, undefined, error))
      );
    case "repo fetch":
      return runRepoFetch(positionalArgs.slice(2)).pipe(
        Effect.mapError((error) => cliError("REPO_FETCH_FAILED", error.message, undefined, error))
      );
    case "repo show":
      return runRepoShow(positionalArgs[2], positionalArgs.slice(3)).pipe(
        Effect.mapError((error) => cliError("REPO_SHOW_FAILED", error.message, undefined, error))
      );
    case "repo remove":
      return runRepoRemove(positionalArgs[2], positionalArgs.slice(3)).pipe(
        Effect.mapError((error) => cliError("REPO_REMOVE_FAILED", error.message, undefined, error))
      );
    case "workspace show":
      return runWorkspaceShow(positionalArgs[2], positionalArgs.slice(3)).pipe(
        Effect.mapError((error) =>
          cliError("WORKSPACE_SHOW_FAILED", error.message, undefined, error)
        )
      );
    case "workspace remove":
      return runWorkspaceRemove(positionalArgs[2], positionalArgs.slice(3), {
        interactive: options.interactive,
      }).pipe(
        Effect.mapError((error) =>
          cliError("WORKSPACE_REMOVE_FAILED", error.message, undefined, error)
        )
      );
    case "workspace list":
      if (positionalArgs.length > 2) {
        return Effect.fail(cliError("INVALID_ARGUMENT", "Usage: outpost workspace list [--json]"));
      }
      return runWorkspaceList().pipe(
        Effect.mapError((error) =>
          cliError("WORKSPACE_LIST_FAILED", error.message, undefined, error)
        )
      );
  }

  return Effect.fail(cliError("UNKNOWN_COMMAND", `Unknown command: ${positionalArgs.join(" ")}`));
}

export function run(
  argv: readonly string[],
  version: string
): Effect.Effect<
  number,
  never,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  const program = Effect.gen(function* () {
    const input = yield* Schema.decodeUnknownEffect(cliVersionSchema)({
      argv: [...argv],
      version,
    }).pipe(
      Effect.mapError((error) => cliError("INVALID_ARGUMENT", error.message, undefined, error))
    );

    yield* validateGlobalOptions(input.argv);

    const wantsHelp = input.argv.includes("--help");
    const asJson = input.argv.includes("--json");
    const interactive = !asJson && process.stdin.isTTY === true && process.stdout.isTTY === true;
    const positionalArgs = input.argv.filter(
      (arg) => arg !== "--json" && arg !== "--version" && arg !== "--help"
    );

    if (wantsHelp) {
      const helpTarget = positionalArgs[0] === "help" ? positionalArgs.slice(1) : positionalArgs;
      const helpText = helpTarget.length > 0 ? commandHelp(helpTarget) : undefined;

      yield* Console.log(helpText ?? printHelp(input.version));
      return 0;
    }

    if (input.argv.includes("--version")) {
      yield* Console.log(input.version);
      return 0;
    }

    if (positionalArgs.length === 0) {
      yield* Console.log(printHelp(input.version));
      return 0;
    }

    if (positionalArgs[0] === "help") {
      const helpTarget = positionalArgs.slice(1);

      if (helpTarget.length > 0) {
        const helpText = commandHelp(helpTarget);

        if (helpText) {
          yield* Console.log(helpText);
          return 0;
        }

        return yield* printError(
          "help",
          {
            ...reasonDetails("invalid-arguments"),
            code: "INVALID_ARGUMENT",
            message: `Unknown command: ${helpTarget.join(" ")}`,
          },
          asJson
        );
      }

      yield* Console.log(printHelp(input.version));
      return 0;
    }

    const command = resolveCommandIdentity(positionalArgs);
    if (command === null) {
      return yield* printUnknownCommand(positionalArgs.join(" "), asJson);
    }

    const output = yield* resolveCommand(command, positionalArgs, {
      interactive,
      version,
    }).pipe(
      Effect.matchEffect({
        onFailure: (error) => printError(command, error, asJson),
        onSuccess: (commandOutput) =>
          printCommandOutput(commandOutput, asJson).pipe(Effect.as(commandOutput.exitCode ?? 0)),
      })
    );

    return output;
  });

  return program.pipe(
    Effect.catchTag("CliError", (error) => {
      const asJson = argv.includes("--json");
      return printError(resolveCommandIdentity(argv), error, asJson);
    })
  );
}
