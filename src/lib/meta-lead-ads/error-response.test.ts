import { afterEach, describe, expect, it, vi } from "vitest";

import { metaErrorResponse } from "./error-response";
import { MetaGraphError, MetaLeadAdsError } from "./errors";

describe("metaErrorResponse", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("maps a MetaLeadAdsError to its own status + code", async () => {
    const res = metaErrorResponse(
      new MetaLeadAdsError("needs_reauth", "Please reconnect.", 409),
    );
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      error: "Please reconnect.",
      code: "needs_reauth",
    });
  });

  it("maps a MetaGraphError (subclass) to its own status + code", async () => {
    const res = metaErrorResponse(
      new MetaGraphError({ code: "rate_limited", message: "Slow down.", status: 502 }),
    );
    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toEqual({
      error: "Slow down.",
      code: "rate_limited",
    });
  });

  it("collapses unclassified errors to a generic 500 (no leaked detail)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = metaErrorResponse(new Error("secret internal detail"));
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "Internal server error" });
  });
});
