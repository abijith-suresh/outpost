import * as Schema from "effect/Schema";
import {
  ALL_COMMANDS,
  CONTRACT_VERSION,
  type CommandSpec,
  describeCommandMetadata,
} from "./command-spec.js";
import { ERROR_REASONS } from "./error-details.js";
import { DiagnosticSchema, DiagnosticTruncationSchema, ResultSchemas } from "./result-schemas.js";
import { CLI_ERROR_CODES } from "./types.js";

const schemaDocument = Schema.Record(Schema.String, Schema.Unknown);
const option = Schema.Struct({
  name: Schema.String,
  valueName: Schema.optional(Schema.String),
  description: Schema.String,
  required: Schema.Boolean,
  repeatable: Schema.optional(Schema.Boolean),
});
const argument = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  required: Schema.Boolean,
  repeatable: Schema.optional(Schema.Boolean),
});
export const CommandDescriptionSchema = Schema.Struct({
  path: Schema.Array(Schema.String),
  usage: Schema.String,
  description: Schema.String,
  arguments: Schema.Array(argument),
  options: Schema.Array(option),
  mutation: Schema.Boolean,
  interactive: Schema.Boolean,
  json: Schema.Boolean,
  dryRun: Schema.Boolean,
  network: Schema.Literals(["none", "explicit"]),
  retry: Schema.Literals(["safe", "inspect-before-retry"]),
  sideEffects: Schema.Array(Schema.String),
  dryRunPolicy: Schema.NullOr(
    Schema.Struct({ mutations: Schema.Boolean, locks: Schema.Boolean, advisory: Schema.Boolean })
  ),
  inputSchema: schemaDocument,
  outputSchema: Schema.NullOr(schemaDocument),
});
export const DescribeResultSchema = Schema.Union([
  Schema.Struct({
    contractVersion: Schema.String,
    cliVersion: Schema.String,
    commands: Schema.Array(CommandDescriptionSchema),
  }),
  Schema.Struct({
    contractVersion: Schema.String,
    cliVersion: Schema.String,
    ...CommandDescriptionSchema.fields,
  }),
]);
export type DescribeData = typeof DescribeResultSchema.Type;

export const ErrorSchema = Schema.Struct({
  code: Schema.Literals(CLI_ERROR_CODES),
  message: Schema.String,
  reason: Schema.Literals(ERROR_REASONS),
  retryable: Schema.Boolean,
  action: Schema.String,
  diagnostics: Schema.optional(Schema.Array(DiagnosticSchema)),
  diagnosticTruncation: Schema.optional(DiagnosticTruncationSchema),
});

export function outputSchema(spec: CommandSpec) {
  if (!spec.json) return null;
  const name = spec.path.join(" ");
  const data =
    name === "describe" ? DescribeResultSchema : ResultSchemas[name as keyof typeof ResultSchemas];
  if (!data) throw new Error(`No result schema for ${name}`);
  return Schema.toJsonSchemaDocument(
    Schema.Union([
      Schema.Struct({
        ok: Schema.Literal(true),
        command: Schema.Literal(name),
        data,
        exitCode: Schema.Literal(0),
      }),
      ...(name === "repo fetch" || name === "workspace remove" || name === "workspace resume"
        ? [
            Schema.Struct({
              ok: Schema.Literal(false),
              command: Schema.Literal(name),
              data,
              exitCode: Schema.Literal(1),
            }),
          ]
        : []),
      Schema.Struct({
        ok: Schema.Literal(false),
        command: Schema.NullOr(Schema.String),
        error: ErrorSchema,
        exitCode: Schema.Literal(1),
      }),
    ])
  ).schema;
}

export function describeCommand(spec: CommandSpec) {
  return { ...describeCommandMetadata(spec), outputSchema: outputSchema(spec) };
}
export function describeAll(cliVersion: string): DescribeData {
  return {
    contractVersion: CONTRACT_VERSION,
    cliVersion,
    commands: ALL_COMMANDS.map(describeCommand),
  };
}
