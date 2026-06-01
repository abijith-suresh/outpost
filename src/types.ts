export type CommandOutput = {
  command: string;
  data: Record<string, unknown>;
  exitCode?: 0 | 1;
};
