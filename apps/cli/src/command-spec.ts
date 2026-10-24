export interface CommandOption {
  name: string;
  valueName?: string;
  description: string;
  required: boolean;
  repeatable?: boolean;
}

export interface CommandArgument {
  name: string;
  description: string;
  required: boolean;
  repeatable?: boolean;
}

export interface CommandSpec {
  path: readonly string[];
  description: string;
  arguments?: readonly CommandArgument[];
  options?: readonly CommandOption[];
  mutation: boolean;
  interactive: boolean;
  json: boolean;
  dryRun: boolean;
}

function joinPath(path: readonly string[]): string {
  return path.join(" ");
}

export const ALL_COMMANDS: readonly CommandSpec[] = [
  {
    path: ["help"],
    description: "Show this help output",
    arguments: [
      {
        name: "command",
        description: "Command path to show help for",
        required: false,
        repeatable: true,
      },
    ],
    mutation: false,
    interactive: false,
    json: false,
    dryRun: false,
  },
  {
    path: ["describe"],
    description: "Show command specifications",
    arguments: [
      {
        name: "command",
        description: "Command path to describe",
        required: false,
        repeatable: true,
      },
    ],
    mutation: false,
    interactive: false,
    json: true,
    dryRun: false,
  },
  {
    path: ["create"],
    description: "Create worktrees for imported repositories",
    options: [
      {
        name: "--ticket",
        valueName: "id",
        description: "Ticket identifier",
        required: true,
      },
      {
        name: "--type",
        valueName: "branch-type",
        description: "Branch type prefix (e.g. feat, fix)",
        required: true,
      },
      {
        name: "--repo",
        valueName: "id",
        description: "Repository identifier (repeatable)",
        required: true,
        repeatable: true,
      },
      {
        name: "--base",
        valueName: "branch",
        description: "Base branch (defaults to repo HEAD)",
        required: false,
      },
      {
        name: "--dry-run",
        description: "Validate without creating",
        required: false,
      },
    ],
    mutation: true,
    interactive: true,
    json: true,
    dryRun: true,
  },
  {
    path: ["doctor"],
    description: "Report local CLI environment status",
    mutation: false,
    interactive: false,
    json: true,
    dryRun: false,
  },
  {
    path: ["init"],
    description: "Initialize Outpost home and worktrees roots",
    mutation: true,
    interactive: false,
    json: true,
    dryRun: false,
  },
  {
    path: ["repo", "add"],
    description: "Validate a local repository for Outpost registration",
    arguments: [
      {
        name: "path",
        description: "Local repository path",
        required: true,
      },
    ],
    options: [
      {
        name: "--remote",
        valueName: "name",
        description: "Remote name (defaults to origin)",
        required: false,
      },
    ],
    mutation: true,
    interactive: false,
    json: true,
    dryRun: false,
  },
  {
    path: ["repo", "fetch"],
    description: "Fetch all managed mirror repositories",
    options: [
      {
        name: "--all",
        description: "Fetch all managed mirrors",
        required: true,
      },
    ],
    mutation: true,
    interactive: false,
    json: true,
    dryRun: false,
  },
  {
    path: ["repo", "list"],
    description: "List imported repositories",
    mutation: false,
    interactive: false,
    json: true,
    dryRun: false,
  },
  {
    path: ["repo", "remove"],
    description: "Remove an imported repository",
    arguments: [
      {
        name: "id",
        description: "Repository identifier",
        required: true,
      },
    ],
    mutation: true,
    interactive: false,
    json: true,
    dryRun: true,
    options: [
      {
        name: "--dry-run",
        description: "Preview removal without locks or writes",
        required: false,
      },
    ],
  },
  {
    path: ["repo", "show"],
    description: "Show one imported repository by id",
    arguments: [
      {
        name: "id",
        description: "Repository identifier",
        required: true,
      },
    ],
    mutation: false,
    interactive: false,
    json: true,
    dryRun: false,
  },
  {
    path: ["workspace", "list"],
    description: "List created ticket workspaces",
    mutation: false,
    interactive: false,
    json: true,
    dryRun: false,
  },
  {
    path: ["workspace", "remove"],
    description: "Remove a ticket workspace and all its worktrees",
    arguments: [
      {
        name: "ticket",
        description: "Ticket workspace identifier",
        required: true,
      },
    ],
    mutation: true,
    interactive: true,
    json: true,
    dryRun: true,
    options: [
      {
        name: "--dry-run",
        description: "Preview removal without locks, writes or approval prompts",
        required: false,
      },
    ],
  },
  {
    path: ["workspace", "show"],
    description: "Show one created ticket workspace",
    arguments: [
      {
        name: "ticket",
        description: "Ticket workspace identifier",
        required: true,
      },
    ],
    mutation: false,
    interactive: false,
    json: true,
    dryRun: false,
  },
];

