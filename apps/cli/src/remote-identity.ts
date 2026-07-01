import { fileURLToPath, pathToFileURL } from "node:url";

import type { PlatformError } from "@effect/platform/Error";
import * as FileSystem from "@effect/platform/FileSystem";
import * as Path from "@effect/platform/Path";
import { Effect, Schema } from "effect";

import { resolvePathWithinRoot, validatePathSegment } from "./path-safety.js";

export class RemoteIdentityError extends Schema.TaggedError<RemoteIdentityError>()(
  "RemoteIdentityError",
  {
    message: Schema.String,
  },
) {}

export type RemoteIdentity = {
  kind: "file" | "network";
  id: string;
  name: string;
  pathSegments: ReadonlyArray<string>;
  transportUrl: string;
};

function invalidRemote(
  remoteUrl: string,
  details: string,
): RemoteIdentityError {
  return new RemoteIdentityError({
    message: `Invalid remote URL ${remoteUrl}: ${details}`,
  });
}

function stripTerminalGit(value: string): string {
  return value.endsWith(".git") ? value.slice(0, -4) : value;
}

export function isWindowsLocalPath(
  remoteUrl: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return (
    platform === "win32" &&
    (/^[a-z]:[\\/]/i.test(remoteUrl) || remoteUrl.startsWith("\\\\"))
  );
}

export function encodeManagedPathSegment(segment: string): string {
  const bytes = Buffer.from(segment);
  let encoded = "";

  for (const byte of bytes) {
    const character = String.fromCharCode(byte);
    encoded += /^[a-z0-9._-]$/.test(character)
      ? character
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }

  encoded = encoded.replace(/\.+$/, (dots) => "%2E".repeat(dots.length));

  const windowsComparable = encoded.replace(/[ .]+$/g, "");
  const windowsBaseName = windowsComparable.split(".")[0] ?? "";
  const isWindowsReserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(
    windowsBaseName,
  );

  if (isWindowsReserved) {
    const firstByte = bytes[0] as number;
    encoded = `%${firstByte.toString(16).toUpperCase().padStart(2, "0")}${encoded.slice(1)}`;
  }

  return encoded;
}

export function getFileManagedPathSegments(
  canonicalFileUrl: string,
): ReadonlyArray<string> {
  const url = new URL(canonicalFileUrl);
  const pathSegments = url.pathname
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => decodeURIComponent(segment));

  return url.hostname.length > 0
    ? ["file", "unc", url.hostname.toLowerCase(), ...pathSegments]
    : ["file", ...pathSegments];
}

function decodePathSegments(
  remoteUrl: string,
  rawPath: string,
): Effect.Effect<ReadonlyArray<string>, RemoteIdentityError> {
  const withoutTrailingSlash = rawPath.endsWith("/")
    ? rawPath.slice(0, -1)
    : rawPath;
  const rawSegments = withoutTrailingSlash.replace(/^\/+/, "").split("/");

  if (
    rawSegments.length === 0 ||
    rawSegments.some((segment) => segment.length === 0)
  ) {
    return Effect.fail(
      invalidRemote(remoteUrl, "path components may not be empty."),
    );
  }

  return Effect.try({
    try: () =>
      rawSegments.map((segment, index) => {
        const decoded = decodeURIComponent(segment);
        const value =
          index === rawSegments.length - 1
            ? stripTerminalGit(decoded)
            : decoded;

        if (
          value.length === 0 ||
          value === "." ||
          value === ".." ||
          value.includes("/") ||
          value.includes("\\") ||
          value.includes("\0")
        ) {
          throw new Error("path contains an unsafe or empty component");
        }

        return value;
      }),
    catch: (error) =>
      invalidRemote(
        remoteUrl,
        error instanceof URIError
          ? "path contains invalid percent encoding."
          : "path contains an unsafe or empty component.",
      ),
  });
}

function buildNetworkIdentity(
  remoteUrl: string,
  hostname: string,
  port: string,
  rawPath: string,
): Effect.Effect<RemoteIdentity, RemoteIdentityError> {
  return Effect.gen(function* () {
    const normalizedHost = hostname.toLowerCase();

    if (normalizedHost.length === 0) {
      return yield* Effect.fail(invalidRemote(remoteUrl, "host is required."));
    }

    const pathSegments = yield* decodePathSegments(remoteUrl, rawPath);
    const host = port.length > 0 ? `${normalizedHost}:${port}` : normalizedHost;

    return {
      kind: "network",
      id: [host, ...pathSegments].join("/"),
      name: pathSegments[pathSegments.length - 1] as string,
      pathSegments: [host, ...pathSegments],
      transportUrl: remoteUrl,
    };
  });
}

