export type CommandOutput = {
  command: string;
  data: Record<string, unknown>;
  exitCode?: 0 | 1;
};

export const CLI_ERROR_CODES = [
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

export type CliErrorDiagnostic = Readonly<Record<string, unknown>>;

export interface JsonSuccessEnvelope {
  ok: true;
  command: string;
  data: Record<string, unknown>;
  exitCode: 0;
}

export interface JsonPartialEnvelope {
  ok: false;
  command: string;
  data: Record<string, unknown>;
  exitCode: 1;
}

export interface JsonErrorEnvelope {
  ok: false;
  command: string | null;
  error: {
    code: CliErrorCode;
    message: string;
    diagnostics?: ReadonlyArray<CliErrorDiagnostic>;
  };
  exitCode: 1;
}

export type JsonEnvelope =
  | JsonSuccessEnvelope
  | JsonPartialEnvelope
  | JsonErrorEnvelope;
