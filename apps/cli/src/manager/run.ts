import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as ChildProcess from "effect/process/ChildProcess";
import { commandResult } from "../child-process.js";
import { parseCommandInput, requireCommand } from "../command-spec.js";
import { ASSET_FILES } from "./asset-map.js";
import { type Asset, createManager } from "./server.js";

async function loadAssets() {
  const root = await fs.realpath(fileURLToPath(new URL("./", import.meta.url)));
  const assets = new Map<string, Asset>();
  let size = 0;
  for (const item of ASSET_FILES) {
    if (item.path !== "index.html" && !/^assets\/[A-Za-z0-9_-]+\.(?:js|css|woff2)$/.test(item.path))
      throw new Error("Invalid bundled asset");
    const target = path.join(root, item.path);
    const stat = await fs.lstat(target);
    size += stat.size;
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (await fs.realpath(target)) !== target ||
      stat.size > 2 * 1048576 ||
      size > 4 * 1048576
    )
      throw new Error("Invalid bundled asset");
    const bytes = await fs.readFile(target);
    if (createHash("sha256").update(bytes).digest("hex") !== item.sha256)
      throw new Error("Invalid bundled asset");
    assets.set(item.path === "index.html" ? "/" : `/${item.path}`, { bytes, type: item.type });
  }
  if (!assets.has("/")) throw new Error("Missing bundled assets");
  return assets;
}
export async function runManager(argv: readonly string[]): Promise<number> {
  let manager: Awaited<ReturnType<typeof createManager>> | undefined;
  let readline: ReturnType<typeof createInterface> | undefined;
  const stop = () => {
    void manager?.stop().catch(() => {});
  };
  try {
    if (argv.includes("--json"))
      throw new Error("Foreground management does not support JSON output");
    const parsed = parseCommandInput(requireCommand(["manage"]), argv.slice(1));
    const values = parsed.options["--port"];
    const port = Array.isArray(values) ? Number(values[0]) : 0;
    if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error("Invalid port");
    const environment = Object.freeze({ ...process.env });
    const cwd = process.cwd();
    const home = path.resolve(
      environment.OUTPOST_HOME ??
        path.join(environment.HOME ?? environment.USERPROFILE ?? cwd, ".outpost")
    );
    manager = await createManager({ home, cwd, environment }, await loadAssets(), port);
    const link = manager.pairingLink();
    console.log(
      `Outpost manager: ${link}\nCtrl+C stops this manager. Enter p for a new pairing link.`
    );
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    if (process.stdin.isTTY) {
      readline = createInterface({ input: process.stdin, output: process.stdout });
      readline.on("line", (line) => {
        if (line.trim() === "p") console.log(manager!.pairingLink());
      });
      readline.on("SIGINT", stop);
    }
    if (parsed.options["--open"]) {
      const command =
        process.platform === "win32"
          ? ChildProcess.make("rundll32.exe", ["url.dll,FileProtocolHandler", link])
          : process.platform === "darwin"
            ? ChildProcess.make("open", [link])
            : ChildProcess.make("xdg-open", [link]);
      const opened = await Effect.runPromise(
        commandResult(command, { timeoutMs: 5000, maxOutputBytes: 1024 }).pipe(
          Effect.provide(NodeServices.layer)
        )
      ).catch(() => null);
      if (!opened || opened.exitCode !== 0)
        console.error(
          "Browser opening failed. Use the printed pairing link; the manager is still running."
        );
    }
    if (manager.server.listening)
      await new Promise<void>((resolve) => manager!.server.once("close", resolve));
    return 0;
  } catch {
    console.error(
      "Manager could not start. Check arguments, bundled assets, selected home and local port; existing state is preserved."
    );
    return 1;
  } finally {
    readline?.close();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await manager?.stop().catch(() => {});
  }
}
