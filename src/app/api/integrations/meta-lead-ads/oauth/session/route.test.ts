// Meta Lead Ads — OAuth selection session route.
//
// The browser receives Page metadata only. Tokens are never returned.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  session: null as {
    id: string;
    account_id: string;
    user_id: string;
    access_token: string;
    expires_at: string;
    meta_user_name: string | null;
    scopes: string[];
    pages: Array<{ id: string; name: string | null; tasks: string[] }>;
  } | null,
}));

vi.mock("@/lib/auth/account", () => ({
  requireRole: async () => ({ accountId: "acct-1", userId: "user-1", supabase: {} }),
  toErrorResponse: (err: unknown) =>
    Response.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 },
    ),
}));

vi.mock("@/lib/flows/admin-client", () => ({
  supabaseAdmin: () => ({}),
}));

vi.mock("@/lib/meta-lead-ads/store", () => ({
  getOAuthSession: async () => h.session,
}));

const { GET } = await import("./route");

beforeEach(() => {
  h.session = null;
});

describe("GET /oauth/session", () => {
  it("returns inactive when there is no session", async () => {
    const json = (await (await GET()).json()) as Record<string, unknown>;
    expect(json).toEqual({ active: false });
  });

  it("returns Page metadata without the token", async () => {
    h.session = {
      id: "sess-1",
      account_id: "acct-1",
      user_id: "user-1",
      access_token: "session-user-token",
      expires_at: "2026-01-01T00:20:00Z",
      meta_user_name: "Olive",
      scopes: ["pages_show_list"],
      pages: [{ id: "P1", name: "One", tasks: ["MANAGE"] }],
    };

    const res = await GET();
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toMatchObject({
      active: true,
      userName: "Olive",
      pages: [{ pageId: "P1", pageName: "One", tasks: ["MANAGE"] }],
    });
    expect(JSON.stringify(json)).not.toContain("session-user-token");
    expect(JSON.stringify(json)).not.toContain("access_token");
  });
});
