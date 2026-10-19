// Meta Lead Ads — automatic sync cron route.
//
// Pins the production regression: new leads must arrive without a user
// opening Settings or clicking Import. The scheduler authenticates with
// the shared cron secret, sweeps retries, and always runs the polling
// pass even when the retry sweep fails.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  config: {
    appId: "1",
    appSecret: "secret",
    webhookVerifyToken: "verify",
    graphVersion: "v21.0",
  } as Record<string, string> | null,
  retryCalls: 0,
  pollCalls: 0,
  retryError: null as Error | null,
  pollError: null as Error | null,
  retryResult: { attempted: 2, processed: 1, failed: 1, skipped: 0 },
  syncResult: {
    forms: 1,
    imported: 0,
    received: 1,
    processed: 1,
    failed: 0,
    errors: 0,
  },
}));

vi.mock("@/lib/flows/admin-client", () => ({
  supabaseAdmin: () => ({}),
}));

vi.mock("@/lib/meta-lead-ads/config", () => ({
  metaLeadAdsConfig: () => h.config,
}));

vi.mock("@/lib/meta-lead-ads/process-lead", () => ({
  runDueRetries: async () => {
    h.retryCalls += 1;
    if (h.retryError) throw h.retryError;
    return h.retryResult;
  },
}));

vi.mock("@/lib/meta-lead-ads/sync", () => ({
  POLL_DEFAULT_LIMIT: 20,
  runLeadPolls: async () => {
    h.pollCalls += 1;
    if (h.pollError) throw h.pollError;
    return h.syncResult;
  },
}));

const { GET } = await import("./route");

function request(headers: Record<string, string> = {}) {
  return new Request(
    "http://localhost/api/integrations/meta-lead-ads/cron",
    { headers },
  );
}

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", "cron-secret");
  vi.stubEnv("AUTOMATION_CRON_SECRET", "automation-secret");
  h.config = {
    appId: "1",
    appSecret: "secret",
    webhookVerifyToken: "verify",
    graphVersion: "v21.0",
  };
  h.retryCalls = 0;
  h.pollCalls = 0;
  h.retryError = null;
  h.pollError = null;
  h.retryResult = { attempted: 2, processed: 1, failed: 1, skipped: 0 };
  h.syncResult = {
    forms: 1,
    imported: 0,
    received: 1,
    processed: 1,
    failed: 0,
    errors: 0,
  };
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/integrations/meta-lead-ads/cron", () => {
  it("rejects a missing or wrong secret without polling", async () => {
    const missing = await GET(request());
    expect(missing.status).toBe(401);

    const wrong = await GET(request({ "x-cron-secret": "nope" }));
    expect(wrong.status).toBe(401);

    expect(h.retryCalls).toBe(0);
    expect(h.pollCalls).toBe(0);
  });

  it("runs retries and the polling sweep with x-cron-secret", async () => {
    const res = await GET(
      request({ "x-cron-secret": "automation-secret" }),
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(h.retryCalls).toBe(1);
    expect(h.pollCalls).toBe(1);
    expect(body).toMatchObject({
      attempted: 2,
      processed: 1,
      failed: 1,
      skipped: 0,
      sync: { forms: 1, received: 1, processed: 1, errors: 0 },
    });
  });

  it("accepts the Vercel-style Authorization: Bearer secret", async () => {
    const res = await GET(
      request({ authorization: "Bearer cron-secret" }),
    );

    expect(res.status).toBe(200);
    expect(h.pollCalls).toBe(1);
  });

  it("returns 503 when no cron secret is configured", async () => {
    vi.stubEnv("CRON_SECRET", "");
    vi.stubEnv("AUTOMATION_CRON_SECRET", "");

    const res = await GET(request({ "x-cron-secret": "anything" }));

    expect(res.status).toBe(503);
    expect(h.pollCalls).toBe(0);
  });

  it("returns 503 when Meta Lead Ads is not configured", async () => {
    h.config = null;

    const res = await GET(request({ "x-cron-secret": "cron-secret" }));

    expect(res.status).toBe(503);
    expect(h.pollCalls).toBe(0);
  });

  it("still polls when the retry sweep fails", async () => {
    h.retryError = new Error("retry table unavailable");

    const res = await GET(request({ "x-cron-secret": "cron-secret" }));
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(h.pollCalls).toBe(1);
    expect(body.retryError).toContain("retry table unavailable");
    expect(body.sync).toMatchObject({ received: 1 });
  });

  it("returns 500 only when the polling sweep itself cannot start", async () => {
    h.pollError = new Error("database unavailable");

    const res = await GET(request({ "x-cron-secret": "cron-secret" }));

    expect(res.status).toBe(500);
  });
});