function parseNetworkRemote(
  remoteUrl: string,
): Effect.Effect<RemoteIdentity | undefined, RemoteIdentityError> {
  if (isWindowsLocalPath(remoteUrl)) {
    return Effect.succeed(undefined);
  }

  const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(remoteUrl);

  if (schemeMatch) {
    const protocol = schemeMatch[1]?.toLowerCase();

    if (protocol === "file") {
      return Effect.succeed(undefined);
    }

    if (protocol !== "https" && protocol !== "ssh") {
      return Effect.fail(
        invalidRemote(remoteUrl, `unsupported scheme ${protocol ?? ""}.`),
      );
    }

    return Effect.try({
      try: () => new URL(remoteUrl),
      catch: () => invalidRemote(remoteUrl, "URL could not be parsed."),
    }).pipe(
      Effect.flatMap((url) => {
        if (url.search.length > 0 || url.hash.length > 0) {
          return Effect.fail(
            invalidRemote(
              remoteUrl,
              "query strings and fragments are not allowed.",
            ),
          );
        }

        const defaultPort = protocol === "https" ? "443" : "22";
        const port = url.port === defaultPort ? "" : url.port;
        const pathStart = remoteUrl.indexOf("/", schemeMatch[0].length);
        const queryStart = remoteUrl.search(/[?#]/);
        const pathEnd = queryStart === -1 ? remoteUrl.length : queryStart;
        const rawPath =
          pathStart === -1 || pathStart >= pathEnd
            ? ""
            : remoteUrl.slice(pathStart, pathEnd);
        return buildNetworkIdentity(remoteUrl, url.hostname, port, rawPath);
      }),
    );
  }

  const scpMatch = /^(?:[^@/:\s]+@)?(\[[^\]]+\]|[^/\\:\s]+):(.+)$/.exec(
    remoteUrl,
  );

  if (!scpMatch) {
    return Effect.succeed(undefined);
  }

  if (
    (scpMatch[2] as string).includes("?") ||
    (scpMatch[2] as string).includes("#")
  ) {
    return Effect.fail(
      invalidRemote(remoteUrl, "query strings and fragments are not allowed."),
    );
  }

  return buildNetworkIdentity(
    remoteUrl,
    scpMatch[1] as string,
    "",
    scpMatch[2] as string,
  );
}

function parseLocalRemotePath(
  remoteUrl: string,
  sourceRepoPath: string,
): Effect.Effect<string, RemoteIdentityError, Path.Path> {
  return Effect.gen(function* () {
    const path = yield* Path.Path;

    if (!/^file:\/\//i.test(remoteUrl)) {
      return path.resolve(sourceRepoPath, remoteUrl);
    }

    const url = yield* Effect.try({
      try: () => new URL(remoteUrl),
      catch: () => invalidRemote(remoteUrl, "URL could not be parsed."),
    });

    if (url.search.length > 0 || url.hash.length > 0) {
      return yield* Effect.fail(
        invalidRemote(
          remoteUrl,
          "query strings and fragments are not allowed.",
        ),
      );
    }

    return yield* Effect.try({
      try: () => fileURLToPath(url),
      catch: () => invalidRemote(remoteUrl, "file URL is not local."),
    });
  });
}

function buildLocalIdentity(
  remoteUrl: string,
  sourceRepoPath: string,
): Effect.Effect<
  RemoteIdentity,
  RemoteIdentityError | PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const canonicalSourceRepoPath = yield* fs.realPath(sourceRepoPath);
    const localPath = yield* parseLocalRemotePath(
      remoteUrl,
      canonicalSourceRepoPath,
    );
    const realPath = yield* fs.realPath(localPath);
    const transportPath = realPath.endsWith(path.sep)
      ? realPath.slice(0, -1)
      : realPath;
    const canonicalPath = stripTerminalGit(transportPath);
    const name = path.basename(canonicalPath);

    if (name.length === 0 || name === "." || name === "..") {
      return yield* Effect.fail(
        invalidRemote(remoteUrl, "path must identify a repository."),
      );
    }

    const canonicalFileUrl = pathToFileURL(canonicalPath).href;
    const pathSegments = getFileManagedPathSegments(canonicalFileUrl);

    for (const segment of pathSegments.slice(1)) {
      if (
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment.includes("/") ||
        segment.includes("\\") ||
        segment.includes("\0")
      ) {
        return yield* Effect.fail(
          invalidRemote(
            remoteUrl,
            "path contains an unsafe or empty component.",
          ),
        );
      }
    }

    return {
      kind: "file",
      id: canonicalFileUrl,
      name,
      pathSegments,
      transportUrl: pathToFileURL(transportPath).href,
    };
  });
}

export function resolveRemoteIdentity(
  remoteUrl: string,
  sourceRepoPath: string,
): Effect.Effect<
  RemoteIdentity,
  RemoteIdentityError | PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    if (remoteUrl.length === 0) {
      return yield* Effect.fail(invalidRemote(remoteUrl, "value is empty."));
    }

    const networkIdentity = yield* parseNetworkRemote(remoteUrl);
    return (
      networkIdentity ?? (yield* buildLocalIdentity(remoteUrl, sourceRepoPath))
    );
  });
}

export function getManagedRepoPath(
  reposRoot: string,
  identity: RemoteIdentity,
): Effect.Effect<string, RemoteIdentityError, Path.Path> {
  return Effect.gen(function* () {
    const managedSegments = identity.pathSegments.map((segment, index) => {
      const encoded = encodeManagedPathSegment(segment);
      return index === identity.pathSegments.length - 1
        ? `${encoded}.git`
        : encoded;
    });

    for (const segment of managedSegments) {
      yield* validatePathSegment("Remote path component", segment).pipe(
        Effect.mapError(
          (error) => new RemoteIdentityError({ message: error.message }),
        ),
      );
    }

    return yield* resolvePathWithinRoot(reposRoot, ...managedSegments).pipe(
      Effect.mapError(
        (error) => new RemoteIdentityError({ message: error.message }),
      ),
    );
  });
}
