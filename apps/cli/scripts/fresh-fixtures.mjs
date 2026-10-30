import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { basename, dirname, join } from "node:path";

// Disposable loopback-only test service. No real provider or credential store.
export async function freshLoopback(bareRepository, directory) {
  const secret = "SYNTHETIC_FRESH_CREDENTIAL_49";
  const expected = `Basic ${Buffer.from(`fixture:${secret}`).toString("base64")}`;
  const children = new Set();
  let authenticated = 0;
  const helperLog = join(directory, "helper-actions");
  const helper = join(directory, "helper.mjs");
  const askpass = join(directory, "askpass.mjs");
  const askpassMarker = join(directory, "askpass-called");
  writeFileSync(
    helper,
    `import { appendFileSync } from 'node:fs';\nconst action=process.argv.at(-1);\nappendFileSync(${JSON.stringify(helperLog)},action+'\\n');\nprocess.stdin.resume();process.stdin.on('end',()=>{if(action==='get')process.stdout.write('username=fixture\\npassword=${secret}\\n\\n');});\n`
  );
  writeFileSync(
    askpass,
    `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(askpassMarker)},'called');process.exitCode=99;`
  );
  const server = createServer((request, response) => {
    if (request.headers.authorization !== expected) {
      response.writeHead(401, { "WWW-Authenticate": 'Basic realm="synthetic"' });
      response.end();
      return;
    }
    authenticated++;
    const url = new URL(request.url, "http://127.0.0.1");
    const child = spawn("git", ["http-backend"], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: dirname(bareRepository),
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: request.method,
        CONTENT_TYPE: request.headers["content-type"] ?? "",
        CONTENT_LENGTH: request.headers["content-length"] ?? "",
        REMOTE_USER: "fixture",
        SERVER_PROTOCOL: "HTTP/1.1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.add(child);
    const chunks = [];
    let length = 0;
    child.stdout.on("data", (chunk) => {
      length += chunk.length;
      if (length > 2 * 1024 * 1024) child.kill();
      else chunks.push(chunk);
    });
    child.stderr.resume();
    child.stdin.on("error", () => {});
    request.pipe(child.stdin);
    child.on("error", () => {
      response.writeHead(500);
      response.end();
    });
    child.on("close", () => {
      children.delete(child);
      if (response.writableEnded) return;
      const output = Buffer.concat(chunks);
      let index = output.indexOf("\r\n\r\n");
      let delimiter = 4;
      if (index < 0) {
        index = output.indexOf("\n\n");
        delimiter = 2;
      }
      if (index < 0) {
        response.writeHead(500);
        response.end();
        return;
      }
      let status = 200;
      for (const header of output.subarray(0, index).toString().split(/\r?\n/)) {
        const colon = header.indexOf(":");
        if (colon < 0) continue;
        const name = header.slice(0, colon);
        const value = header.slice(colon + 1).trim();
        if (name.toLowerCase() === "status") status = Number(value.split(" ")[0]);
        else response.setHeader(name, value);
      }
      response.writeHead(status);
      response.end(output.subarray(index + delimiter));
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}/${basename(bareRepository)}`,
    helperCommand: `!node "${helper.replaceAll("\\", "/")}"`,
    askpassCommand: `node "${askpass.replaceAll("\\", "/")}"`,
    helperLog,
    askpassMarker,
    get authenticated() {
      return authenticated;
    },
    close: async () => {
      for (const child of children) child.kill();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
