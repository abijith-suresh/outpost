import type { IncomingMessage } from "node:http";
import { expect, it } from "vitest";
import { ManagerSession, validateRequest } from "../src/manager/security.js";

const origin = "http://127.0.0.1:12345";
const request = (values: Partial<IncomingMessage> = {}) =>
  ({
    url: "/api/v1/settings",
    method: "GET",
    rawHeaders: ["Host", "127.0.0.1:12345"],
    headers: { host: "127.0.0.1:12345", "x-outpost-manager": "1" },
    socket: { remoteAddress: "127.0.0.1" },
    ...values,
  }) as IncomingMessage;
it("consumes pairing once and revokes sessions on expiry or replacement", () => {
  let now = 1000;
  const auth = new ManagerSession(origin, () => now);
  const proof = new URL(auth.rotate()).hash.slice(6);
  const first = auth.pair(proof);
  auth.authenticate(`Bearer ${first.bearer}`);
  expect(() => auth.pair(proof)).toThrow();
  now += 1200000;
  expect(() => auth.authenticate(`Bearer ${first.bearer}`)).toThrow();
  const next = auth.pair(new URL(auth.rotate()).hash.slice(6));
  expect(next.bearer).not.toBe(first.bearer);
  expect(() => auth.authenticate(`Bearer ${first.bearer}`)).toThrow();
});
it("accepts authenticated browser GET origin absence, refuses foreign/null Origin and POST absence", () => {
  expect(validateRequest(request(), origin).api).toBe(true);
  for (const foreign of ["null", "http://127.0.0.1:9999", "https://attacker.invalid"])
    expect(() =>
      validateRequest(
        request({
          headers: { host: "127.0.0.1:12345", "x-outpost-manager": "1", origin: foreign },
        }),
        origin
      )
    ).toThrow();
  expect(() => validateRequest(request({ method: "POST" }), origin)).toThrow();
});
it("refuses authority, encoding, proxy and duplicate-header tricks before reading a body", () => {
  for (const url of [
    "//attacker.invalid/api/v1/settings",
    "http://attacker.invalid/",
    "/api/%2f/settings",
    "/api/%ZZ",
    "/api/\\x",
  ])
    expect(() => validateRequest(request({ url }), origin)).toThrow();
  expect(() =>
    validateRequest(
      request({ rawHeaders: ["Host", "127.0.0.1:12345", "host", "attacker.invalid"] }),
      origin
    )
  ).toThrow();
  expect(() =>
    validateRequest(request({ rawHeaders: ["Forwarded", "host=attacker.invalid"] }), origin)
  ).toThrow();
});
it("does not revoke a valid session when an unauthenticated caller guesses a bearer", () => {
  const auth = new ManagerSession(origin);
  const paired = auth.pair(new URL(auth.rotate()).hash.slice(6));
  expect(() => auth.authenticate("Bearer wrong")).toThrow();
  expect(() => auth.authenticate(`Bearer ${paired.bearer}`)).not.toThrow();
});
