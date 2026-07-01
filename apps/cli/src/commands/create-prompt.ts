import process from "node:process";
import { createInterface } from "node:readline/promises";

export type CreatePromptRepoOption = {
  id: string;
  name: string;
};

export type CreatePromptInput = {
  ticket?: string;
  type?: string;
  repoIds: ReadonlyArray<string>;
  base?: string;
  availableRepos: ReadonlyArray<CreatePromptRepoOption>;
};

export type CreatePromptResult = {
  ticket?: string;
  type?: string;
  repoIds: ReadonlyArray<string>;
  base?: string;
};

type CreatePromptOptions = {
  ask?: (question: string) => Promise<string>;
  log?: (message: string) => void;
};

function parsePromptedRepoIds(value: string): Array<string> {
  return [
    ...new Set(
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function validateNoPathSeparators(
  label: string,
  value: string,
): string | undefined {
  if (value.includes("/") || value.includes("\\")) {
    return `${label} must not contain path separators (/ or \\)`;
  }
}

async function promptForRequiredValue(
  ask: (question: string) => Promise<string>,
  label: string,
  validate?: (value: string) => string | undefined,
  log?: (message: string) => void,
): Promise<string> {
  while (true) {
    const answer = (await ask(label)).trim();

    if (answer.length === 0) {
      continue;
    }

    const error = validate?.(answer);
    if (error) {
      log?.(error);
      continue;
    }

    return answer;
  }
}

async function promptForRepoIds(
  ask: (question: string) => Promise<string>,
  availableRepos: ReadonlyArray<CreatePromptRepoOption>,
  log: (message: string) => void,
): Promise<ReadonlyArray<string>> {
  const availableRepoIds = new Set(availableRepos.map((repo) => repo.id));

  if (availableRepos.length > 0) {
    log("Available repos:");

    for (const repo of availableRepos) {
      log(`- ${repo.name} (id: ${repo.id})`);
    }
  }

  while (true) {
    const answer = await ask("Repo ids (comma-separated): ");
    const repoIds = parsePromptedRepoIds(answer);

    if (repoIds.length === 0) {
      continue;
    }

    const unknownRepoIds = repoIds.filter(
      (repoId) => !availableRepoIds.has(repoId),
    );

    if (unknownRepoIds.length > 0) {
      const label = unknownRepoIds.length === 1 ? "id" : "ids";
      log(`Unknown repo ${label}: ${unknownRepoIds.join(", ")}`);
      continue;
    }

    return repoIds;
  }
}

export async function promptForMissingCreateArgs(
  input: CreatePromptInput,
  options?: CreatePromptOptions,
): Promise<CreatePromptResult> {
  if (options?.ask) {
    const log = options.log ?? console.log;
    const ticket =
      input.ticket ??
      (await promptForRequiredValue(
        options.ask,
        "Ticket id: ",
        validateNoPathSeparators.bind(null, "Ticket"),
        log,
      ));
    const type =
      input.type ??
      (await promptForRequiredValue(
        options.ask,
        "Branch type: ",
        validateNoPathSeparators.bind(null, "Branch type"),
        log,
      ));
    const repoIds =
      input.repoIds.length > 0
        ? input.repoIds
        : await promptForRepoIds(options.ask, input.availableRepos, log);

    return {
      ticket,
      type,
      repoIds,
      base: input.base,
    } satisfies CreatePromptResult;
  }

  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let cancelled = false;

  readline.on("SIGINT", () => {
    cancelled = true;
    readline.close();
  });

  try {
    const ask = async (question: string) => {
      if (cancelled) throw new Error("Cancelled by user");
      const answer = await readline.question(question);
      if (cancelled) throw new Error("Cancelled by user");
      return answer;
    };
    const log = (message: string) => console.log(message);
    const ticket =
      input.ticket ??
      (await promptForRequiredValue(
        ask,
        "Ticket id: ",
        validateNoPathSeparators.bind(null, "Ticket"),
        log,
      ));
    const type =
      input.type ??
      (await promptForRequiredValue(
        ask,
        "Branch type: ",
        validateNoPathSeparators.bind(null, "Branch type"),
        log,
      ));
    const repoIds =
      input.repoIds.length > 0
        ? input.repoIds
        : await promptForRepoIds(ask, input.availableRepos, log);

    return {
      ticket,
      type,
      repoIds,
      base: input.base,
    } satisfies CreatePromptResult;
  } finally {
    readline.close();
  }
}
