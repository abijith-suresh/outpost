import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import {
  BorrowedError,
  discoverBorrowed,
  prepareBorrowedState,
  verifyBorrowed,
} from "../borrowed-repo.js";
import { parseCommandInput, requireCommand } from "../command-spec.js";
import { loadConfig, loadRepoRegistry, resolveOutpostHome, writeRepoRegistry } from "../config.js";
import { acquireHomeMutationLock } from "../mutation-lock.js";
import { getCanonicalPortablePathKey } from "../path-safety.js";
import { listManifestTickets, readManifest } from "../workspace-manifest.js";

export function runRepoRegister(args: readonly string[]) {
  return Effect.gen(function* () {
    const parsed = parseCommandInput(requireCommand(["repo", "register"]), args);
    const name = parsed.options["--name"];
    if (!Array.isArray(name) || !name[0] || !parsed.arguments.path[0])
      return yield* new BorrowedError({ message: "A checkout and --name are required." });
    const home = yield* resolveOutpostHome();
    yield* loadConfig(home);
    const candidate = yield* discoverBorrowed(parsed.arguments.path[0], name[0]);
    const path = yield* Path.Path;
    const homeKey = yield* getCanonicalPortablePathKey(home);
    for (const directory of [
      candidate.anchor.path,
      candidate.privateGit.path,
      candidate.common.path,
    ]) {
      const key = yield* getCanonicalPortablePathKey(directory);
      const relative = path.relative(key, homeKey);
      if (
        relative === "" ||
        (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
      )
        return yield* new BorrowedError({
          message:
            "Outpost metadata home cannot be inside borrowed source storage. Use an external Outpost home; source files are preserved.",
        });
    }
    const mutation = parsed.options["--dry-run"]
      ? undefined
      : yield* acquireHomeMutationLock(home, "repo register");
    const registry = yield* loadRepoRegistry(home);
    yield* verifyBorrowed(candidate);
    const records = [
      ...(registry.borrowedRepositories ?? []),
      ...(registry.retainedBorrowedRepositories ?? []),
    ];
    const existing = records.find((entry) => entry.common.path === candidate.common.path);
    if (existing) {
      yield* verifyBorrowed(existing);
      if (registry.retainedBorrowedRepositories?.some((entry) => entry.id === existing.id))
        return yield* new BorrowedError({
          message: "Registration is retained. Use repo restore <id>; it cannot be replaced.",
        });
      return {
        command: "repo register" as const,
        data: {
          action: "already-registered" as const,
          repository: existing,
          dryRun: !!parsed.options["--dry-run"],
        },
      };
    }
    if (
      [...registry.repos, ...(registry.retainedRepositories ?? [])].some(
        (repo) => repo.managedRepoPath === candidate.common.path
      )
    )
      return yield* new BorrowedError({
        message: "Common directory conflicts with managed storage.",
      });
    if (mutation) {
      yield* mutation.record({ action: "register-borrowed-repository", repository: candidate });
      const prepared = yield* prepareBorrowedState(home);
      yield* verifyBorrowed(candidate);
      yield* writeRepoRegistry(home, {
        ...prepared,
        borrowedRepositories: [...(prepared.borrowedRepositories ?? []), candidate],
      });
    }
    return {
      command: "repo register" as const,
      data: { action: "registered" as const, repository: candidate, dryRun: !mutation },
    };
  }).pipe(Effect.scoped);
}

export function transferBorrowed(
  home: string,
  repoId: string,
  mode: "remove" | "restore",
  dryRun: boolean
) {
  return Effect.gen(function* () {
    const registry = yield* loadRepoRegistry(home);
    const record = (
      mode === "remove" ? registry.borrowedRepositories : registry.retainedBorrowedRepositories
    )?.find((entry) => entry.id === repoId);
    if (!record) return undefined;
    yield* verifyBorrowed(record);
    for (const ticket of yield* listManifestTickets(home)) {
      const manifest = yield* readManifest(home, ticket);
      if (manifest.repositories.some((member) => member.id === repoId))
        return yield* new BorrowedError({
          message: `Repository is referenced by workspace ${ticket}; preserve its registration.`,
        });
    }
    const data = {
      id: record.id,
      name: record.name,
      kind: "borrowed" as const,
      commonDirectory: record.common.path,
      storage: "external-unchanged" as const,
      action: mode === "remove" ? ("unregistered" as const) : ("restored" as const),
      dryRun,
      recoveryCommand: "outpost repo restore <id>",
    };
    if (!dryRun) {
      const { retainedAt: _, ...active } = { ...record, retainedAt: "" };
      yield* verifyBorrowed(record);
      yield* writeRepoRegistry(home, {
        ...registry,
        borrowedRepositories:
          mode === "remove"
            ? registry.borrowedRepositories?.filter((entry) => entry.id !== repoId)
            : [...(registry.borrowedRepositories ?? []), active],
        retainedBorrowedRepositories:
          mode === "remove"
            ? [
                ...(registry.retainedBorrowedRepositories ?? []),
                { ...record, retainedAt: new Date().toISOString() },
              ]
            : registry.retainedBorrowedRepositories?.filter((entry) => entry.id !== repoId),
      });
    }
    return data;
  });
}
