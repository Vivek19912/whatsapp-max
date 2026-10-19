// Meta Lead Ads — OAuth connect route.
//
// Pins the start-of-flow security contract:
//   * only an admin can start the flow;
//   * the stored state is a hash bound to the caller's account/user;
//   * the browser receives the raw state in a same-site HttpOnly cookie;
//   * the authorization URL requests scopes but never secrets.

import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  accountId: "acct-1",
  userId: "user-1",
  inserts: [] as Array<{ table: string; payload: Record<string, unknown> }>,
  authCalls: 0,
}));

vi.mock("@/lib/auth/account", () => ({
  requireRole: async () => {
    h.authCalls += 1;
    return { accountId: h.accountId, userId: h.userId, supabase: {} };
  },
  toErrorResponse: (err: unknown) =>
    Response.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 },
    ),
}));

vi.mock("@/lib/flows/admin-client", () => ({
  supabaseAdmin: () => ({
    from: (table: string) => ({
      insert: async (payload: Record<string, unknown>) => {
        h.inserts.push({ table, payload });
        return { data: null, error: null };
      },
    }),
  }),
}));

const { GET } = await import("./route");

function request() {
  return new Request(
    "https://whatsappmax.in/api/integrations/meta-lead-ads/oauth/connect",
  );
}

beforeEach(() => {
  h.accountId = "acct-1";
  h.userId = "user-1";
  h.inserts = [];
  h.authCalls = 0;
  process.env.META_LEAD_ADS_APP_ID = "1831465341391155";
  process.env.META_LEAD_ADS_APP_SECRET = "platform-secret";
  process.env.META_LEAD_ADS_WEBHOOK_VERIFY_TOKEN = "verify";
  process.env.META_GRAPH_VERSION = "v26.0";
});

describe("GET /oauth/connect", () => {
  it("starts the flow with a hashed, account-bound state and a bound cookie", async () => {
    const res = await GET(request());

    expect([301, 302, 307]).toContain(res.status);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("https://www.facebook.com/v26.0/dialog/oauth");
    expect(location).toContain("client_id=1831465341391155");
    expect(location).toContain("ads_management");
    expect(location).not.toContain("platform-secret");

    const redirectState = new URL(location).searchParams.get("state") ?? "";
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("wacrm_meta_lead_oauth_state=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie.toLowerCase()).toContain("samesite=lax");
    expect(cookie).toContain("Path=/api/integrations/meta-lead-ads/oauth");
    expect(cookie).not.toContain("platform-secret");

    const cookieState = decodeURIComponent(
      (cookie.match(/wacrm_meta_lead_oauth_state=([^;]+)/) ?? [])[1] ?? "",
    );
    expect(cookieState).toBe(redirectState);
    expect(h.inserts).toHaveLength(1);
    expect(h.inserts[0]).toMatchObject({ table: "meta_lead_oauth_states" });
    const payload = h.inserts[0].payload;
    expect(payload).toMatchObject({ account_id: "acct-1", user_id: "user-1" });
    expect(payload.state_hash).toBe(
      crypto.createHash("sha256").update(redirectState, "utf8").digest("hex"),
    );
    expect(Date.parse(String(payload.expires_at))).toBeGreaterThan(Date.now());
  });
});
