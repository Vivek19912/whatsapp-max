import { beforeEach, describe, expect, it, vi } from "vitest";

// Regression: a reminder sends through ITS CREATOR's fallback template
// (personal first, account default as back-compat fallback) — never
// another agent's configuration.

const h = vi.hoisted(() => ({
  profiles: {
    "user-A": { reminder_template_name: "agent_a_tpl", reminder_template_language: "en_US" },
    "user-B": { reminder_template_name: "agent_b_tpl", reminder_template_language: "en_US" },
  } as Record<string, Record<string, unknown>>,
  accountRow: { reminder_template_name: "acct_default", reminder_template_language: "en_US" },
  templates: {
    "agent_a_tpl|||en_US": { name: "agent_a_tpl", language: "en_US", status: "APPROVED", body_text: "A {{1}}" },
    "agent_b_tpl|||en_US": { name: "agent_b_tpl", language: "en_US", status: "APPROVED", body_text: "B {{1}}" },
    "acct_default|||en_US": { name: "acct_default", language: "en_US", status: "APPROVED", body_text: "D {{1}}" },
  } as Record<string, Record<string, unknown>>,
  sent: [] as Array<{ templateName: string; language: string }>,
}));

vi.mock("@/lib/whatsapp/encryption", () => ({
  decrypt: (v: string) => v,
}));

vi.mock("@/lib/whatsapp/meta-api", () => ({
  sendTemplateMessage: async (args: { templateName: string; language: string }) => {
    h.sent.push({ templateName: args.templateName, language: args.language });
    return { messageId: "wamid-1" };
  },
  sendTextMessage: async () => ({ messageId: "wamid-text" }),
}));

function fakeDb() {
  const state = { table: "", filters: [] as Array<[string, unknown]> };
  const api: Record<string, unknown> = {
    select: () => api,
    eq: (col: string, val: unknown) => {
      state.filters.push([col, val]);
      return api;
    },
    maybeSingle: async () => {
      if (state.table === "profiles") {
        const uid = state.filters.find(([c]) => c === "user_id")?.[1] as string;
        return { data: { ...(h.profiles[uid] ?? {}) }, error: null };
      }
      if (state.table === "accounts") return { data: { ...h.accountRow }, error: null };
      if (state.table === "message_templates") {
        const name = state.filters.find(([c]) => c === "name")?.[1];
        const lang = state.filters.find(([c]) => c === "language")?.[1];
        const row = h.templates[`${name}|||${lang}`] ?? null;
        return { data: row ? { ...row } : null, error: null };
      }
      if (state.table === "whatsapp_config") {
        return { data: { phone_number_id: "pn-1", access_token: "tok" }, error: null };
      }
      return { data: null, error: null };
    },
  };
  return { from: (table: string) => { state.table = table; state.filters = []; return api; } };
}

const { sendReminderViaTemplate } = await import("./reminder-send");

beforeEach(() => {
  h.profiles = {
    "user-A": { reminder_template_name: "agent_a_tpl", reminder_template_language: "en_US" },
    "user-B": { reminder_template_name: "agent_b_tpl", reminder_template_language: "en_US" },
  };
  h.accountRow = { reminder_template_name: "acct_default", reminder_template_language: "en_US" };
  h.sent = [];
});

describe("sendReminderViaTemplate agent resolution", () => {
  it("Agent A's reminder uses Agent A's template", async () => {
    const res = await sendReminderViaTemplate(
      fakeDb() as never,
      "acct-1",
      { to: "919876543210", text: "hello" },
      "user-A",
    );
    expect(res.templateName).toBe("agent_a_tpl");
    expect(h.sent).toEqual([{ templateName: "agent_a_tpl", language: "en_US" }]);
  });

  it("Agent B's reminder uses Agent B's template (never A's)", async () => {
    const res = await sendReminderViaTemplate(
      fakeDb() as never,
      "acct-1",
      { to: "919876543210", text: "hello" },
      "user-B",
    );
    expect(res.templateName).toBe("agent_b_tpl");
  });

  it("falls back to the account default when the creator has no personal setting", async () => {
    h.profiles["user-A"] = { reminder_template_name: null, reminder_template_language: null };
    const res = await sendReminderViaTemplate(
      fakeDb() as never,
      "acct-1",
      { to: "919876543210", text: "hello" },
      "user-A",
    );
    expect(res.templateName).toBe("acct_default");
  });

  it("keeps approved-template validation (missing template row fails closed)", async () => {
    h.profiles["user-A"] = { reminder_template_name: "ghost_tpl", reminder_template_language: "en_US" };
    await expect(
      sendReminderViaTemplate(fakeDb() as never, "acct-1", { to: "919876543210", text: "hello" }, "user-A"),
    ).rejects.toMatchObject({ code: "template_missing" });
  });
});
