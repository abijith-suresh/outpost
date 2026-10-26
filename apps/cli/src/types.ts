import type { ErrorDetails } from "./error-details.js";
import type { DescribeData } from "./machine-contract.js";
import type { DiagnosticSchema, DiagnosticTruncationSchema, ResultData } from "./result-schemas.js";

type CommandData = ResultData & { describe: DescribeData };
export type CommandOutput<K extends keyof CommandData = keyof CommandData> = {
  [C in K]: { command: C; data: CommandData[C]; exitCode?: 0 | 1 };
}[K];

export const CLI_ERROR_CODES = [
  "CONFIG_FAILED",
  "REPO_TAG_FAILED",
  "GUIDANCE_FAILED",
  "INVALID_ARGUMENT",
  "UNKNOWN_COMMAND",
  "CREATE_FAILED",
  "DOCTOR_FAILED",
  "INIT_FAILED",
  "REPO_ADD_FAILED",
  "REPO_FETCH_FAILED",
  "REPO_LIST_FAILED",
  "REPO_REMOVE_FAILED",
  "REPO_SHOW_FAILED",
  "WORKSPACE_LIST_FAILED",
  "WORKSPACE_REMOVE_FAILED",
  "WORKSPACE_SHOW_FAILED",
] as const;

export type CliErrorCode = (typeof CLI_ERROR_CODES)[number];

export type CliErrorDiagnostic = typeof DiagnosticSchema.Type;
export type DiagnosticTruncation = typeof DiagnosticTruncationSchema.Type;

export interface JsonSuccessEnvelope {
  ok: true;
  command: string;
  data: CommandOutput["data"];
  exitCode: 0;
}

export interface JsonPartialEnvelope {
  ok: false;
  command: string;
  data: CommandOutput["data"];
  exitCode: 1;
}

export interface JsonErrorEnvelope {
  ok: false;
  command: string | null;
  error: Partial<ErrorDetails> & {
    code: CliErrorCode;
    message: string;
    diagnostics?: ReadonlyArray<CliErrorDiagnostic>;
    diagnosticTruncation?: DiagnosticTruncation;
  };
  exitCode: 1;
}

export type JsonEnvelope = JsonSuccessEnvelope | JsonPartialEnvelope | JsonErrorEnvelope;
