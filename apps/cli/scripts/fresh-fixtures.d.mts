export function freshLoopback(
  bareRepository: string,
  directory: string
): Promise<{
  url: string;
  helperCommand: string;
  askpassCommand: string;
  helperLog: string;
  askpassMarker: string;
  readonly authenticated: number;
  close(): Promise<void>;
}>;
