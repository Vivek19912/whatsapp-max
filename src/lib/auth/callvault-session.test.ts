// ============================================================
// sessionIdFromJwt — pure JWT payload decode for CallVault
// session scoping. No I/O, no network, never logs the token.
// ============================================================

import { describe, expect, it } from "vitest";

import { sessionIdFromJwt } from "./callvault-session";

const SID = "11111111-2222-4333-8444-555555555555";

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function jwt(payload: unknown): string {
  return `eyJhbGciOiJIUzI1NiJ9.${b64url(payload)}.sig`;
}

describe("sessionIdFromJwt", () => {
  it("returns the session_id claim when it is a UUID", () => {
    expect(sessionIdFromJwt(jwt({ sub: "u-1", session_id: SID }))).toBe(SID);
  });

  it("returns null for opaque tokens, missing claims, and garbage", () => {
    expect(sessionIdFromJwt("opaque-token")).toBeNull();
    expect(sessionIdFromJwt("")).toBeNull();
    expect(sessionIdFromJwt(jwt({ sub: "u-1" }))).toBeNull();
    expect(sessionIdFromJwt(jwt({ session_id: "not-a-uuid" }))).toBeNull();
    expect(sessionIdFromJwt("a.b.c")).toBeNull();
  });
});
