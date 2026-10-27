import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  messages: [] as Array<Record<string, unknown>>,
  conversations: [] as Array<Record<string, unknown>>,
  convUpdate: [] as Array<Record<string, unknown>>,
  assignees: [] as Array<Record<string, unknown>>,
  profiles: [] as Array<Record<string, unknown>>,
  sentWhatsapp: [] as Array<Record<string, unknown>>,
  contactCalls: 0,
  conversationCalls: 0,
  failInsert: false,
  seq: 0,
}));

vi.mock("@/lib/whatsapp/meta-api", () => ({
  sendTemplateMessage: async (input: Record<string, unknown>) => {
    h.sentWhatsapp.push(input);
    return { messageId: "wamid-assign-1" };
  },
}));

vi.mock("@/lib/api/v1/contacts", () => ({
  findOrCreateContact: async () => {
    h.contactCalls += 1;
    return { id: "contact-sales-1", created: false };
  },
}));

vi.mock("@/lib/conversations/get-or-create", () => ({
  getOrCreateConversation: async () => {
    h.conversationCalls += 1;
    return { conversation: { id: "conv-sales-1" }, created: false };
  },
}));

type Filter = { col: string; op: string; val: unknown };

function fakeSupabase() {
  const state = { table: "", filters: [] as Filter[], updateObj: null as Record<string, unknown> | null, insertObj: null as Record<string, unknown> | null };
  const matched = (rows: Array<Record<string, unknown>>) =>
    rows.filter((r) => state.filters.every((f) => r[f.col] === f.val));
  const api: Record<string, unknown> = {
    select: () => api,
    eq: (col: string, val: unknown) => {
      state.filters.push({ col, op: "eq", val });
      return api;
    },
    limit: () => api,
    insert: (obj: Record<string, unknown>) => {
      state.insertObj = obj;
      return api;
    },
    update: (obj: Record<string, unknown>) => {
      state.updateObj = obj;
      return api;
    },
    maybeSingle: async () => {
      if (state.table === "messages") {
        const list = matched(h.messages);
        if (state.updateObj) {
          for (const r of list) Object.assign(r, state.updateObj);
          return { data: list[0] ?? null, error: null };
        }
        return { data: list[0] ?? null, error: null };
      }
      if (state.table === "lead_assignment_table_assignees") return { data: h.assignees[0] ?? null, error: null };
      if (state.table === "profiles") return { data: h.profiles[0] ?? null, error: null };
      if (state.table === "flow_runs") return { data: null, error: null };
      return { data: null, error: null };
    },
    single: async () => {
      if (state.table === "messages" && state.insertObj) {
        if (h.failInsert) return { data: null, error: { message: "db down" } };
        const row = { id: `msg-${++h.seq}`, ...state.insertObj };
        h.messages.push(row);
        return { data: row, error: null };
      }
      return { data: null, error: { message: "no row" } };
    },
    then: (resolve: (v: unknown) => void) => {
      if (state.table === "conversations" && state.updateObj) {
        h.convUpdate.push(state.updateObj);
        return resolve({ data: [], error: null });
      }
      return resolve({ data: [], error: null });
    },
  };
  return { from: (table: string) => {
    state.table = table;
    state.filters = [];
    state.updateObj = null;
    state.insertObj = null;
    return api;
  } };
}

import { persistAssignmentWhatsappToInbox } from "./table-notify";

beforeEach(() => {
  h.messages = [];
  h.conversations = [];
  h.convUpdate = [];
  h.assignees = [{ id: "assignee-1", display_name: "Asha Seller" }];
  h.profiles = [{ user_id: "u-1", account_id: "acct-1" }];
  h.sentWhatsapp = [];
  h.contactCalls = 0;
  h.conversationCalls = 0;
  h.failInsert = false;
  h.seq = 0;
});

describe("persistAssignmentWhatsappToInbox", () => {
  it("mirrors the salesperson alert into the salesperson thread with rendered text", async () => {
    const db = fakeSupabase();
    const res = await persistAssignmentWhatsappToInbox(db as never, {
      accountId: "acct-1",
      row: { assignee_id: "assignee-1", flow_run_id: "run-1", to_phone: "+15551234567" },
      template: { header_type: undefined, header_media_url: null, body_text: "Hi {{1}} lead {{2}}", name: "tpl" } as never,
      bodyValues: ["Mukesh", "+919876543210"],
      providerMessageId: "wamid-assign-1",
      salespersonPhone: "+15551234567",
    });
    expect(res?.messageId).toMatch(/^msg-/);
    expect(h.contactCalls).toBe(1);
    expect(h.conversationCalls).toBe(1);
    expect(h.messages).toHaveLength(1);
    expect(h.messages[0]).toMatchObject({
      conversation_id: "conv-sales-1",
      sender_type: "agent",
      content_type: "template",
      content_text: "Hi Mukesh lead +919876543210",
      template_name: "tpl",
      message_id: "wamid-assign-1",
      status: "sent",
    });
    expect(h.convUpdate[0]).toMatchObject({ last_message_text: "Hi Mukesh lead +919876543210" });
  });

  it("is idempotent on the same provider message id", async () => {
    const db = fakeSupabase();
    h.messages.push({ id: "msg-existing", conversation_id: "conv-sales-1", message_id: "wamid-assign-1" });
    const res = await persistAssignmentWhatsappToInbox(db as never, {
      accountId: "acct-1",
      row: { assignee_id: "assignee-1", to_phone: "+15551234567" },
      template: { body_text: "Hi {{1}}", name: "tpl" } as never,
      bodyValues: ["Asha"],
      providerMessageId: "wamid-assign-1",
      salespersonPhone: "+15551234567",
    });
    expect(res).toMatchObject({ messageId: "msg-existing" });
    expect(h.messages).toHaveLength(1);
  });

  it("persists template header media so the bubble can render it", async () => {
    const db = fakeSupabase();
    await persistAssignmentWhatsappToInbox(db as never, {
      accountId: "acct-1",
      row: { assignee_id: "assignee-1", to_phone: "+15551234567" },
      template: {
        header_type: "image",
        header_media_url: "https://cdn.test/hero.jpg",
        body_text: "Hi {{1}}",
        name: "tpl-media",
      } as never,
      bodyValues: ["Asha"],
      providerMessageId: "wamid-media-1",
      salespersonPhone: "+15551234567",
    });
    expect(h.messages[0]).toMatchObject({
      media_url: "https://cdn.test/hero.jpg",
      template_name: "tpl-media",
    });
    expect(typeof h.messages[0].media_mime_type).toBe("string");
  });

  it("never throws when persistence fails", async () => {
    const db = fakeSupabase();
    h.failInsert = true;
    const res = await persistAssignmentWhatsappToInbox(db as never, {
      accountId: "acct-1",
      row: { assignee_id: "assignee-1", to_phone: "+15551234567" },
      template: { body_text: "Hi", name: "tpl" } as never,
      bodyValues: [],
      providerMessageId: "wamid-x",
      salespersonPhone: "+15551234567",
    });
    expect(res).toBeNull();
  });
});
