import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

const token = () => randomBytes(32).toString("hex");
const equal = (a: string, b: string) =>
  Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export class RequestFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}
export class ManagerSession {
  private proof = token();
  private proofExpiry = Date.now() + 300000;
  private bearer = "";
  private created = 0;
  private touched = 0;
  private attempts = 0;
  constructor(
    readonly origin: string,
    private readonly now = () => Date.now()
  ) {}
  rotate() {
    this.proof = token();
    this.proofExpiry = this.now() + 300000;
    this.attempts = 0;
    return `${this.origin}/#pair=${this.proof}`;
  }
  pair(value: string) {
    if (
      ++this.attempts > 16 ||
      !this.proof ||
      this.now() > this.proofExpiry ||
      !equal(value, this.proof)
    )
      throw new RequestFailure(
        401,
        "pairing-invalid",
        "Pairing expired or unavailable. Request a new link in the terminal."
      );
    this.proof = "";
    this.bearer = token();
    this.created = this.touched = this.now();
    return { bearer: this.bearer, expiresAt: new Date(this.created + 7200000).toISOString() };
  }
  signOut() {
    this.bearer = "";
  }
  authenticate(value: string | undefined) {
    if (
      !this.bearer ||
      this.now() - this.created >= 7200000 ||
      this.now() - this.touched >= 1200000
    ) {
      this.signOut();
      throw new RequestFailure(401, "session-expired", "Pair again using the terminal link.");
    }
    if (!equal(value ?? "", `Bearer ${this.bearer}`))
      throw new RequestFailure(401, "session-expired", "Pair again using the terminal link.");
    this.touched = this.now();
  }
}
export function validateRequest(request: IncomingMessage, origin: string) {
  const expected = new URL(origin).host;
  const seen = new Set<string>();
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    const name = request.rawHeaders[i]!.toLowerCase();
    if (seen.has(name))
      throw new RequestFailure(400, "invalid-request", "Duplicate headers are unsupported.");
    seen.add(name);
    if (name === "forwarded" || name.startsWith("x-forwarded-"))
      throw new RequestFailure(400, "invalid-request", "Proxy headers are unsupported.");
  }
  const target = request.url ?? "";
  if (request.headers.host !== expected || request.socket.remoteAddress !== "127.0.0.1")
    throw new RequestFailure(403, "invalid-host", "Invalid local manager authority.");
  if (
    target.length > 2048 ||
    !target.startsWith("/") ||
    target.startsWith("//") ||
    target.includes("#") ||
    [...target].some(
      (character) =>
        character === "\\" || character.charCodeAt(0) <= 32 || character.charCodeAt(0) >= 127
    ) ||
    /%(?:2f|5c|2e|00)/i.test(target)
  )
    throw new RequestFailure(400, "invalid-target", "Invalid request target.");
  if (
    target
      .split("?")[0]!
      .split("/")
      .some((part) => part === "." || part === "..")
  )
    throw new RequestFailure(400, "invalid-target", "Invalid request target.");
  let url: URL;
  try {
    decodeURIComponent(target);
    url = new URL(target, origin);
  } catch {
    throw new RequestFailure(400, "invalid-target", "Invalid request target.");
  }
  if (url.pathname.split("/").some((part) => part === ".." || part === "."))
    throw new RequestFailure(400, "invalid-target", "Invalid request target.");
  const api = url.pathname.startsWith("/api/");
  if (request.method !== "GET" && request.method !== "POST")
    throw new RequestFailure(405, "invalid-method", "Unsupported request method.");
  if (api) {
    if (!url.pathname.startsWith("/api/v1/"))
      throw new RequestFailure(404, "unsupported-version", "Unknown manager API version.");
    if (request.headers["x-outpost-manager"] !== "1")
      throw new RequestFailure(403, "invalid-version", "Missing manager protocol header.");
    const received = request.headers.origin;
    if (
      (request.method === "POST" && received !== origin) ||
      (received !== undefined && received !== origin)
    )
      throw new RequestFailure(403, "invalid-origin", "Invalid manager origin.");
    const site = request.headers["sec-fetch-site"];
    if (site !== undefined && site !== "same-origin")
      throw new RequestFailure(403, "invalid-origin", "Invalid manager request context.");
  }
  if (
    request.method === "GET" &&
    (request.headers["content-length"] !== undefined ||
      request.headers["transfer-encoding"] !== undefined)
  )
    throw new RequestFailure(400, "invalid-body", "GET bodies are unsupported.");
  return { url, api };
}
export async function readJson(request: IncomingMessage, limit = 8192): Promise<unknown> {
  if (
    !/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers["content-type"] ?? "") ||
    request.headers["content-encoding"] !== undefined
  )
    throw new RequestFailure(415, "invalid-body", "JSON UTF-8 is required.");
  if (Number(request.headers["content-length"] ?? 0) > limit)
    throw new RequestFailure(413, "body-limit", "Request exceeds its byte limit.");
  const chunks: Buffer[] = [];
  let size = 0;
  const timeout = setTimeout(() => request.destroy(), 5000);
  timeout.unref();
  try {
    for await (const chunk of request) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > limit)
        throw new RequestFailure(413, "body-limit", "Request exceeds its byte limit.");
      chunks.push(bytes);
    }
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))
      ) as unknown;
    } catch {
      throw new RequestFailure(400, "invalid-body", "Invalid JSON UTF-8 body.");
    }
  } finally {
    clearTimeout(timeout);
  }
}
export const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cross-Origin-Opener-Policy": "same-origin",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
};
