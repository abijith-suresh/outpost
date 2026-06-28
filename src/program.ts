import process from "node:process";

import * as FileSystem from "@effect/platform/FileSystem";
import type * as CommandExecutor from "@effect/platform/CommandExecutor";
import * as Path from "@effect/platform/Path";
import { Console, Effect, Schema } from "effect";

import { runCreate } from "./commands/create.js";
import { runDoctor } from "./commands/doctor.js";
import { runInit } from "./commands/init.js";
import { runRepoAdd } from "./commands/repo-add.js";
import { runRepoFetch } from "./commands/repo-fetch.js";
import { runRepoList } from "./commands/repo-list.js";
import { runRepoRemove } from "./commands/repo-remove.js";
import { runRepoShow } from "./commands/repo-show.js";
import { runWorkspaceList } from "./commands/workspace-list.js";
import { runWorkspaceRemove } from "./commands/workspace-remove.js";
import { runWorkspaceShow } from "./commands/workspace-show.js";
import type { CommandOutput } from "./types.js";
import type { JsonSuccessEnvelope, JsonErrorEnvelope } from "./types.js";

const cliVersionSchema = Schema.Struct({
  argv: Schema.Array(Schema.String),
  version: Schema.String,
});

export class CliError extends Schema.TaggedError<CliError>()("CliError", {
  message: Schema.String,
  code: Schema.String,
}) {}

function cliError(message: string): CliError {
  return new CliError({ message, code: errorCodeFromMessage(message) });
}

function errorCodeFromMessage(message: string): string {
  if (message.startsWith("Usage:")) return "USAGE_ERROR";
  if (message.startsWith("Unknown command:")) return "UNKNOWN_COMMAND";
  if (message.includes("not initialized")) return "NOT_INITIALIZED";
  if (message.includes("Unknown repo id")) return "NOT_FOUND";
  if (message.includes("does not exist")) return "NOT_FOUND";
  if (message.includes("Failed to") || message.includes("git "))
    return "GIT_ERROR";
  if (message.includes("Invalid JSON") || message.includes("Config version"))
    return "CONFIG_ERROR";
  if (message.includes("locked by another")) return "LOCK_ERROR";
  if (message.includes("Cannot remove") || message.includes("Cannot delete"))
    return "SAFETY_ERROR";
  if (message.includes("is required")) return "USAGE_ERROR";
  return "INTERNAL_ERROR";
}

function jsonSuccessEnvelope(output: CommandOutput): string {
  const envelope = {
    ok: true,
    command: output.command,
    data: output.data,
    exitCode: 0,
  } satisfies JsonSuccessEnvelope;
  return JSON.stringify(envelope, null, 2);
}

function jsonPartialEnvelope(output: CommandOutput): string {
  return JSON.stringify(
    {
      ok: false,
      command: output.command,
      data: output.data,
      exitCode: 1,
    },
    null,
    2,
  );
}

function jsonErrorEnvelope(
  command: string | null,
  error: {
    code: string;
    message: string;
  },
): string {
  const envelope = {
    ok: false,
    command,
    error,
    exitCode: 1,
  } satisfies JsonErrorEnvelope;
  return JSON.stringify(envelope, null, 2);
}

function printHelp(version: string): string {
  return `outpost ${version}

Usage:
  outpost <command> [options]

Commands:
  help                 Show this help output
  create --ticket <id> --type <branch-type> --repo <id> [--repo <id> ...] [--base <branch>] [--dry-run]
                         Create worktrees for imported repositories
  doctor [--json]      Report local CLI environment status
  init [--json]        Initialize Outpost home and worktrees roots
  repo add <path> [--remote <name>]
                       Validate a local repository for Outpost registration
  repo fetch --all [--json]
                        Fetch all managed mirror repositories
  repo list [--json]   List imported repositories
  repo remove <id> [--json]
                       Remove an imported repository
  repo show <id>       Show one imported repository by id
  workspace list [--json]
                         List created ticket workspaces
  workspace remove <ticket> [--json]
                         Remove a ticket workspace and all its worktrees
  workspace show <ticket> [--json]
                         Show one created ticket workspace
Global options:
  --help               Show help output
  --version            Show CLI version
  --json               Use JSON output for supported commands`;
}

