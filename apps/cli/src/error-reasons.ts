export const ERROR_REASONS = [
  "lock-held",
  "dirty-worktree",
  "repo-in-use",
  "repo-missing",
  "workspace-missing",
  "invalid-arguments",
  "invalid-state",
  "approval-needed",
  "operation-failed",
] as const;
export type ErrorReason = (typeof ERROR_REASONS)[number];
export type ErrorDetails = { reason: ErrorReason; retryable: boolean; action: string };

export function reasonDetails(reason: ErrorReason): ErrorDetails {
  const recovery: Record<ErrorReason, readonly [boolean, string]> = {
    "lock-held": [
      true,
      "Wait for the owner to finish. After a crash, run outpost doctor and inspect the owner and artifacts before manual recovery.",
    ],
    "dirty-worktree": [false, "Commit or preserve local changes before retrying removal."],
    "repo-in-use": [
      false,
      "Inspect workspace manifests and git worktree list; remove owned workspaces before removing the repository.",
    ],
    "repo-missing": [
      false,
      "Inspect outpost repo list and restore or explicitly import the required repository.",
    ],
    "workspace-missing": [false, "Inspect outpost workspace list and use an existing ticket."],
    "invalid-arguments": [
      false,
      "Use outpost describe <command> --json or outpost help <command> and correct the arguments.",
    ],
    "invalid-state": [
      false,
      "Run outpost doctor --json and inspect local metadata and Git state before retrying.",
    ],
    "approval-needed": [
      false,
      "Preserve the changed guidance and obtain explicit approval before deleting it; an interactive removal can request consent.",
    ],
    "operation-failed": [
      false,
      "Inspect diagnostics and local state before retrying; no automatic recovery is performed.",
    ],
  };
  const [retryable, action] = recovery[reason];
  return { reason, retryable, action };
}

/** Preserve structured domain information across error wrappers. Never classify message text. */
export function domainDetails(
  error: unknown,
  fallback: ErrorReason = "invalid-state"
): ErrorDetails {
  if (
    typeof error === "object" &&
    error !== null &&
    "reason" in error &&
    ERROR_REASONS.includes(error.reason as ErrorReason)
  ) {
    const defaults = reasonDetails(error.reason as ErrorReason);
    return {
      ...defaults,
      ...("retryable" in error && typeof error.retryable === "boolean"
        ? { retryable: error.retryable }
        : {}),
      ...("action" in error && typeof error.action === "string" ? { action: error.action } : {}),
    };
  }
  return reasonDetails(fallback);
}
