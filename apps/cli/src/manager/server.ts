import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { ApplicationInvocation, type Invocation } from "../application/context.js";
import { RecordedFiles, RecordedInventory } from "../application/inventory.js";
import { ManagerOperations } from "./operations.js";
import {
  ManagerSession,
  RequestFailure,
  readJson,
  SECURITY_HEADERS,
  validateRequest,
} from "./security.js";
export type Asset = { bytes: Uint8Array; type: string };
/** Internal build-owned assets only. This map is never populated from a browser request. */
export async function createManager(
  context: Invocation,
  assets: ReadonlyMap<string, Asset>,
  port = 0
) {
  const inventory = new RecordedInventory(await RecordedFiles.open(context.home));
  const pinned = {
    ...context,
    home: inventory.files.home,
    environment: Object.freeze({ ...context.environment }),
  };
  const operations = new ManagerOperations(inventory, pinned);
  let origin = "";
  let session: ManagerSession;
  let draining = false;
  let requests = 0;
  const cursors = new Map<string, { section: string; offset: number; revision: string }>();
  const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provideService(ApplicationInvocation, pinned),
        Effect.provide(NodeServices.layer)
      ) as Effect.Effect<A, E>
    );
  let stopPromise: Promise<void> | undefined;
  const stop = () =>
    (stopPromise ??= (async () => {
      draining = true;
      await operations.drain();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeIdleConnections();
      });
    })());
  const server: Server = createServer(
    {
      maxHeaderSize: 8192,
      headersTimeout: 5000,
      requestTimeout: 5000,
      connectionsCheckingInterval: 1000,
    },
    async (request, response) => {
      for (const [key, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(key, value);
      const json = (status: number, value: unknown) => {
        const bytes = Buffer.from(JSON.stringify(value));
        if (bytes.length > 524288)
          throw new RequestFailure(413, "inspection-limit", "Response exceeds inspection limits.");
        response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
        response.end(bytes);
      };
      try {
        if (++requests > 16 || draining)
          throw new RequestFailure(503, "busy", "Manager is busy or stopping.");
        const { url, api } = validateRequest(request, origin);
        if (!api) {
          if (request.method !== "GET" || url.search)
            throw new RequestFailure(404, "not-found", "Unknown resource.");
          const asset = assets.get(url.pathname);
          if (!asset) throw new RequestFailure(404, "not-found", "Unknown resource.");
          response.writeHead(200, { "Content-Type": asset.type });
          response.end(asset.bytes);
          return;
        }
        const suffix = url.pathname.slice(8);
        if (suffix !== "snapshot" && url.search)
          throw new RequestFailure(400, "invalid-target", "Unsupported query.");
        if (suffix === "pair" && request.method === "POST") {
          const body = await readJson(request, 1024);
          if (
            typeof body !== "object" ||
            body === null ||
            Object.keys(body).join() !== "proof" ||
            !("proof" in body) ||
            typeof body.proof !== "string"
          )
            throw new RequestFailure(400, "invalid-input", "Invalid pairing proof.");
          json(200, { ok: true, data: session.pair(body.proof) });
          return;
        }
        session.authenticate(request.headers.authorization);
        if (suffix === "snapshot" && request.method === "GET") {
          for (const key of url.searchParams.keys())
            if (!["section", "cursor"].includes(key) || url.searchParams.getAll(key).length !== 1)
              throw new RequestFailure(400, "invalid-target", "Invalid snapshot query.");
          const section = url.searchParams.get("section");
          if (section !== "repositories" && section !== "workspaces")
            throw new RequestFailure(400, "invalid-input", "Select a recorded inventory section.");
          const data = await run(inventory.read());
          let offset = 0;
          const cursor = url.searchParams.get("cursor");
          if (cursor) {
            const next = cursors.get(cursor);
            if (!next || next.section !== section || next.revision !== data.revision)
              throw new RequestFailure(409, "stale-state", "Reload changed inventory.");
            offset = next.offset;
          }
          const rows = section === "repositories" ? data.repositories : data.workspaces;
          let nextCursor: string | null = null;
          if ([...cursors.values()].some((cursor) => cursor.revision !== data.revision))
            cursors.clear();
          if (offset + 50 < rows.length) {
            const existing = [...cursors].find(
              ([, value]) =>
                value.section === section &&
                value.offset === offset + 50 &&
                value.revision === data.revision
            );
            if (existing) nextCursor = existing[0];
            else {
              if (cursors.size >= 8192)
                throw new RequestFailure(
                  409,
                  "inspection-limit",
                  "Restart this manager after inspecting current actions."
                );
              nextCursor = randomUUID();
              cursors.set(nextCursor, { section, offset: offset + 50, revision: data.revision });
            }
          }
          json(200, {
            ok: true,
            data: {
              revision: data.revision,
              observedAt: data.observedAt,
              state: data.state,
              repositories:
                section === "repositories" ? data.repositories.slice(offset, offset + 50) : [],
              workspaces:
                section === "workspaces" ? data.workspaces.slice(offset, offset + 50) : [],
              nextCursor,
              ...("notice" in data ? { notice: data.notice } : {}),
            },
          });
          return;
        }
        const workspace = /^workspaces\/([0-9a-f-]{36})$/.exec(suffix);
        if (workspace && request.method === "GET") {
          json(200, { ok: true, data: await run(inventory.detail(workspace[1]!)) });
          return;
        }
        if (suffix === "settings" && request.method === "GET") {
          const data = await run(inventory.read());
          if (!data.config)
            throw new RequestFailure(
              409,
              "uninitialized",
              "Initialize this home explicitly with the CLI."
            );
          json(200, {
            ok: true,
            data: {
              revision: data.revision,
              worktreesRoot: data.config.worktreesRoot,
              extraInstructions: data.config.extraInstructions ?? "",
            },
          });
          return;
        }
        if (suffix === "operations" && request.method === "POST") {
          const extended = request.headers["x-outpost-body"];
          if (extended !== undefined && extended !== "instructions")
            throw new RequestFailure(400, "invalid-input", "Invalid request body class.");
          const body = await readJson(request, extended === "instructions" ? 98304 : 8192);
          if (
            extended === "instructions" &&
            (typeof body !== "object" ||
              body === null ||
              !("operation" in body) ||
              typeof body.operation !== "object" ||
              body.operation === null ||
              !("kind" in body.operation) ||
              body.operation.kind !== "set-instructions")
          )
            throw new RequestFailure(
              400,
              "invalid-input",
              "Instruction body class requires an instructions action."
            );
          json(202, { ok: true, data: await operations.submit(body) });
          return;
        }
        const operation = /^operations\/([0-9a-f-]{36})(\/cancel)?$/.exec(suffix);
        if (
          operation &&
          ((!operation[2] && request.method === "GET") ||
            (operation[2] && request.method === "POST"))
        ) {
          if (operation[2]) {
            const body = await readJson(request);
            if (JSON.stringify(body) !== "{}")
              throw new RequestFailure(400, "invalid-input", "Empty input required.");
          }
          json(200, {
            ok: true,
            data: operation[2] ? operations.cancel(operation[1]!) : operations.get(operation[1]!),
          });
          return;
        }
        if ((suffix === "sign-out" || suffix === "stop") && request.method === "POST") {
          const body = await readJson(request);
          if (JSON.stringify(body) !== "{}")
            throw new RequestFailure(400, "invalid-input", "Empty input required.");
          json(200, { ok: true, data: null });
          if (suffix === "sign-out") session.signOut();
          else void stop();
          return;
        }
        throw new RequestFailure(404, "not-found", "Unknown manager operation.");
      } catch (error) {
        if (!response.headersSent && !response.destroyed) {
          const failure =
            error instanceof RequestFailure
              ? error
              : new RequestFailure(
                  409,
                  "inspection-unavailable",
                  "Recorded state is unavailable or changed. Preserve files and inspect with the CLI."
                );
          json(failure.status, {
            ok: false,
            error: { code: failure.code, message: failure.message },
          });
        }
      } finally {
        requests--;
      }
    }
  );
  server.maxConnections = 32;
  server.keepAliveTimeout = 1000;
  server.on("upgrade", (_request, socket) => socket.destroy());
  server.on("connect", (_request, socket) => socket.destroy());
  server.on("clientError", (_error, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing manager listener");
  origin = `http://127.0.0.1:${address.port}`;
  session = new ManagerSession(origin);
  return { origin, pairingLink: () => session.rotate(), stop, server, operations };
}