export function findCommand(path: readonly string[]): CommandSpec | undefined {
  if (path.length === 0) return undefined;
  return ALL_COMMANDS.find(
    (spec) => spec.path.length === path.length && spec.path.every((seg, i) => seg === path[i])
  );
}

export function findCommandPrefix(path: readonly string[]): CommandSpec | undefined {
  let match: CommandSpec | undefined;

  for (const spec of ALL_COMMANDS) {
    const matches =
      spec.path.length <= path.length &&
      spec.path.every((segment, index) => segment === path[index]);

    if (matches && (!match || spec.path.length > match.path.length)) {
      match = spec;
    }
  }

  return match;
}

function formatArgumentUsage(argument: CommandArgument): string {
  if (argument.required && argument.repeatable) {
    return `<${argument.name}> [<${argument.name}> ...]`;
  }

  if (argument.required) {
    return `<${argument.name}>`;
  }

  if (argument.repeatable) {
    return `[<${argument.name}> ...]`;
  }

  return `[<${argument.name}>]`;
}

function formatOptionUsage(option: CommandOption): string {
  const value = option.valueName ? ` <${option.valueName}>` : "";

  if (option.required && option.repeatable) {
    return `${option.name}${value} [${option.name}${value} ...]`;
  }

  if (option.required) {
    return `${option.name}${value}`;
  }

  if (option.repeatable) {
    return `[${option.name}${value} ...]`;
  }

  return `[${option.name}${value}]`;
}

function formatUsageParts(spec: CommandSpec): string[] {
  return [
    ...(spec.arguments ?? []).map(formatArgumentUsage),
    ...(spec.options ?? []).map(formatOptionUsage),
    ...(spec.json ? ["[--json]"] : []),
  ];
}

export function formatCommandSummary(spec: CommandSpec): string {
  const cmdPath = joinPath(spec.path);
  const usageParts = formatUsageParts(spec);
  const usage = `  ${cmdPath}${usageParts.length ? ` ${usageParts.join(" ")}` : ""}`;

  const padding = 24;
  const paddedUsage = usage.padEnd(padding);
  return `${paddedUsage} ${spec.description}`;
}

export function formatHelpText(version: string): string {
  const commands = ["Commands:", ...ALL_COMMANDS.map(formatCommandSummary)].join("\n");

  return `outpost ${version}

Usage:
  outpost <command> [options]

${commands}
Global options:
  --help               Show help output
  --version            Show CLI version
  --json               Use JSON output for supported commands`;
}

export function formatCommandDetail(spec: CommandSpec): string {
  const cmdPath = joinPath(spec.path);
  const usageParts = formatUsageParts(spec);
  const usage = `Usage:\n  outpost ${cmdPath}${usageParts.length ? ` ${usageParts.join(" ")}` : ""}`;

  const attrs = [`  mutation: ${spec.mutation}`];
  if (spec.interactive) attrs.push("  interactive: yes");
  if (spec.json) attrs.push("  json output: yes");
  if (spec.dryRun) attrs.push("  dry-run: yes");

  const commandArguments = spec.arguments
    ? [
        "",
        "Arguments:",
        ...spec.arguments.map(
          (argument) =>
            `  <${argument.name}>  ${argument.description}${argument.required ? " (required)" : ""}${argument.repeatable ? " (repeatable)" : ""}`
        ),
      ]
    : [];

  const supportedOptions = [
    ...(spec.options ?? []),
    ...(spec.json
      ? [
          {
            name: "--json",
            description: "Output as JSON",
            required: false,
          } satisfies CommandOption,
        ]
      : []),
  ];

  const options =
    supportedOptions.length > 0
      ? [
          "",
          "Options:",
          ...supportedOptions.map(
            (opt) =>
              `  ${opt.name}${opt.valueName ? ` <${opt.valueName}>` : ""}  ${opt.description}${opt.required ? " (required)" : ""}${opt.repeatable ? " (repeatable)" : ""}`
          ),
        ]
      : [];

  return [usage, "", spec.description, "", ...attrs, ...commandArguments, ...options].join("\n");
}

