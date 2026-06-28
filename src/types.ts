export type CommandOutput = {
  command: string;
  data: Record<string, unknown>;
  exitCode?: 0 | 1;
};

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
    code: string;
    message: string;
  };
  exitCode: 1;
}

export type JsonEnvelope =
  | JsonSuccessEnvelope
  | JsonPartialEnvelope
  | JsonErrorEnvelope;
