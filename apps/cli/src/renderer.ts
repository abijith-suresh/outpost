import { Console, Effect } from "effect";
import type { CommandOutput, JsonErrorEnvelope, JsonSuccessEnvelope } from "./types.js";

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
    2
  );
}

export function jsonErrorEnvelope(
  command: string | null,
  error: JsonErrorEnvelope["error"]
): string {
  const envelope = {
    ok: false,
    command,
    error,
    exitCode: 1,
  } satisfies JsonErrorEnvelope;
  return JSON.stringify(envelope, null, 2);
}

function printJson(output: CommandOutput): Effect.Effect<void> {
  if (output.exitCode === 1) {
    return Console.log(jsonPartialEnvelope(output));
  }
  return Console.log(jsonSuccessEnvelope(output));
}

export function printCommandOutput(output: CommandOutput, asJson: boolean): Effect.Effect<void> {
  if (asJson) {
    return printJson(output);
  }

  switch (output.command) {
    case "docs":
    case "skill show":
      return Console.log(output.data.content);
    case "skill path":
      return Effect.forEach(Object.entries(output.data), ([key, value]) =>
        Console.log(`${key}: ${value}`)
      ).pipe(Effect.asVoid);
    case "skill export":
      return Console.log(
        `Exported ${output.data.files.length} skill files to ${output.data.skillPath}`
      );
    case "doctor":
      return Effect.all([
        Console.log("outpost doctor"),
        Console.log(`status: ${String(output.data.status)}`),
        Console.log(`resolved outpost home: ${String(output.data.outpostHome)}`),
        Console.log(`initialized: ${String(output.data.initialized)}`),
        Console.log(`missing repos: ${String(output.data.missingRepoCount)}`),
        ...(output.data.initialized === true
          ? [
              Console.log(`config file path: ${String(output.data.configFilePath)}`),
              Console.log(`repo registry file path: ${String(output.data.repoRegistryFilePath)}`),
              Console.log(`repos root: ${String(output.data.reposRoot)}`),
              Console.log(`worktrees root: ${String(output.data.worktreesRoot)}`),
              Console.log(`repo count: ${String(output.data.repoCount)}`),
              ...(Array.isArray(output.data.missingRepos)
                ? output.data.missingRepos.map((missingRepoPath) =>
                    Console.log(`missing managed repo: ${String(missingRepoPath)}`)
                  )
                : []),
            ]
          : []),
        Console.log(`node: ${String(output.data.node)}`),
        Console.log(`platform: ${String(output.data.platform)}`),
        Console.log(`cwd: ${String(output.data.cwd)}`),
        ...(Array.isArray(output.data.diagnostics)
          ? output.data.diagnostics.map((diagnostic: unknown) =>
              Console.log(`diagnostic: ${String(diagnostic)}`)
            )
          : []),
        ...(Array.isArray(output.data.operationRecords)
          ? output.data.operationRecords.map((record: unknown) =>
              Console.log(`recovery record: ${JSON.stringify(record)}`)
            )
          : []),
        ...(Array.isArray(output.data.workspaceHealth)
          ? output.data.workspaceHealth
              .filter((workspace) => workspace.status !== "ready")
              .map((workspace) =>
                Console.log(`workspace ${String(workspace.ticket)}: ${String(workspace.status)}`)
              )
          : []),
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
        Console.log(`workspace directory: ${String(output.data.ticketDirectory)}`),
        Console.log(
          `worktrees: ${Array.isArray(output.data.worktrees) ? output.data.worktrees.length : 0}`
        ),
        ...(Array.isArray(output.data.worktrees)
          ? output.data.worktrees.flatMap((worktree) => {
              const repoId =
                typeof worktree === "object" && worktree !== null && "repoId" in worktree
                  ? String(worktree.repoId)
                  : "";
              const repoName =
                typeof worktree === "object" && worktree !== null && "repoName" in worktree
                  ? String(worktree.repoName)
                  : "";
              const worktreePath =
                typeof worktree === "object" && worktree !== null && "path" in worktree
                  ? String(worktree.path)
                  : "";
              const branch =
                typeof worktree === "object" && worktree !== null && "branch" in worktree
                  ? String(worktree.branch)
                  : "";
              const base =
                typeof worktree === "object" && worktree !== null && "base" in worktree
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
        ...(Array.isArray(output.data.blockers) && output.data.blockers.length > 0
          ? output.data.blockers.map((blocker) => Console.log(`blocker: ${String(blocker)}`))
          : []),
      ]).pipe(Effect.asVoid);
    case "repo list":
      return Effect.all([
        Console.log("outpost repo list"),
        Console.log(`repos: ${Array.isArray(output.data.repos) ? output.data.repos.length : 0}`),
        Console.log(
          `missing repos: ${typeof output.data.missingRepoCount === "number" ? output.data.missingRepoCount : 0}`
        ),
        ...(Array.isArray(output.data.repos)
          ? output.data.repos.map((repo) => {
              const name =
                typeof repo === "object" && repo !== null && "name" in repo
                  ? String(repo.name)
                  : "";
              const id =
                typeof repo === "object" && repo !== null && "id" in repo ? String(repo.id) : "";
              const status =
                typeof repo === "object" && repo !== null && "status" in repo
                  ? String(repo.status)
                  : "";
              const managedRepoPath =
                typeof repo === "object" && repo !== null && "managedRepoPath" in repo
                  ? String(repo.managedRepoPath)
                  : "";

              return Console.log(`- ${name} (id: ${id}) [${status}]: ${managedRepoPath}`);
            })
          : []),
      ]).pipe(Effect.asVoid);
    case "repo fetch":
      return Effect.all([
        Console.log("outpost repo fetch"),
        Console.log(
          `repos: ${typeof output.data.repoCount === "number" ? output.data.repoCount : 0}`
        ),
        Console.log(
          `fetched: ${typeof output.data.fetchedCount === "number" ? output.data.fetchedCount : 0}`
        ),
        Console.log(
          `failed: ${typeof output.data.failedCount === "number" ? output.data.failedCount : 0}`
        ),
        ...(Array.isArray(output.data.results)
          ? output.data.results.flatMap((result) => {
              const id =
                typeof result === "object" && result !== null && "id" in result
                  ? String(result.id)
                  : "";
              const name =
                typeof result === "object" && result !== null && "name" in result
                  ? String(result.name)
                  : "";
              const managedRepoPath =
                typeof result === "object" && result !== null && "managedRepoPath" in result
                  ? String(result.managedRepoPath)
                  : "";
              const remoteName =
                typeof result === "object" && result !== null && "remoteName" in result
                  ? String(result.remoteName)
                  : "";
              const remoteUrl =
                typeof result === "object" && result !== null && "remoteUrl" in result
                  ? String(result.remoteUrl)
                  : "";
              const sourceRepoPath =
                typeof result === "object" && result !== null && "sourceRepoPath" in result
                  ? String(result.sourceRepoPath)
                  : "";
              const fetchStatus =
                typeof result === "object" && result !== null && "fetchStatus" in result
                  ? String(result.fetchStatus)
                  : "";
              const lastFetchedAt =
                typeof result === "object" && result !== null && "lastFetchedAt" in result
                  ? String(result.lastFetchedAt)
                  : "";
              const error =
                typeof result === "object" && result !== null && "error" in result
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
        ...(output.data.dryRun ? [Console.log("dry run: true")] : []),
        Console.log(`id: ${String(output.data.id)}`),
        Console.log(`name: ${String(output.data.name)}`),
        Console.log(`managed repo path: ${String(output.data.managedRepoPath)}`),
        Console.log(`remote url: ${String(output.data.remoteUrl)}`),
        Console.log(`source repo path: ${String(output.data.sourceRepoPath)}`),
        ...(Array.isArray(output.data.warnings)
          ? output.data.warnings.map((warning: unknown) =>
              Console.warn(`Warning: ${String(warning)}`)
            )
          : []),
      ]).pipe(Effect.asVoid);
    case "repo show":
      return Effect.all([
        Console.log("outpost repo show"),
        Console.log(`id: ${String(output.data.id)}`),
        Console.log(`name: ${String(output.data.name)}`),
        Console.log(`status: ${String(output.data.status)}`),
        Console.log(`managed repo path: ${String(output.data.managedRepoPath)}`),
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
          ? [Console.log(`workspace directory: ${String(output.data.ticketDirectory)}`)]
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
          ? [Console.log(`workspace path: ${String(output.data.workspacePath)}`)]
          : []),
        Console.log(`status: ${String(output.data.status)}`),
        ...(typeof output.data.manifestPath === "string"
          ? [Console.log(`manifest: ${String(output.data.manifestPath)}`)]
          : []),
        ...(Array.isArray(output.data.diagnostics) && output.data.diagnostics.length > 0
          ? output.data.diagnostics.map((diag: unknown) =>
              Console.log(`diagnostic: ${String(diag)}`)
            )
          : []),
        Console.log(
          `worktrees: ${Array.isArray(output.data.worktrees) ? output.data.worktrees.length : 0}`
        ),
        ...(Array.isArray(output.data.worktrees)
          ? output.data.worktrees.flatMap((worktree) => {
              const repoName =
                typeof worktree === "object" && worktree !== null && "repoName" in worktree
                  ? String(worktree.repoName)
                  : typeof worktree === "object" && worktree !== null && "name" in worktree
                    ? String(worktree.name)
                    : "";
              const repoId =
                typeof worktree === "object" && worktree !== null && "id" in worktree
                  ? String(worktree.id)
                  : "";
              const worktreePath =
                typeof worktree === "object" && worktree !== null && "path" in worktree
                  ? String(worktree.path)
                  : typeof worktree === "object" &&
                      worktree !== null &&
                      "resolvedWorktreePath" in worktree
                    ? String(worktree.resolvedWorktreePath)
                    : "";
              const base =
                typeof worktree === "object" && worktree !== null && "base" in worktree
                  ? String(worktree.base)
                  : "";
              const resolvedManagedPath =
                typeof worktree === "object" &&
                worktree !== null &&
                "resolvedManagedPath" in worktree
                  ? String(worktree.resolvedManagedPath)
                  : "";

              const lines = [Console.log(`- ${repoName}${repoId ? ` (id: ${repoId})` : ""}`)];
              if (worktreePath) lines.push(Console.log(`  path: ${worktreePath}`));
              if (base) lines.push(Console.log(`  base: ${base}`));
              if (resolvedManagedPath)
                lines.push(Console.log(`  managed repo: ${resolvedManagedPath}`));
              return lines;
            })
          : []),
      ]).pipe(Effect.asVoid);
    case "workspace remove":
      return Effect.all([
        Console.log("outpost workspace remove"),
        ...(output.data.dryRun
          ? [
              Console.log("dry run: true"),
              Console.log(`approval required: ${String(output.data.approvalRequired)}`),
            ]
          : []),
        ...(typeof output.data.ticket === "string"
          ? [Console.log(`ticket: ${String(output.data.ticket)}`)]
          : []),
        ...(typeof output.data.ticketDirectory === "string"
          ? [Console.log(`workspace directory: ${String(output.data.ticketDirectory)}`)]
          : []),
        ...(typeof output.data.status === "string"
          ? [Console.log(`status: ${String(output.data.status)}`)]
          : []),
        Console.log(
          `worktrees: ${typeof output.data.worktreeCount === "number" ? output.data.worktreeCount : 0}`
        ),
        ...(Array.isArray(output.data.worktreeNames)
          ? output.data.worktreeNames.map((name: unknown) => Console.log(`  - ${String(name)}`))
          : []),
        ...(Array.isArray(output.data.completed) && output.data.completed.length > 0
          ? [
              Console.log("completed:"),
              ...output.data.completed.map((name: unknown) => Console.log(`  - ${String(name)}`)),
            ]
          : []),
        ...(Array.isArray(output.data.remaining) && output.data.remaining.length > 0
          ? [
              Console.log("remaining:"),
              ...output.data.remaining.map((name: unknown) => Console.log(`  - ${String(name)}`)),
            ]
          : []),
        ...(Array.isArray(output.data.diagnostics) && output.data.diagnostics.length > 0
          ? output.data.diagnostics.map((diag: unknown) =>
              Console.log(`diagnostic: ${String(diag)}`)
            )
          : []),
      ]).pipe(Effect.asVoid);
    case "workspace list":
      return Effect.all([
        Console.log("outpost workspace list"),
        Console.log(
          `workspaces: ${Array.isArray(output.data.workspaces) ? output.data.workspaces.length : 0}`
        ),
        ...(Array.isArray(output.data.workspaces)
          ? output.data.workspaces.flatMap((workspace) => {
              const ticket =
                typeof workspace === "object" && workspace !== null && "ticket" in workspace
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
                typeof workspace === "object" && workspace !== null && "worktreeCount" in workspace
                  ? String(workspace.worktreeCount)
                  : "0";
              const status =
                typeof workspace === "object" && workspace !== null && "status" in workspace
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

              const header = [Console.log(`- ${ticket}${status ? ` [${status}]` : ""}`)];
              if (ticketDirectory)
                header.push(Console.log(`  workspace directory: ${ticketDirectory}`));
              if (type) header.push(Console.log(`  type: ${type}`));
              if (branch) header.push(Console.log(`  branch: ${branch}`));
              if (createdAt) header.push(Console.log(`  created at: ${createdAt}`));
              header.push(Console.log(`  worktrees: ${worktreeCount}`));

              const w = workspace;
              if (Array.isArray(w.diagnostics) && w.diagnostics.length > 0) {
                header.push(
                  ...w.diagnostics.map((diag: unknown) =>
                    Console.log(`  diagnostic: ${String(diag)}`)
                  )
                );
              }

              return header;
            })
          : []),
      ]).pipe(Effect.asVoid);
    case "describe":
      return Effect.gen(function* () {
        const data = output.data;
        if ("commands" in data) {
          yield* Console.log("outpost describe");
          yield* Console.log("commands:");
          for (const cmd of data.commands) {
            const path = String(cmd.usage);
            const desc = String(cmd.description);
            const flags = [
              cmd.mutation ? "mutation" : "read-only",
              cmd.interactive ? "interactive" : "",
              cmd.json ? "json" : "",
              cmd.dryRun ? "dry-run" : "",
            ]
              .filter(Boolean)
              .join(", ");
            yield* Console.log(`  ${path}  ${desc}`);
            yield* Console.log(`    ${flags}`);
          }
        } else if ("usage" in data) {
          yield* Console.log(`outpost describe ${data.usage}`);
          yield* Console.log(`description: ${String(data.description)}`);
          yield* Console.log(`mutation: ${String(data.mutation)}`);
          yield* Console.log(`interactive: ${String(data.interactive)}`);
          yield* Console.log(`json: ${String(data.json)}`);
          yield* Console.log(`dryRun: ${String(data.dryRun)}`);
          const commandArguments = data.arguments;
          if (Array.isArray(commandArguments) && commandArguments.length > 0) {
            yield* Console.log("arguments:");
            for (const argument of commandArguments) {
              const name = String(argument.name);
              const desc = String(argument.description);
              const required = argument.required ? " (required)" : "";
              const repeatable = argument.repeatable ? " (repeatable)" : "";
              yield* Console.log(`  <${name}>  ${desc}${required}${repeatable}`);
            }
          }
          const options = data.options;
          if (Array.isArray(options) && options.length > 0) {
            yield* Console.log("options:");
            for (const opt of options) {
              const name = String(opt.name);
              const desc = String(opt.description);
              const required = opt.required ? " (required)" : "";
              const repeatable = opt.repeatable ? " (repeatable)" : "";
              const value = opt.valueName ? ` <${String(opt.valueName)}>` : "";
              yield* Console.log(`  ${name}${value}  ${desc}${required}${repeatable}`);
            }
          }
        }
      });
    default:
      return Console.log(JSON.stringify(output));
  }
}