/** Version of the machine contract, independent of the npm package version. */
export const CONTRACT_VERSION = "1.0.0";

export type ParsedCommandInput = {
  arguments: Readonly<Record<string, readonly string[]>>;
  options: Readonly<Record<string, readonly string[] | boolean>>;
};

/** Registry definitions are the single source for argument shape. Semantic checks stay in handlers. */
export function parseCommandInput(
  spec: CommandSpec,
  tokens: readonly string[],
  interactive = false
): ParsedCommandInput {
  const options: Record<string, string[] | boolean> = {};
  const positional: string[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const option = spec.options?.find((candidate) => candidate.name === token);
    if (!option) throw new Error(`Unknown option: ${token}`);
    if (token in options && !option.repeatable)
      throw new Error(`${token} may only be provided once.`);
    if (option.valueName) {
      const value = tokens[++index];
      if (!value || value.startsWith("--")) throw new Error(`${token} requires a value.`);
      const previous = options[token];
      options[token] = [...(Array.isArray(previous) ? previous : []), value];
    } else {
      options[token] = true;
    }
  }
  const commandArguments: Record<string, string[]> = {};
  let offset = 0;
  for (const argument of spec.arguments ?? []) {
    const values = argument.repeatable
      ? positional.slice(offset)
      : positional.slice(offset, offset + 1);
    if (argument.required && values.length === 0)
      throw new Error(`<${argument.name}> is required.`);
    commandArguments[argument.name] = values;
    offset += values.length;
  }
  if (offset < positional.length) throw new Error("Unexpected positional argument.");
  const missing = (spec.options ?? []).filter(
    (option) =>
      option.required &&
      !(interactive && spec.path.join(" ") === "create") &&
      !(option.name in options)
  );
  if (missing.length)
    throw new Error(
      missing
        .map((option) =>
          option.repeatable
            ? `At least one ${option.name} is required.`
            : `${option.name} is required.`
        )
        .join("\n")
    );
  return { arguments: commandArguments, options };
}

/** JSON Schema describes the normalized arguments/options accepted by parseCommandInput. */
export function commandInputSchema(spec: CommandSpec) {
  const stringArray = { type: "array", items: { type: "string" }, minItems: 1 };
  return {
    type: "object",
    additionalProperties: false,
    required: ["arguments", "options"],
    properties: {
      arguments: {
        type: "object",
        additionalProperties: false,
        properties: Object.fromEntries(
          (spec.arguments ?? []).map((argument) => [
            argument.name,
            {
              ...stringArray,
              minItems: argument.required ? 1 : 0,
              ...(argument.repeatable ? {} : { maxItems: 1 }),
            },
          ])
        ),
        required: (spec.arguments ?? [])
          .filter((argument) => argument.required)
          .map((argument) => argument.name),
      },
      options: {
        type: "object",
        additionalProperties: false,
        properties: Object.fromEntries(
          (spec.options ?? []).map((option) => [
            option.name,
            option.valueName
              ? { ...stringArray, ...(option.repeatable ? {} : { maxItems: 1 }) }
              : { const: true },
          ])
        ),
        required: (spec.options ?? [])
          .filter((option) => option.required)
          .map((option) => option.name),
      },
    },
  };
}

export function commandPolicy(spec: CommandSpec) {
  const name = spec.path.join(" ");
  return {
    network:
      name === "repo add" || name === "repo fetch" ? ("explicit" as const) : ("none" as const),
    retry: spec.mutation ? ("inspect-before-retry" as const) : ("safe" as const),
    sideEffects: !spec.mutation
      ? []
      : name === "create"
        ? ["local-branches", "worktrees", "workspace-metadata"]
        : name === "workspace remove"
          ? ["worktrees", "workspace-metadata"]
          : name === "init"
            ? ["configuration", "directories"]
            : ["managed-repositories", "registry"],
    dryRun: spec.dryRun ? { mutations: false, locks: false, advisory: true } : null,
  };
}

export function requireCommand(path: readonly string[]): CommandSpec {
  const spec = findCommand(path);
  if (!spec) throw new Error(`Command missing from registry: ${path.join(" ")}`);
  return spec;
}