function printJson(output: CommandOutput): Effect.Effect<void> {
  if (output.exitCode === 1) {
    return Console.log(jsonPartialEnvelope(output));
  }
  return Console.log(jsonSuccessEnvelope(output));
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
    case "create":
      return Effect.all([
        Console.log("outpost create"),
        Console.log(`ticket: ${String(output.data.ticket)}`),
        Console.log(`branch: ${String(output.data.branch)}`),
        ...(typeof output.data.dryRun === "boolean" && output.data.dryRun
          ? [Console.log("dry run: true")]
          : []),
        Console.log(
          `workspace directory: ${String(output.data.ticketDirectory)}`,
        ),
        Console.log(
          `worktrees: ${Array.isArray(output.data.worktrees) ? output.data.worktrees.length : 0}`,
        ),
        ...(Array.isArray(output.data.worktrees)
          ? output.data.worktrees.flatMap((worktree) => {
              const repoId =
                typeof worktree === "object" &&
                worktree !== null &&
                "repoId" in worktree
                  ? String(worktree.repoId)
                  : "";
              const repoName =
                typeof worktree === "object" &&
                worktree !== null &&
                "repoName" in worktree
                  ? String(worktree.repoName)
                  : "";
              const worktreePath =
                typeof worktree === "object" &&
                worktree !== null &&
                "path" in worktree
                  ? String(worktree.path)
                  : "";
              const branch =
                typeof worktree === "object" &&
                worktree !== null &&
                "branch" in worktree
                  ? String(worktree.branch)
                  : "";
              const base =
                typeof worktree === "object" &&
                worktree !== null &&
                "base" in worktree
                  ? String(worktree.base)
                  : "";

              return [
                Console.log(`- ${repoName} (id: ${repoId})`),
                Console.log(`  path: ${worktreePath}`),
                Console.log(`  branch: ${branch}`),
                Console.log(`  base: ${base}`),
              ];
            })
          : []),
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
    case "repo fetch":
      return Effect.all([
        Console.log("outpost repo fetch"),
        Console.log(
          `repos: ${typeof output.data.repoCount === "number" ? output.data.repoCount : 0}`,
        ),
        Console.log(
          `fetched: ${typeof output.data.fetchedCount === "number" ? output.data.fetchedCount : 0}`,
        ),
        Console.log(
          `failed: ${typeof output.data.failedCount === "number" ? output.data.failedCount : 0}`,
        ),
        ...(Array.isArray(output.data.results)
          ? output.data.results.flatMap((result) => {
              const id =
                typeof result === "object" && result !== null && "id" in result
                  ? String(result.id)
                  : "";
              const name =
                typeof result === "object" &&
                result !== null &&
                "name" in result
                  ? String(result.name)
                  : "";
              const managedRepoPath =
                typeof result === "object" &&
                result !== null &&
                "managedRepoPath" in result
                  ? String(result.managedRepoPath)
                  : "";
              const remoteName =
                typeof result === "object" &&
                result !== null &&
                "remoteName" in result
                  ? String(result.remoteName)
                  : "";
              const remoteUrl =
                typeof result === "object" &&
                result !== null &&
                "remoteUrl" in result
                  ? String(result.remoteUrl)
                  : "";
              const sourceRepoPath =
                typeof result === "object" &&
                result !== null &&
                "sourceRepoPath" in result
                  ? String(result.sourceRepoPath)
                  : "";
              const fetchStatus =
                typeof result === "object" &&
                result !== null &&
                "fetchStatus" in result
                  ? String(result.fetchStatus)
                  : "";
              const lastFetchedAt =
                typeof result === "object" &&
                result !== null &&
                "lastFetchedAt" in result
                  ? String(result.lastFetchedAt)
                  : "";
              const error =
                typeof result === "object" &&
                result !== null &&
                "error" in result
                  ? String(result.error)
                  : undefined;

              return [
                Console.log(`- ${name} (id: ${id}) [${fetchStatus}]`),
                Console.log(`  managed repo path: ${managedRepoPath}`),
                Console.log(`  remote name: ${remoteName}`),
                Console.log(`  remote url: ${remoteUrl}`),
                Console.log(`  source repo path: ${sourceRepoPath}`),
                Console.log(`  last fetched at: ${lastFetchedAt}`),
                ...(error ? [Console.log(`  error: ${error}`)] : []),
              ];
            })
          : []),
      ]).pipe(Effect.asVoid);
    case "repo remove":
      return Effect.all([
        Console.log("outpost repo remove"),
        Console.log(`id: ${String(output.data.id)}`),
        Console.log(`name: ${String(output.data.name)}`),
        Console.log(
          `managed repo path: ${String(output.data.managedRepoPath)}`,
        ),
        Console.log(`remote url: ${String(output.data.remoteUrl)}`),
        Console.log(`source repo path: ${String(output.data.sourceRepoPath)}`),
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
    case "workspace show":
      return Effect.all([
        Console.log("outpost workspace show"),
        Console.log(`ticket: ${String(output.data.ticket)}`),
        ...(typeof output.data.ticketDirectory === "string"
          ? [
              Console.log(
                `workspace directory: ${String(output.data.ticketDirectory)}`,
              ),
            ]
          : []),
        ...(typeof output.data.type === "string"
          ? [Console.log(`type: ${String(output.data.type)}`)]
          : []),
        ...(typeof output.data.branch === "string"
          ? [Console.log(`branch: ${String(output.data.branch)}`)]
          : []),
        ...(typeof output.data.createdAt === "string"
          ? [Console.log(`created at: ${String(output.data.createdAt)}`)]
          : []),
        ...(typeof output.data.workspacePath === "string"
          ? [
              Console.log(
                `workspace path: ${String(output.data.workspacePath)}`,
              ),
            ]
          : []),
        Console.log(`status: ${String(output.data.status)}`),
        ...(typeof output.data.manifestPath === "string"
          ? [Console.log(`manifest: ${String(output.data.manifestPath)}`)]
          : []),
        ...(Array.isArray(output.data.diagnostics) &&
        output.data.diagnostics.length > 0
          ? output.data.diagnostics.map((diag: unknown) =>
              Console.log(`diagnostic: ${String(diag)}`),
            )
          : []),
        Console.log(
          `worktrees: ${Array.isArray(output.data.worktrees) ? output.data.worktrees.length : 0}`,
        ),
        ...(Array.isArray(output.data.worktrees)
          ? output.data.worktrees.flatMap((worktree) => {
              const repoName =
                typeof worktree === "object" &&
                worktree !== null &&
                "repoName" in worktree
                  ? String(worktree.repoName)
                  : typeof worktree === "object" &&
                      worktree !== null &&
                      "name" in worktree
                    ? String(worktree.name)
                    : "";
              const repoId =
                typeof worktree === "object" &&
                worktree !== null &&
                "id" in worktree
                  ? String(worktree.id)
                  : "";
              const worktreePath =
                typeof worktree === "object" &&
                worktree !== null &&
                "path" in worktree
                  ? String(worktree.path)
                  : typeof worktree === "object" &&
                      worktree !== null &&
                      "resolvedWorktreePath" in worktree
                    ? String(worktree.resolvedWorktreePath)
                    : "";
              const base =
                typeof worktree === "object" &&
                worktree !== null &&
                "base" in worktree
                  ? String(worktree.base)
                  : "";
              const resolvedManagedPath =
                typeof worktree === "object" &&
                worktree !== null &&
                "resolvedManagedPath" in worktree
                  ? String(worktree.resolvedManagedPath)
                  : "";

              const lines = [
                Console.log(`- ${repoName}${repoId ? ` (id: ${repoId})` : ""}`),
              ];
              if (worktreePath)
                lines.push(Console.log(`  path: ${worktreePath}`));
              if (base) lines.push(Console.log(`  base: ${base}`));
              if (resolvedManagedPath)
                lines.push(
                  Console.log(`  managed repo: ${resolvedManagedPath}`),
                );
              return lines;
            })
          : []),
      ]).pipe(Effect.asVoid);
    case "workspace remove":
      return Effect.all([
        Console.log("outpost workspace remove"),
        ...(typeof output.data.ticket === "string"
          ? [Console.log(`ticket: ${String(output.data.ticket)}`)]
          : []),
        ...(typeof output.data.ticketDirectory === "string"
          ? [
              Console.log(
                `workspace directory: ${String(output.data.ticketDirectory)}`,
              ),
            ]
          : []),
        ...(typeof output.data.status === "string"
          ? [Console.log(`status: ${String(output.data.status)}`)]
          : []),
        Console.log(
          `worktrees: ${typeof output.data.worktreeCount === "number" ? output.data.worktreeCount : 0}`,
        ),
        ...(Array.isArray(output.data.worktreeNames)
          ? output.data.worktreeNames.map((name: unknown) =>
              Console.log(`  - ${String(name)}`),
            )
          : []),
        ...(Array.isArray(output.data.completed) &&
        output.data.completed.length > 0
          ? [
              Console.log("completed:"),
              ...output.data.completed.map((name: unknown) =>
                Console.log(`  - ${String(name)}`),
              ),
            ]
          : []),
        ...(Array.isArray(output.data.remaining) &&
        output.data.remaining.length > 0
          ? [
              Console.log("remaining:"),
              ...output.data.remaining.map((name: unknown) =>
                Console.log(`  - ${String(name)}`),
              ),
            ]
          : []),
        ...(Array.isArray(output.data.diagnostics) &&
        output.data.diagnostics.length > 0
          ? output.data.diagnostics.map((diag: unknown) =>
              Console.log(`diagnostic: ${String(diag)}`),
            )
          : []),
      ]).pipe(Effect.asVoid);
    case "workspace list":
      return Effect.all([
        Console.log("outpost workspace list"),
        Console.log(
          `workspaces: ${Array.isArray(output.data.workspaces) ? output.data.workspaces.length : 0}`,
        ),
        ...(Array.isArray(output.data.workspaces)
          ? output.data.workspaces.flatMap((workspace) => {
              const ticket =
                typeof workspace === "object" &&
                workspace !== null &&
                "ticket" in workspace
                  ? String(workspace.ticket)
                  : "";
              const ticketDirectory =
                typeof workspace === "object" &&
                workspace !== null &&
                "ticketDirectory" in workspace &&
                workspace.ticketDirectory != null
                  ? String(workspace.ticketDirectory)
                  : "";
              const worktreeCount =
                typeof workspace === "object" &&
                workspace !== null &&
                "worktreeCount" in workspace
                  ? String(workspace.worktreeCount)
                  : "0";
              const status =
                typeof workspace === "object" &&
                workspace !== null &&
                "status" in workspace
                  ? String(workspace.status)
                  : "";
              const type =
                typeof workspace === "object" &&
                workspace !== null &&
                "type" in workspace &&
                workspace.type != null
                  ? String(workspace.type)
                  : "";
              const branch =
                typeof workspace === "object" &&
                workspace !== null &&
                "branch" in workspace &&
                workspace.branch != null
                  ? String(workspace.branch)
                  : "";
              const createdAt =
                typeof workspace === "object" &&
                workspace !== null &&
                "createdAt" in workspace &&
                workspace.createdAt != null
                  ? String(workspace.createdAt)
                  : "";

              const header = [
                Console.log(`- ${ticket}${status ? ` [${status}]` : ""}`),
              ];
              if (ticketDirectory)
                header.push(
                  Console.log(`  workspace directory: ${ticketDirectory}`),
                );
              if (type) header.push(Console.log(`  type: ${type}`));
              if (branch) header.push(Console.log(`  branch: ${branch}`));
              if (createdAt)
                header.push(Console.log(`  created at: ${createdAt}`));
              header.push(Console.log(`  worktrees: ${worktreeCount}`));

              const w = workspace as Record<string, unknown>;
              if (Array.isArray(w.diagnostics) && w.diagnostics.length > 0) {
                header.push(
                  ...w.diagnostics.map((diag: unknown) =>
                    Console.log(`  diagnostic: ${String(diag)}`),
                  ),
                );
              }

              return header;
            })
          : []),
      ]).pipe(Effect.asVoid);
    default:
      return Console.log(JSON.stringify(output));
  }
}

function printUnknownCommand(
  command: string,
  asJson: boolean,
): Effect.Effect<number> {
  if (asJson) {
    return Console.error(
      jsonErrorEnvelope(null, {
        code: "UNKNOWN_COMMAND",
        message: `Unknown command: ${command}`,
      }),
    ).pipe(Effect.as(1));
  }
  return Effect.all([
    Console.error(`Unknown command: ${command}`),
    Console.error("Run `outpost --help` to see available commands."),
  ]).pipe(Effect.as(1));
}

function printError(
  error: { message: string; code: string },
  asJson: boolean,
): Effect.Effect<number> {
  if (asJson) {
    return Console.error(
      jsonErrorEnvelope(null, {
        code: error.code,
        message: error.message,
      }),
    ).pipe(Effect.as(1));
  }
  return Console.error(error.message).pipe(Effect.as(1));
}

function validateGlobalOptions(
  args: ReadonlyArray<string>,
): Effect.Effect<void, CliError> {
  const duplicateOption = ["--json", "--help", "--version"].find(
    (option) => args.filter((arg) => arg === option).length > 1,
  );

  if (duplicateOption) {
    return Effect.fail(
      new CliError({
        message: `Usage: outpost <command> [options]\n${duplicateOption} may only be provided once.`,
      }),
    );
  }

  return Effect.void;
}

function isKnownCommand(positionalArgs: ReadonlyArray<string>): boolean {
  return (
    positionalArgs[0] === "create" ||
    positionalArgs[0] === "doctor" ||
    positionalArgs[0] === "init" ||
    (positionalArgs[0] === "repo" &&
      ["add", "fetch", "list", "remove", "show"].includes(
        positionalArgs[1] ?? "",
      )) ||
    (positionalArgs[0] === "workspace" &&
      ["list", "remove", "show"].includes(positionalArgs[1] ?? ""))
  );
}

function resolveRepoAddArgs(
  args: ReadonlyArray<string>,
): Effect.Effect<{ inputPath: string; remoteName?: string }, CliError> {
  if (args.length === 0) {
    return Effect.fail(
      cliError("Usage: outpost repo add <path> [--remote <name>]"),
    );
  }

  const inputPath = args[0];

  if (!inputPath) {
    return Effect.fail(
      cliError("Usage: outpost repo add <path> [--remote <name>]"),
    );
  }

  let remoteName: string | undefined;
  let index = 1;

  while (index < args.length) {
    const arg = args[index];

    if (arg !== "--remote") {
      return Effect.fail(
        cliError("Usage: outpost repo add <path> [--remote <name>]"),
      );
    }

    if (remoteName) {
      return Effect.fail(
        cliError(
          "Usage: outpost repo add <path> [--remote <name>]\n--remote may only be provided once.",
        ),
      );
    }

    const value = args[index + 1];

    if (!value || value.startsWith("--")) {
      return Effect.fail(
        cliError(
          "Usage: outpost repo add <path> [--remote <name>]\n--remote requires a value.",
        ),
      );
    }

    remoteName = value;
    index += 2;
  }

  return Effect.succeed({ inputPath, remoteName });
}

function resolveCommand(
  positionalArgs: ReadonlyArray<string>,
  options: { interactive: boolean },
): Effect.Effect<
  CommandOutput,
  CliError,
  FileSystem.FileSystem | Path.Path | CommandExecutor.CommandExecutor
> {
  if (positionalArgs[0] === "doctor") {
    if (positionalArgs.length > 1) {
      return Effect.fail(cliError("Usage: outpost doctor [--json]"));
    }
    return runDoctor();
  }

  if (positionalArgs[0] === "create") {
    return runCreate(positionalArgs.slice(1), {
      interactive: options.interactive,
    }).pipe(Effect.mapError((error) => cliError(error.message)));
  }

  if (positionalArgs[0] === "init") {
    if (positionalArgs.length > 1) {
      return Effect.fail(cliError("Usage: outpost init [--json]"));
    }
    return runInit().pipe(Effect.mapError((error) => cliError(error.message)));
  }

  if (positionalArgs[0] === "repo" && positionalArgs[1] === "add") {
    return resolveRepoAddArgs(positionalArgs.slice(2)).pipe(
      Effect.flatMap(({ inputPath, remoteName }) =>
        runRepoAdd(inputPath, { remoteName }),
      ),
      Effect.mapError((error) => cliError(error.message)),
    );
  }

  if (positionalArgs[0] === "repo" && positionalArgs[1] === "list") {
    if (positionalArgs.length > 2) {
      return Effect.fail(cliError("Usage: outpost repo list [--json]"));
    }
    return runRepoList().pipe(
      Effect.mapError((error) => cliError(error.message)),
    );
  }

  if (positionalArgs[0] === "repo" && positionalArgs[1] === "fetch") {
    return runRepoFetch(positionalArgs.slice(2)).pipe(
      Effect.mapError((error) => cliError(error.message)),
    );
  }

  if (positionalArgs[0] === "repo" && positionalArgs[1] === "show") {
    return runRepoShow(positionalArgs[2], positionalArgs.slice(3)).pipe(
      Effect.mapError((error) => cliError(error.message)),
    );
  }

  if (positionalArgs[0] === "repo" && positionalArgs[1] === "remove") {
    return runRepoRemove(positionalArgs[2], positionalArgs.slice(3)).pipe(
      Effect.mapError((error) => cliError(error.message)),
    );
  }

  if (positionalArgs[0] === "workspace" && positionalArgs[1] === "show") {
    return runWorkspaceShow(positionalArgs[2], positionalArgs.slice(3)).pipe(
      Effect.mapError((error) => cliError(error.message)),
    );
  }

  if (positionalArgs[0] === "workspace" && positionalArgs[1] === "remove") {
    return runWorkspaceRemove(positionalArgs[2], positionalArgs.slice(3), {
      interactive: options.interactive,
    }).pipe(Effect.mapError((error) => cliError(error.message)));
  }

  if (positionalArgs[0] === "workspace" && positionalArgs[1] === "list") {
    if (positionalArgs.length > 2) {
      return Effect.fail(cliError("Usage: outpost workspace list [--json]"));
    }
    return runWorkspaceList().pipe(
      Effect.mapError((error) => cliError(error.message)),
    );
  }

  return Effect.fail(cliError(positionalArgs.join(" ")));
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
    }).pipe(Effect.mapError((error) => cliError(error.message)));

    yield* validateGlobalOptions(input.argv);

    if (input.argv.includes("--help")) {
      yield* Console.log(printHelp(input.version));
      return 0;
    }

    if (input.argv.includes("--version")) {
      yield* Console.log(input.version);
      return 0;
    }

    const asJson = input.argv.includes("--json");
    const interactive =
      !asJson && process.stdin.isTTY === true && process.stdout.isTTY === true;
    const positionalArgs = input.argv.filter(
      (arg) => arg !== "--json" && arg !== "--version",
    );

    if (positionalArgs.length === 0) {
      yield* Console.log(printHelp(input.version));
      return 0;
    }

    if (positionalArgs[0] === "help") {
      if (positionalArgs.length > 1) {
        return yield* printError("Usage: outpost help");
      }

      yield* Console.log(printHelp(input.version));
      return 0;
    }

    const output = yield* resolveCommand(positionalArgs, { interactive }).pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          isKnownCommand(positionalArgs)
            ? printError(error, asJson)
            : printUnknownCommand(error.message, asJson),
        onSuccess: (commandOutput) =>
          printCommandOutput(commandOutput, asJson).pipe(
            Effect.as(commandOutput.exitCode ?? 0),
          ),
      }),
    );

    return output;
  });

  return program.pipe(
    Effect.catchTag("CliError", (error) => {
      const asJson = argv.includes("--json");
      return printError(error, asJson);
    }),
  );
}
