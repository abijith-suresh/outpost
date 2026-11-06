// These labels and categories are protocol constants, never input or child output.
const phases = new Set([
  "prepare-cli",
  "source-identity",
  "dispatch-validation",
  "toolchain",
  "source-before",
  "destination",
  "snapshot",
  "source-manifest",
  "snapshot-install",
  "build",
  "package-list",
  "package-stage",
  "package-pack",
  "manifest-write",
  "bundle-verify",
  "consumer-install",
  "consumer-dependencies",
  "installed-bytes",
  "installed-version",
  "lifecycle",
  "lifecycle-register",
  "lifecycle-borrowed",
  "lifecycle-resume",
  "lifecycle-manager",
  "source-after",
  "artifact-cleanup",
  "scratch-cleanup",
  "source-finalizer",
  "owned-cleanup",
]);
const messages = new Map([
  ["Preparation changed the source checkout.", "source-comparison-refused"],
  ["Preparation changed the source checkout; the output was removed.", "source-finalizer-refused"],
  ["Source changed during fingerprint inspection.", "source-read-race"],
  ["Directory identity changed; preserve residue for manual inspection.", "owned-identity-refused"],
  [
    "Prerelease preparation failed; its partial artifact directory was removed.",
    "preparation-wrapper",
  ],
  ["Prerelease installation failed; its partial directory was removed.", "installation-wrapper"],
  [
    "Run this check through npm so npm_execpath identifies its JavaScript entry point.",
    "npm-entry-refused",
  ],
  ["Artifact checksum verification failed.", "archive-checksum-refused"],
  ["Installed package content verification failed.", "installed-checksum-refused"],
  [
    "Installed package file list differs from the prepared artifact.",
    "installed-file-list-refused",
  ],
  ["Installed build receipt differs.", "build-receipt-refused"],
  ["Installed version verification failed.", "installed-version-refused"],
]);
const codes = new Map([
  ["ETIMEDOUT", "child-timeout"],
  ["ENOBUFS", "child-output-bound"],
  ["ENOENT", "missing-path"],
  ["ENOTDIR", "invalid-directory"],
  ["EACCES", "access-refused"],
  ["EPERM", "permission-refused"],
  ["EEXIST", "destination-exists"],
  ["EISDIR", "unexpected-directory"],
  ["ERR_ASSERTION", "assertion-refused"],
  ["ERR_INVALID_URL_SCHEME", "invalid-url-scheme"],
]);
export function safePreparationCauses(error) {
  const result = [],
    seen = new Set();
  for (let value = error; value && result.length < 4 && !seen.has(value); value = value.cause) {
    seen.add(value);
    result.push(
      messages.get(value.message) ??
        codes.get(value.code) ??
        (Number.isInteger(value.status) && value.status !== 0
          ? "child-exit-nonzero"
          : "unclassified")
    );
  }
  return result;
}
const write = (record) => process.stderr.write(`${JSON.stringify(record)}\n`);
export function preparationDiagnostic(phase, outcome, error, sink = write) {
  // Diagnostics are best effort. They must never replace a failure or affect cleanup.
  try {
    sink({
      preparation: 1,
      phase: phases.has(phase) ? phase : "unknown",
      outcome: ["start", "complete", "failure"].includes(outcome) ? outcome : "unknown",
      ...(outcome === "failure" ? { causes: safePreparationCauses(error) } : {}),
    });
  } catch {
    /* Preserve the operation even if logging itself fails. */
  }
}
export function preparationPhase(phase, operation, sink = write) {
  preparationDiagnostic(phase, "start", undefined, sink);
  const failed = (error) => {
    preparationDiagnostic(phase, "failure", error, sink);
    throw error;
  };
  const completed = (value) => {
    preparationDiagnostic(phase, "complete", undefined, sink);
    return value;
  };
  try {
    const result = operation();
    return result instanceof Promise ? result.then(completed, failed) : completed(result);
  } catch (error) {
    return failed(error);
  }
}
