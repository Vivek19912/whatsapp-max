// Meta Lead Ads — Graph error classification.
//
// Regression for the production false positive where a valid token was
// marked "needs attention" after a lead import: Meta returns
// `type: "OAuthException"` for `#100` invalid-field errors (and `#200`
// permission errors). Only the Graph CODE may decide that a credential
// is invalid.

import { describe, expect, it } from "vitest";

import {
  describeMetaGraphError,
  isAuthGraphError,
  MetaGraphError,
} from "./errors";

function graphError(args: {
  code?: number;
  type?: string;
  status?: number;
  message?: string;
}): MetaGraphError {
  return new MetaGraphError({
    message: args.message ?? "Meta error",
    graphStatus: args.status ?? 400,
    graphType: args.type,
    graphCode: args.code,
  });
}

describe("isAuthGraphError — only a definitive token rejection is auth", () => {
  it("does NOT treat #100 invalid-field errors as auth, even as OAuthException", () => {
    const err = graphError({
      code: 100,
      type: "OAuthException",
      message: "(#100) Tried accessing nonexisting field (page_id)",
    });
    expect(isAuthGraphError(err)).toBe(false);
  });

  it("does NOT treat #200 permission errors as auth", () => {
    const err = graphError({
      code: 200,
      type: "OAuthException",
      message: "(#200) Requires leads_retrieval permission",
    });
    expect(isAuthGraphError(err)).toBe(false);
  });

  it("does NOT treat an appsecret_proof mismatch (code 1) as auth", () => {
    const err = graphError({
      code: 1,
      type: "OAuthException",
      message: "Invalid appsecret_proof provided in the API argument",
    });
    expect(isAuthGraphError(err)).toBe(false);
  });

  it("treats #190 as a dead token", () => {
    expect(isAuthGraphError(graphError({ code: 190, type: "OAuthException" }))).toBe(
      true,
    );
  });

  it("treats #102 and #463 as dead tokens", () => {
    expect(isAuthGraphError(graphError({ code: 102 }))).toBe(true);
    expect(isAuthGraphError(graphError({ code: 463 }))).toBe(true);
  });

  it("treats an OAuthException/401 with no Graph code as auth", () => {
    expect(isAuthGraphError(graphError({ type: "OAuthException" }))).toBe(true);
    expect(isAuthGraphError(graphError({ status: 401 }))).toBe(true);
  });

  it("does NOT treat a network failure or a 5xx as auth", () => {
    expect(
      isAuthGraphError(
        new MetaGraphError({ message: "Could not reach the Meta Graph API." }),
      ),
    ).toBe(false);
    expect(isAuthGraphError(graphError({ status: 502 }))).toBe(false);
  });
});

describe("describeMetaGraphError", () => {
  it("describes #100 as an endpoint/field problem, not a dead token", () => {
    const text = describeMetaGraphError(
      graphError({
        code: 100,
        type: "OAuthException",
        message: "(#100) Tried accessing nonexisting field (page_id)",
      }),
    );
    expect(text).not.toMatch(/rejected the access token/i);
    expect(text).toMatch(/page_id/);
    expect(text).toMatch(/not valid for this endpoint/i);
    expect(text).toMatch(/not a token problem/i);
  });

  it("describes #200 as a permission problem, not a dead token", () => {
    const text = describeMetaGraphError(
      graphError({ code: 200, type: "OAuthException" }),
    );
    expect(text).not.toMatch(/rejected the access token/i);
    expect(text).toMatch(/not authorized/i);
  });

  it("describes #190 as a rejected token", () => {
    expect(describeMetaGraphError(graphError({ code: 190 }))).toMatch(
      /rejected the access token/i,
    );
  });
});
