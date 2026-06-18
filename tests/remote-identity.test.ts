import { symlinkSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { NodeContext } from "@effect/platform-node";
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import {
  encodeManagedPathSegment,
  getFileManagedPathSegments,
  getManagedRepoPath,
  isWindowsLocalPath,
  resolveRemoteIdentity,
} from "../src/remote-identity.ts";
import {
  createTempDir,
  initBareGitRepo,
  localRepoId,
  localTransportUrl,
  mkdirSync,
  path,
  setupAfterEach,
} from "./helpers.ts";

setupAfterEach();

function resolveIdentity(remoteUrl: string, sourceRepoPath = "/tmp/source") {
  return Effect.runPromise(
    resolveRemoteIdentity(remoteUrl, sourceRepoPath).pipe(
      Effect.provide(NodeContext.layer),
    ),
  );
}

describe("remote identity", () => {
  it("normalizes HTTPS, ssh URLs, and SCP-style SSH", async () => {
    const identities = await Promise.all([
      resolveIdentity("https://Example.COM/Group/Repo.git/"),
      resolveIdentity("ssh://git@example.com:22/Group/Repo.git"),
      resolveIdentity("deploy@EXAMPLE.com:Group/Repo.git"),
    ]);

    expect(identities.map((identity) => identity.id)).toEqual([
      "example.com/Group/Repo",
      "example.com/Group/Repo",
      "example.com/Group/Repo",
    ]);
    expect(identities[0]?.name).toBe("Repo");
  });

  it("preserves full namespaces and distinguishes hosts and namespaces", async () => {
    const gitlab = await resolveIdentity(
      "https://gitlab.example.com/Platform/Services/Repo.git",
    );
    const otherNamespace = await resolveIdentity(
      "https://gitlab.example.com/Other/Services/Repo.git",
    );
    const otherHost = await resolveIdentity(
      "https://mirror.example.com/Platform/Services/Repo.git",
    );

    expect(gitlab.id).toBe("gitlab.example.com/Platform/Services/Repo");
    expect(otherNamespace.id).not.toBe(gitlab.id);
    expect(otherHost.id).not.toBe(gitlab.id);
  });

  it("omits default ports and retains non-default ports", async () => {
    const httpsDefault = await resolveIdentity(
      "https://example.com:443/Group/Repo.git",
    );
    const sshDefault = await resolveIdentity(
      "ssh://git@example.com:22/Group/Repo.git",
    );
    const custom = await resolveIdentity(
      "https://example.com:8443/Group/Repo.git",
    );

    expect(httpsDefault.id).toBe("example.com/Group/Repo");
    expect(sshDefault.id).toBe("example.com/Group/Repo");
    expect(custom.id).toBe("example.com:8443/Group/Repo");

    const managedPath = await Effect.runPromise(
      getManagedRepoPath("/tmp/repos", custom).pipe(
        Effect.provide(NodeContext.layer),
      ),
    );
    expect(managedPath).toBe(
      path.join("/tmp/repos", "example.com%3A8443", "%47roup", "%52epo.git"),
    );
  });

  it("rejects query, fragment, traversal, and empty network paths", async () => {
    for (const remoteUrl of [
      "git@example.com:Group/Repo.git?ref=main",
      "git@example.com:Group/Repo.git#main",
      "https://example.com/Group/%2E%2E/Repo.git",
      "https://example.com/Group//Repo.git",
    ]) {
      const exit = await Effect.runPromise(
        Effect.exit(resolveRemoteIdentity(remoteUrl, "/tmp/source")).pipe(
          Effect.provide(NodeContext.layer),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }
  });

  it("canonicalizes relative, absolute, file URL, and symlink local remotes", async () => {
    const root = createTempDir("outpost-identity-");
    const sourceRepo = path.join(root, "source");
    const remote = path.join(root, "namespace", "Repo.git");
    const symlink = path.join(root, "Repo-link.git");
    mkdirSync(sourceRepo, { recursive: true });
    mkdirSync(path.dirname(remote), { recursive: true });
    await initBareGitRepo(remote);
    symlinkSync(remote, symlink);

    const identities = await Promise.all([
      resolveIdentity("../namespace/Repo.git", sourceRepo),
      resolveIdentity(remote, sourceRepo),
      resolveIdentity(pathToFileURL(remote).href, sourceRepo),
      resolveIdentity(symlink, sourceRepo),
    ]);

    expect(identities.map((identity) => identity.id)).toEqual([
      localRepoId(remote),
      localRepoId(remote),
      localRepoId(remote),
      localRepoId(remote),
    ]);
    expect(identities.map((identity) => identity.transportUrl)).toEqual([
      localTransportUrl(remote),
      localTransportUrl(remote),
      localTransportUrl(remote),
      localTransportUrl(remote),
    ]);
    expect(identities[0]?.name).toBe("Repo");
  });

  it("resolves relative remotes from the real source repository path", async () => {
    const root = createTempDir("outpost-source-link-");
    const realSource = path.join(root, "real", "source");
    const sourceLink = path.join(root, "source-link");
    const remote = path.join(root, "real", "remotes", "Repo.git");
    mkdirSync(realSource, { recursive: true });
    mkdirSync(path.dirname(remote), { recursive: true });
    await initBareGitRepo(remote);
    symlinkSync(realSource, sourceLink, "dir");

    const identity = await resolveIdentity("../remotes/Repo.git", sourceLink);

    expect(identity.id).toBe(localRepoId(remote));
    expect(identity.transportUrl).toBe(localTransportUrl(remote));
  });

  it("classifies Windows paths before SCP syntax and encodes portable segments", () => {
    expect(isWindowsLocalPath("C:\\work\\Repo.git", "win32")).toBe(true);
    expect(isWindowsLocalPath("\\\\server\\share\\Repo.git", "win32")).toBe(
      true,
    );
    expect(isWindowsLocalPath("git@example.com:Group/Repo.git", "win32")).toBe(
      false,
    );

    expect(encodeManagedPathSegment("example.com:8443")).toBe(
      "example.com%3A8443",
    );
    expect(encodeManagedPathSegment("C:")).toBe("%43%3A");
    expect(encodeManagedPathSegment("D:")).toBe("%44%3A");
    expect(encodeManagedPathSegment("CON")).toBe("%43%4F%4E");
    expect(encodeManagedPathSegment("repo.")).toBe("repo%2E");
    expect(getFileManagedPathSegments("file:///C:/work/Repo")).not.toEqual(
      getFileManagedPathSegments("file:///D:/work/Repo"),
    );
  });

  it("keeps case-distinct identities separate on case-insensitive filesystems", async () => {
    const upper = await resolveIdentity("https://example.com/Group/Repo.git");
    const lower = await resolveIdentity("https://example.com/group/repo.git");
    const upperPath = await Effect.runPromise(
      getManagedRepoPath("/tmp/repos", upper).pipe(
        Effect.provide(NodeContext.layer),
      ),
    );
    const lowerPath = await Effect.runPromise(
      getManagedRepoPath("/tmp/repos", lower).pipe(
        Effect.provide(NodeContext.layer),
      ),
    );

    expect(upperPath.toLowerCase()).not.toBe(lowerPath.toLowerCase());
  });

  it("distinguishes Windows drive paths from one-letter SCP hosts", () => {
    expect(isWindowsLocalPath("C:\\work\\Repo.git", "win32")).toBe(true);
    expect(isWindowsLocalPath("C:/work/Repo.git", "win32")).toBe(true);
    expect(isWindowsLocalPath("x:group/repo.git", "win32")).toBe(false);
    expect(isWindowsLocalPath("x:group/repo.git", "linux")).toBe(false);
  });
});
