export type Repository = {
  handle: string;
  name: string;
  kind: "managed" | "borrowed";
  retained: boolean;
  tags: string[];
  registeredAt?: string;
  path?: string;
};
export type Workspace = {
  handle: string;
  ticket: string;
  createdAt?: string;
  repositoryCount: number;
  metadataState: "recorded" | "invalid";
  diagnostic?: string;
};
export type Snapshot = {
  revision: string;
  observedAt: string;
  state: "ok" | "partial" | "uninitialized" | "updating" | "invalid";
  notice?: string;
  repositories: Repository[];
  workspaces: Workspace[];
  nextCursor: string | null;
};
export type WorkspaceDetail = {
  revision: string;
  observedAt: string;
  ticket: string;
  createdAt?: string;
  recordedBranch?: string;
  path?: string;
  members: Array<{
    name: string;
    path?: string;
    originalBase?: { source?: string; ref?: string; commit?: string };
  }>;
  notice?: string;
};
export type Settings = { revision: string; worktreesRoot: string; extraInstructions: string };
export type OperationInput =
  | { kind: "inspect-workspace"; handle: string }
  | { kind: "register"; checkoutPath: string; name: string }
  | { kind: "import"; checkoutPath: string; remoteName?: string }
  | { kind: "verify-registration" | "unregister" | "restore"; handle: string }
  | { kind: "tags"; handle: string; add: string[]; remove: string[] }
  | { kind: "set-future-root"; absolutePath: string }
  | { kind: "set-instructions"; text: string }
  | { kind: "clear-instructions" };
export type Operation = {
  id: string;
  state:
    | "submitting"
    | "accepted"
    | "running"
    | "draining"
    | "succeeded"
    | "partial"
    | "failed"
    | "unknown";
  message?: string;
  result?: {
    kind: "workspace-readiness";
    checkedAt: string;
    readiness: "ready" | "partial" | "not-ready";
    reason: "none" | "needs-inspection";
    members: Array<{
      name: string;
      readiness: "ready" | "not-ready";
      workingState: "clean" | "dirty" | "unknown";
      trackedEntries?: number;
      untrackedEntries?: number;
      conflictedEntries?: number;
      reason: "none" | "needs-inspection";
    }>;
  };
};
type Envelope<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };
export class ApiError extends Error {
  constructor(
    public code: string,
    message: string
  ) {
    super(message);
  }
}
export class UnknownOperationFailure extends Error {
  constructor(readonly requestId: string) {
    super("Response lost. Check this operation outcome before taking another action.");
  }
}
let bearer = "";
export function consumeProof(): string | null {
  const p = new URLSearchParams(location.hash.slice(1)).get("pair");
  history.replaceState(null, "", location.pathname + location.search);
  return p;
}
export function forgetSession() {
  bearer = "";
}
async function request<T>(
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal
): Promise<T> {
  const headers: Record<string, string> = { "X-Outpost-Manager": "1" };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (method === "POST") headers["Content-Type"] = "application/json";
  if (
    path === "/operations" &&
    typeof body === "object" &&
    body !== null &&
    "operation" in body &&
    typeof body.operation === "object" &&
    body.operation !== null &&
    "kind" in body.operation &&
    body.operation.kind === "set-instructions"
  )
    headers["X-Outpost-Body"] = "instructions";
  const response = await fetch(`/api/v1${path}`, {
    method,
    headers,
    body: method === "POST" ? JSON.stringify(body) : undefined,
    signal,
    cache: "no-store",
  });
  const envelope = (await response.json()) as Envelope<T>;
  if (!envelope.ok) {
    if (envelope.error.code === "session-expired") {
      forgetSession();
      window.dispatchEvent(new Event("outpost:session-expired"));
    }
    throw new ApiError(envelope.error.code, envelope.error.message);
  }
  return envelope.data;
}
export async function pair(proof: string) {
  const result = await request<{ bearer: string; expiresAt: string }>("/pair", "POST", { proof });
  bearer = result.bearer;
  return result;
}
export const api = {
  snapshot: (section: "repositories" | "workspaces", cursor?: string, signal?: AbortSignal) =>
    request<Snapshot>(
      `/snapshot?section=${section}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      "GET",
      undefined,
      signal
    ),
  workspace: (handle: string, signal?: AbortSignal) =>
    request<WorkspaceDetail>(`/workspaces/${encodeURIComponent(handle)}`, "GET", undefined, signal),
  settings: () => request<Settings>("/settings"),
  submit: async (revision: string, operation: OperationInput, requestId = crypto.randomUUID()) => {
    try {
      return await request<Operation>("/operations", "POST", { requestId, revision, operation });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new UnknownOperationFailure(requestId);
    }
  },
  operation: (id: string) => request<Operation>(`/operations/${encodeURIComponent(id)}`),
  cancel: (id: string) =>
    request<Operation>(`/operations/${encodeURIComponent(id)}/cancel`, "POST", {}),
  signOut: () => request<void>("/sign-out", "POST", {}),
  stop: () => request<void>("/stop", "POST", {}),
};
