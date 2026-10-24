import { readFileSync } from "node:fs";
import { NodeServices } from "@effect/platform-node";
import { Effect, Fiber } from "effect";
import * as ChildProcess from "effect/process/ChildProcess";
import { describe, expect, it, vi } from "vitest";
import { commandString, gitCommand } from "../src/child-process.ts";
import { createTempDir, existsSync, path, setupAfterEach } from "./helpers.ts";

setupAfterEach();

function pidAt(file: string) {
  return existsSync(file) ? Number(readFileSync(file, "utf8")) : undefined;
}
function running(pid: number | undefined) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    // A reparented grandchild may remain a zombie until the OS reaps it.
    // It no longer executes or holds any pipe descriptors.
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      if (stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z")) return false;
    }
    return true;
  } catch {
    return false;
  }
}
function kill(pid: number | undefined) {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    /* Group may already be gone. */
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* Child may already be reaped. */
  }
}

const stubborn = (pidFile: string) =>
  `process.on("SIGTERM",()=>{}); require("node:fs").writeFileSync(${JSON.stringify(pidFile)},String(process.pid)); setInterval(()=>{},1000)`;

describe("uncooperative process shutdown", () => {
  it.each(["timeout", "interruption", "git-descendant", "exited-leader", "pipeline"] as const)(
    "escalates %s and releases inherited pipes without relying on its watchdog",
    async (mode) => {
      const root = createTempDir("outpost-shutdown-");
      const pidFile = path.join(root, "stubborn.pid");
      const leaderFile = path.join(root, "leader.pid");
      const script = stubborn(pidFile);
      let command: ChildProcess.Command;
      if (mode === "git-descendant") {
        // The shell execs the stubborn child, preserving Git's process group and
        // inherited stdout/stderr. JSON quoting is encoded for POSIX sh.
        const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
        command = gitCommand(
          "-c",
          `alias.stubborn=!exec ${quote(process.execPath)} -e ${quote(script)}`,
          "stubborn"
        );
      } else if (mode === "pipeline") {
        command = ChildProcess.pipeTo(
          ChildProcess.make(process.execPath, ["-e", stubborn(leaderFile)]),
          ChildProcess.make(process.execPath, ["-e", script])
        );
      } else if (mode === "exited-leader") {
        command = ChildProcess.make(process.execPath, [
          "-e",
          `
        require("node:fs").writeFileSync(${JSON.stringify(leaderFile)},String(process.pid));
        const child = require("node:child_process").spawn(process.execPath,["-e",${JSON.stringify(script)}],{stdio:["ignore","inherit","inherit"]});
        child.unref();
      `,
        ]);
      } else {
        command = ChildProcess.make(process.execPath, ["-e", script]);
      }
      let watchdogTriggered = false;
      const watchdog = setTimeout(() => {
        watchdogTriggered = true;
        kill(pidAt(pidFile));
        kill(pidAt(leaderFile));
      }, 6_000);
      const startedAt = Date.now();
      try {
        if (mode === "interruption") {
          await Effect.runPromise(
            Effect.gen(function* () {
              const child = yield* Effect.forkChild(commandString(command, { timeoutMs: 10_000 }));
              yield* Effect.promise(() =>
                vi.waitFor(() => expect(existsSync(pidFile)).toBe(true), {
                  timeout: 3_000,
                  interval: 10,
                })
              );
              yield* Fiber.interrupt(child);
            }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
          );
        } else {
          await expect(
            Effect.runPromise(
              commandString(command, { timeoutMs: 1_000 }).pipe(Effect.provide(NodeServices.layer))
            )
          ).rejects.toThrow(/timed out after 1000ms/);
        }
        expect(existsSync(pidFile)).toBe(true);
        expect(watchdogTriggered).toBe(false);
        expect(Date.now() - startedAt).toBeLessThan(5_000);
        expect(running(pidAt(pidFile))).toBe(false);
        expect(running(pidAt(leaderFile))).toBe(false);
      } finally {
        clearTimeout(watchdog);
        kill(pidAt(pidFile));
        kill(pidAt(leaderFile));
      }
    },
    10_000
  );
});
