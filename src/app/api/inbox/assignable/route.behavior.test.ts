import { beforeEach, describe, expect, it, vi } from "vitest";

// Behavioral contract for GET /api/inbox/assignable: the cross-thread
// assignment roster. Only owners/admins and agents holding Manage
// Assignments may list it; rows carry identity + assignee only —
// never messages, media, or contact details beyond name/phone.

const CONVS = [
  {
    id: "conv-1",
    assigned_agent_id: "agent-1",
    last_message_at: "2026-01-01T00:00:00Z",
    contact: { id: "ct-1", name: "Rahul", phone: "+911234567890" },
  },
  {
    id: "conv-2",
    assigned_agent_id: null,
    last_message_at: "2026-01-02T00:00:00Z",
    contact: { id: "ct-2", name: "Priya", phone: "+911234567891" },
  },
];

let role = "owner";
let viewerCaps = { canViewAll: false, canManageAssignments: false };

function tableChain(table: string) {
  const terminal = async () => {
    if (table === "agent_inbox_permissions") {
      return {
        data: { can_manage_assignments: viewerCaps.canManageAssignments, can_view_all: viewerCaps.canViewAll },
        error: null,
      };
    }
    if (table === "conversations") return { data: CONVS, error: null };
    return { data: [], error: null };
  };
  const b: Record<string, (...args: never[]) => unknown> = {};
  const chain = (): Record<string, (...args: never[]) => unknown> => b;
  for (const m of ["select", "eq", "order", "limit", "update", "delete", "insert", "maybeSingle", "single"])
    b[m] = (() => {
      if (m === "maybeSingle" || m === "single") return terminal();
      return chain();
    }) as (...args: never[]) => unknown;
  b.then = ((resolve: (v: unknown) => unknown) => resolve(terminal())) as (...args: never[]) => unknown;
  return b;
}

const adminDb = { from: vi.fn((t: string) => tableChain(t)) };

vi.mock("@/lib/auth/account", () => ({
  requireRole: vi.fn(async () => ({
    accountId: "acc-1",
    userId: "caller-1",
    role,
    supabase: adminDb,
  })),
  toErrorResponse: (err: unknown) => {
    const status = (err as { status?: number }).status ?? 500;
    return Response.json({ error: (err as Error).message }, { status });
  },
}));

vi.mock("@/lib/flows/admin-client", () => ({
  supabaseAdmin: () => adminDb,
}));

import { GET } from "./route";

function get() {
  return GET(new Request("http://localhost/api/inbox/assignable?limit=25"));
}

describe("GET /api/inbox/assignable", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    role = "owner";
    viewerCaps = { canViewAll: false, canManageAssignments: false };
  });

  it("owner sees every thread with identity + assignee only", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const json = (await res.json()) as { conversations: Array<Record<string, unknown>> };
    expect(json.conversations).toHaveLength(2);
    expect(Object.keys(json.conversations[0]).sort()).toEqual(
      ["assigned_agent_id", "contact", "id", "last_message_at"].sort()
    );
    expect(JSON.stringify(json)).not.toContain("content_text");
    expect(JSON.stringify(json)).not.toContain("media_url");
  });

  it("manage-only agent lists threads they cannot open", async () => {
    role = "agent";
    viewerCaps = { canViewAll: false, canManageAssignments: true };
    const res = await get();
    expect(res.status).toBe(200);
    const json = (await res.json()) as { conversations: unknown[] };
    expect(json.conversations).toHaveLength(2);
  });

  it("plain agent without grants is denied (no cross-thread roster)", async () => {
    role = "agent";
    viewerCaps = { canViewAll: false, canManageAssignments: false };
    const res = await get();
    expect(res.status).toBe(403);
  });

  it("viewers are denied the assignment roster", async () => {
    role = "viewer";
    const res = await get();
    expect(res.status).toBe(403);
  });
});
