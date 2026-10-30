import * as Schema from "effect/Schema";
import { BaseSourceSchema, CommitSchema, ProvenanceFields } from "./base-selection.js";
import { BorrowedRecordSchema, WorkspaceStorageSchema } from "./borrowed-schema.js";

const strings = Schema.Array(Schema.String);
const optionalString = Schema.optional(Schema.String);
const optionalBoolean = Schema.optional(Schema.Boolean);
const status = Schema.Literals(["ready", "missing", "invalid", "unmanaged"]);
export const ResumeDiagnosticSchema = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  action: Schema.String,
});
export const ResumeWorkingStateSchema = Schema.Struct({
  status: Schema.Literals(["clean", "dirty", "unknown"]),
  trackedEntries: Schema.Natural,
  untrackedEntries: Schema.Natural,
  conflictedEntries: Schema.Natural,
  truncated: Schema.Boolean,
});
export const ResumeWorktreeSchema = Schema.Struct({
  storage: Schema.optional(WorkspaceStorageSchema),
  id: Schema.String,
  name: Schema.String,
  status: Schema.Literals(["ready", "not-ready"]),
  resumable: Schema.Boolean,
  registration: Schema.Literals(["active", "retained", "unregistered"]),
  recordedPath: optionalString,
  recordedManagedPath: optionalString,
  path: optionalString,
  managedRepoPath: optionalString,
  currentBranch: Schema.optional(Schema.NullOr(Schema.String)),
  currentHead: Schema.optional(CommitSchema),
  workingState: Schema.optional(ResumeWorkingStateSchema),
  originalBase: Schema.Struct({ base: Schema.String, ...ProvenanceFields }),
  diagnostics: Schema.Array(ResumeDiagnosticSchema),
});
export const DiagnosticSchema = Schema.Struct({
  stream: Schema.Literals(["stdout", "stderr"]),
  line: Schema.String,
});
export const DiagnosticTruncationSchema = Schema.Struct({
  truncated: Schema.Boolean,
  omittedLineCount: Schema.Natural,
  capturedOutputTruncated: Schema.Boolean,
  maxLines: Schema.Natural,
  maxCharacters: Schema.Natural,
});
const repoFields = {
  id: Schema.String,
  name: Schema.String,
  managedRepoPath: Schema.String,
  remoteName: Schema.String,
  remoteUrl: Schema.String,
  sourceRepoPath: Schema.String,
  importedAt: Schema.String,
  lastFetchedAt: Schema.String,
  tags: Schema.optional(strings),
};
const repo = Schema.Struct({
  ...repoFields,
  status: Schema.Literals(["ok", "missing"]),
  retainedAt: optionalString,
  inspection: Schema.optional(
    Schema.Struct({
      status: Schema.Literals(["ok", "unavailable"]),
      refs: Schema.Array(Schema.Struct({ name: Schema.String, objectId: Schema.String })),
      diagnostics: strings,
    })
  ),
});
export const WorkspaceWorktreeSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  base: Schema.String,
  ...ProvenanceFields,
  managedPath: optionalString,
  storage: Schema.optional(WorkspaceStorageSchema),
  worktreePath: Schema.String,
  resolvedManagedPath: optionalString,
  resolvedWorktreePath: optionalString,
  worktreeExists: optionalBoolean,
  managedExists: optionalBoolean,
});
const workspaceSummary = Schema.Struct({
  ticket: Schema.String,
  ticketDirectory: optionalString,
  type: optionalString,
  branch: optionalString,
  createdAt: optionalString,
  worktreeCount: Schema.Natural,
  status,
  diagnostics: strings,
});
const removal = Schema.Struct({
  ticket: Schema.String,
  ticketDirectory: Schema.String,
  worktreeCount: Schema.Natural,
  worktreeNames: strings,
  completed: strings,
  remaining: strings,
  diagnostics: Schema.optional(strings),
  status: Schema.Literals(["success", "partial", "preview"]),
  dryRun: optionalBoolean,
  agentsOwnership: Schema.optional(
    Schema.Literals(["missing", "generated", "modified", "foreign"])
  ),
  approvalRequired: optionalBoolean,
});
const borrowedInspection = Schema.Struct({
  ...BorrowedRecordSchema.fields,
  retainedAt: optionalString,
  status: Schema.Literals(["ok", "unavailable"]),
  storage: Schema.Literal("external-unchanged"),
  diagnostics: strings,
});
const borrowedTransfer = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  kind: Schema.Literal("borrowed"),
  commonDirectory: Schema.String,
  storage: Schema.Literal("external-unchanged"),
  action: Schema.Literals(["unregistered", "restored"]),
  dryRun: Schema.Boolean,
  recoveryCommand: Schema.String,
});
export const ResultSchemas = {
  "repo register": Schema.Struct({
    action: Schema.Literals(["registered", "already-registered"]),
    repository: BorrowedRecordSchema,
    dryRun: Schema.Boolean,
  }),
  "config show": Schema.Struct({
    version: Schema.Literals([1, 2, 3]),
    storedVersion: Schema.Literals([1, 2, 3]),
    outpostHome: Schema.String,
    reposRoot: Schema.String,
    worktreesRoot: Schema.String,
    legacyWorktreesRoot: optionalString,
    trustedWorktreesRoots: Schema.optional(strings),
    extraInstructions: optionalString,
  }),
  "config set": Schema.Struct({
    key: Schema.String,
    value: Schema.String,
    futureWorkspacesOnly: Schema.Boolean,
  }),
  "guidance set": Schema.Struct({ bytes: Schema.Natural, futureWorkspacesOnly: Schema.Boolean }),
  "guidance clear": Schema.Struct({ bytes: Schema.Natural, futureWorkspacesOnly: Schema.Boolean }),
  "guidance preview": Schema.Struct({ ticketDirectory: Schema.String, content: Schema.String }),
  "repo tag": Schema.Struct({ id: Schema.String, tags: strings }),
  docs: Schema.Struct({
    topic: Schema.String,
    path: Schema.String,
    format: Schema.Literals(["markdown", "json"]),
    content: Schema.String,
  }),
  "skill show": Schema.Struct({ path: Schema.String, content: Schema.String }),
  "skill path": Schema.Struct({
    skillPath: Schema.String,
    skillDirectory: Schema.String,
    referencesPath: Schema.String,
    manPath: Schema.String,
    schemasPath: Schema.String,
  }),
  "skill export": Schema.Struct({
    directory: Schema.String,
    skillPath: Schema.String,
    files: strings,
  }),
  init: Schema.Struct({
    outpostHome: Schema.String,
    reposRoot: Schema.String,
    worktreesRoot: Schema.String,
    configFilePath: Schema.String,
    initialized: Schema.Boolean,
  }),
  create: Schema.Struct({
    ticket: Schema.String,
    ticketDirectory: Schema.String,
    type: Schema.String,
    branch: Schema.String,
    dryRun: Schema.Boolean,
    workspacePath: optionalString,
    worktrees: Schema.Array(
      Schema.Struct({
        storageKind: Schema.optional(Schema.Literals(["managed", "borrowed"])),
        commonDirectory: optionalString,
        repoId: Schema.String,
        repoName: Schema.String,
        path: Schema.String,
        branch: Schema.String,
        branchDisposition: Schema.Literals(["created", "existing"]),
        base: Schema.String,
        baseSource: BaseSourceSchema,
        requestedBase: Schema.NullOr(Schema.String),
        baseRef: Schema.String,
        baseRemote: optionalString,
        remoteRef: optionalString,
        baseCommit: Schema.NullOr(CommitSchema),
        baseResolution: Schema.Literals(["resolved", "fetch-required"]),
      })
    ),
  }),
  doctor: Schema.Struct({
    cwd: Schema.String,
    initialized: Schema.Boolean,
    missingRepoCount: Schema.Natural,
    missingRepos: strings,
    node: Schema.String,
    outpostHome: Schema.String,
    platform: Schema.String,
    diagnostics: strings,
    status: Schema.String,
    configFilePath: optionalString,
    repoRegistryFilePath: optionalString,
    reposRoot: optionalString,
    worktreesRoot: optionalString,
    repoCount: Schema.optional(Schema.Natural),
    unhealthyWorkspaceCount: Schema.optional(Schema.Natural),
    workspaceHealth: Schema.optional(
      Schema.Array(Schema.Struct({ ticket: Schema.String, status }))
    ),
    // Recovery metadata is untrusted user-editable JSON, not a command result model.
    operationRecords: Schema.optional(
      Schema.Array(
        Schema.Struct({
          kind: Schema.String,
          path: optionalString,
          metadata: Schema.optional(Schema.Unknown),
          error: optionalString,
        })
      )
    ),
  }),
  "repo add": Schema.Struct({
    action: Schema.Literals(["cloned", "fetched"]),
    registryAction: Schema.Literals(["created", "updated"]),
    remoteName: Schema.String,
    remoteUrl: Schema.String,
    sourceRepoPath: Schema.String,
    repoName: Schema.String,
    repoPath: Schema.String,
    outpostHome: Schema.String,
    reposRoot: Schema.String,
    worktreesRoot: Schema.String,
    ready: Schema.Boolean,
    blockers: strings,
  }),
  "repo list": Schema.Struct({
    missingRepoCount: Schema.Natural,
    repos: Schema.Array(Schema.Union([repo, borrowedInspection])),
  }),
  "repo show": Schema.Union([repo, borrowedInspection]),
  "repo fetch": Schema.Struct({
    failedCount: Schema.Natural,
    fetchedCount: Schema.Natural,
    repoCount: Schema.Natural,
    results: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        name: Schema.String,
        managedRepoPath: Schema.String,
        remoteName: Schema.String,
        remoteUrl: Schema.String,
        sourceRepoPath: Schema.String,
        fetchStatus: Schema.Literals(["fetched", "failed"]),
        lastFetchedAt: Schema.String,
        error: optionalString,
        reason: optionalString,
        retryable: optionalBoolean,
        action: optionalString,
        diagnostics: Schema.optional(Schema.Array(DiagnosticSchema)),
        diagnosticTruncation: Schema.optional(DiagnosticTruncationSchema),
      })
    ),
  }),
  "repo restore": Schema.Union([
    borrowedTransfer,
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      managedRepoPath: Schema.String,
      action: Schema.Literal("restored"),
      storage: Schema.Literal("retained"),
      dryRun: optionalBoolean,
    }),
  ]),
  "repo remove": Schema.Union([
    borrowedTransfer,
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      managedRepoPath: Schema.String,
      remoteUrl: Schema.String,
      sourceRepoPath: Schema.String,
      warnings: strings,
      action: Schema.Literal("unregistered"),
      storage: Schema.Literals(["retained", "missing"]),
      retainedAt: Schema.String,
      recoveryCommand: Schema.String,
      dryRun: optionalBoolean,
    }),
  ]),
  "workspace list": Schema.Struct({ workspaces: Schema.Array(workspaceSummary) }),
  "workspace show": Schema.Struct({
    ticket: Schema.String,
    status,
    worktrees: Schema.Array(WorkspaceWorktreeSchema),
    ticketDirectory: optionalString,
    type: optionalString,
    branch: optionalString,
    createdAt: optionalString,
    workspacePath: optionalString,
    manifestPath: optionalString,
    diagnostics: Schema.optional(strings),
  }),
  "workspace remove": removal,
  "workspace resume": Schema.Struct({
    ticket: Schema.String,
    status: Schema.Literals(["ready", "partial", "not-ready"]),
    resumable: Schema.Boolean,
    manifestPath: Schema.String,
    ticketDirectory: optionalString,
    expectedBranch: optionalString,
    createdAt: optionalString,
    worktrees: Schema.Array(ResumeWorktreeSchema),
    diagnostics: Schema.Array(ResumeDiagnosticSchema),
  }),
};
export type ResultData = { [K in keyof typeof ResultSchemas]: (typeof ResultSchemas)[K]["Type"] };
