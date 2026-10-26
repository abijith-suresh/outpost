import { execFileSync } from "node:child_process";
import { realpathSync, symlinkSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { NodeServices } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { describe, expect, it } from "vitest";
import {
  administrativeNameBudget,
  sanitizedWorktreeName,
  validateWindowsCheckout,
  validateWindowsGitPath,
  validateWindowsGitPathLength,
  validateWindowsLocalTransport,
  validateWindowsManagedGitDir,
  validateWindowsWorktreePlan,
} from "../src/windows-git-path.ts";
import { createTempDir, mkdirSync, path, setupAfterEach, writeFileSync } from "./helpers.ts";

setupAfterEach();
const run = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(Effect.exit(effect));
const provided = <A, E>(
  effect: Effect.Effect<A, E, import("effect/FileSystem").FileSystem | import("effect/Path").Path>
) => run(effect.pipe(Effect.provide(NodeServices.layer)));
function rejection(exit: Exit.Exit<unknown, unknown>, ...messages: string[]) {
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit))
    for (const message of messages) expect(exit.cause.toString()).toContain(message);
}

describe("bounded Windows Git paths", () => {
  it("counts explicit GIT_DIR in UTF-8 bytes and cwd/admin directories in UTF-16 units", async () => {
    expect(Exit.isSuccess(await run(validateWindowsGitPathLength("a".repeat(220), "gitdir")))).toBe(
      true
    );
    rejection(
      await run(validateWindowsGitPathLength("a".repeat(221), "gitdir")),
      "221 UTF-8 bytes",
      "maximum 220",
      "shorter user-owned root"
    );
    expect(
      Exit.isSuccess(await run(validateWindowsGitPathLength(`${"界".repeat(73)}a`, "gitdir")))
    ).toBe(true);
    rejection(
      await run(validateWindowsGitPathLength("界".repeat(74), "gitdir")),
      "222 UTF-8 bytes"
    );
    for (const kind of ["cwd", "administrative-directory"] as const) {
      const maximum = kind === "cwd" ? 258 : 259;
      expect(
        Exit.isSuccess(
          await run(
            validateWindowsGitPathLength(`${"😀".repeat(129)}${maximum % 2 ? "a" : ""}`, kind)
          )
        )
      ).toBe(true);
      rejection(
        await run(validateWindowsGitPathLength("😀".repeat(130), kind)),
        "260 UTF-16 code units",
        `maximum ${maximum}`
      );
    }
  });

  it("accounts for checkout/.git and sanitized administrative names with collision suffixes", async () => {
    expect(sanitizedWorktreeName("space café..lock.lock")).toBe("space-café");
    expect(sanitizedWorktreeName("@")).toBe("-/@");
    expect(sanitizedWorktreeName("a@{b")).toBe("a@-b");
    expect(administrativeNameBudget("space café", 9)).toBe("space-café99");
    const outer = realpathSync.native(createTempDir());
    const checkout = path.join(outer, "a".repeat(217 - Buffer.byteLength(outer, "utf8") - 1));
    rejection(
      await provided(validateWindowsCheckout(checkout, "win32")),
      "222 UTF-8 bytes",
      ".git"
    );
    const tooLongName = "n".repeat(34);
    // Keep checkout within 220 bytes while forcing only the derived admin budget over.
    const paddedManaged = path.join(outer, "m".repeat(218 - Buffer.byteLength(outer, "utf8") - 1));
    mkdirSync(path.join(paddedManaged, "worktrees"), { recursive: true });
    for (let n = 0; n < 10; n++)
      writeFileSync(path.join(paddedManaged, "worktrees", `collision${n}`), "unowned");
    const shortCheckout = path.join(outer, tooLongName);
    rejection(
      await provided(validateWindowsWorktreePlan(paddedManaged, shortCheckout, "win32")),
      "administrative-directory",
      "maximum 259"
    );
  });

  it("checks real Unicode/space current directories at and beyond the native process budget", async () => {
    const outer = realpathSync.native(createTempDir());
    const prefix = path.join(outer, "界 café ");
    const near = `${prefix}${"a".repeat(258 - prefix.length)}`;
    mkdirSync(near);
    expect(realpathSync.native(near).length).toBe(258);
    expect(Exit.isSuccess(await provided(validateWindowsGitPath(near, "cwd", "win32")))).toBe(true);
    const bare = path.join(outer, "bare.git");
    execFileSync("git", ["init", "--bare", bare]);
    expect(
      execFileSync(
        "git",
        ["-c", "core.longpaths=true", "--git-dir", bare, "rev-parse", "--is-bare-repository"],
        { cwd: near, encoding: "utf8" }
      ).trim()
    ).toBe("true");
    const beyond = `${near}b`;
    mkdirSync(beyond);
    rejection(
      await provided(validateWindowsGitPath(beyond, "cwd", "win32")),
      "259 UTF-16 code units",
      "maximum 258"
    );
    rejection(
      await provided(validateWindowsLocalTransport(pathToFileURL(beyond).href, outer, "win32")),
      "259 UTF-16 code units",
      "maximum 258"
    );
    expect(
      Exit.isSuccess(
        await provided(
          validateWindowsLocalTransport("https://example.invalid/project.git", outer, "win32")
        )
      )
    ).toBe(true);
  });

  it("canonicalizes missing descendants through a space/Unicode junction before measuring", async () => {
    const outer = realpathSync.native(createTempDir());
    const target = path.join(outer, "canonical café ", "deep-".repeat(35));
    mkdirSync(target, { recursive: true });
    const alias = path.join(outer, "j");
    symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
    const candidate = path.join(alias, "missing.git");
    rejection(
      await provided(validateWindowsGitPath(candidate, "gitdir", "win32")),
      realpathSync.native(target),
      "UTF-8 bytes",
      "maximum 220"
    );
    // POSIX behavior remains unrestricted by the Windows-only contract.
    expect(
      Exit.isSuccess(await provided(validateWindowsGitPath(candidate, "gitdir", "linux")))
    ).toBe(true);
  });

  it("refuses a long literal Git directory even when its junction target is short", async () => {
    const outer = realpathSync.native(createTempDir());
    const target = path.join(outer, "short");
    mkdirSync(target);
    const alias = path.join(outer, "a".repeat(232 - Buffer.byteLength(outer, "utf8") - 1));
    symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
    expect(realpathSync.native(alias)).toBe(target);
    rejection(
      await provided(validateWindowsManagedGitDir(alias, "win32")),
      alias,
      "232 UTF-8 bytes",
      "maximum 220"
    );
    const raw = `${outer}${path.sep}${`a${path.sep}..${path.sep}`.repeat(100)}short`;
    expect(path.resolve(raw)).toBe(target);
    rejection(
      await provided(validateWindowsManagedGitDir(raw, "win32")),
      `${Buffer.byteLength(raw, "utf8")} UTF-8 bytes`,
      "maximum 220"
    );
  });

  it("counts the canonical administrative parent without following an occupied representative leaf", async () => {
    const outer = realpathSync.native(createTempDir());
    const managed = path.join(outer, "m".repeat(220 - Buffer.byteLength(outer, "utf8") - 1));
    const admin = path.join(managed, "worktrees");
    mkdirSync(admin, { recursive: true });
    const alias = path.join(outer, "alias");
    const short = path.join(outer, "short");
    mkdirSync(short);
    const kind = process.platform === "win32" ? "junction" : "dir";
    symlinkSync(managed, alias, kind);
    const name = "n".repeat(31);
    // K=1 reserves name9, whose existing junction must not shorten the free name.
    symlinkSync(short, path.join(admin, `${name}9`), kind);
    rejection(
      await provided(validateWindowsWorktreePlan(alias, path.join(outer, name), "win32")),
      "administrative-directory",
      "263 UTF-16 code units",
      "maximum 259"
    );
  });

  it("measures absent local transports without requiring their original source checkout", async () => {
    const outer = realpathSync.native(createTempDir());
    const source = path.join(outer, "removed source");
    const remote = path.join(outer, "missing café.git");
    for (const transport of [pathToFileURL(remote).href, remote, "../missing café.git"]) {
      expect(
        Exit.isSuccess(await provided(validateWindowsLocalTransport(transport, source, "win32")))
      ).toBe(true);
    }
  });
});
