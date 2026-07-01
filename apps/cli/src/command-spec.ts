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
    dryRun: false,
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
    dryRun: false,
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
    (spec) =>
      spec.path.length === path.length &&
      spec.path.every((seg, i) => seg === path[i]),
  );
}

export function findCommandPrefix(
  path: readonly string[],
): CommandSpec | undefined {
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
  const commands = [
    "Commands:",
    ...ALL_COMMANDS.map(formatCommandSummary),
  ].join("\n");

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
            `  <${argument.name}>  ${argument.description}${argument.required ? " (required)" : ""}${argument.repeatable ? " (repeatable)" : ""}`,
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
              `  ${opt.name}${opt.valueName ? ` <${opt.valueName}>` : ""}  ${opt.description}${opt.required ? " (required)" : ""}${opt.repeatable ? " (repeatable)" : ""}`,
          ),
        ]
      : [];

  return [
    usage,
    "",
    spec.description,
    "",
    ...attrs,
    ...commandArguments,
    ...options,
  ].join("\n");
}
