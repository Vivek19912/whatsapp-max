// Meta #132018 regression: template body parameters must not contain
// newlines/tabs/4+ spaces. Normalization applies ONLY to the template
// fallback path; free-text sends keep original line breaks.
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  normalizeTemplateTextParam,
  sendReminderToAgent,
  sendReminderViaTemplate,
} from "./reminder-send";

const h = vi.hoisted(() => ({
  textCalls: [] as Array<Record<string, unknown>>,
  templateCalls: [] as Array<Record<string, unknown>>,
  accounts: [] as Array<Record<string, unknown>>,
  templates: [] as Array<Record<string, unknown>>,
  configs: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/whatsapp/encryption", () => ({
  decrypt: (ciphertext: string) => `decrypted(${ciphertext})`,
  encrypt: (s: string) => s,
  isLegacyFormat: () => false,
}));

vi.mock("@/lib/whatsapp/meta-api", () => ({
  sendTextMessage: async (args: Record<string, unknown>) => {
    h.textCalls.push(args);
    return { messageId: "wamid-text-1" };
  },
  sendTemplateMessage: async (args: Record<string, unknown>) => {
    h.templateCalls.push(args);
    // Simulate Meta #132018 enforcement on the body parameter.
    const body = (
      args.messageParams as { body?: string[] } | undefined
    )?.body?.[0] as string | undefined;
    if (
      body !== undefined &&
      (/[\r\n\t\v\f\u2028\u2029]/.test(body) || / {4,}/.test(body))
    ) {
      throw new Error(
        "(#132018) Param text cannot have new-line/tab characters or more than 4 consecutive spaces.",
      );
    }
    return { messageId: "wamid-tpl-1" };
  },
}));

function fakeDb() {
  const api: Record<string, unknown> = {};
  api.from = (table: string) => {
    const store = (): Array<Record<string, unknown>> => {
      if (table === "accounts") return h.accounts;
      if (table === "message_templates") return h.templates;
      if (table === "whatsapp_config") return h.configs;
      return [];
    };
    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.eq = () => q;
    q.maybeSingle = async () => ({ data: store()[0] ?? null, error: null });
    return q;
  };
  return api;
}

const MULTILINE =
  "Follow up with Rushikesh S More\nPhone: 919130287749\n\nRemember to contact this lead at the scheduled time.";

beforeEach(() => {
  h.textCalls = [];
  h.templateCalls = [];
  h.accounts = [
    { reminder_template_name: "reminder_fallback", reminder_template_language: "en_US" },
  ];
  h.templates = [
    {
      account_id: "acct-1",
      name: "reminder_fallback",
      language: "en_US",
      status: "APPROVED",
      body_text: "Reminder: {{1}}",
      header_type: null,
      header_content: null,
      buttons: [],
    },
  ];
  h.configs = [{ phone_number_id: "pn-1", access_token: "enc" }];
});

describe("normalizeTemplateTextParam", () => {
  it("1. flattens multiline reminder messages to one line", () => {
    expect(normalizeTemplateTextParam(MULTILINE)).toBe(
      "Follow up with Rushikesh S More Phone: 919130287749 Remember to contact this lead at the scheduled time.",
    );
  });

  it("2. handles Windows-style CRLF line endings", () => {
    expect(normalizeTemplateTextParam("Line one\r\nLine two\r\n\r\nLine three")).toBe(
      "Line one Line two Line three",
    );
  });

  it("3. replaces tabs with spaces", () => {
    expect(normalizeTemplateTextParam("Name:\tRushikesh\tMore")).toBe(
      "Name: Rushikesh More",
    );
  });

  it("4. collapses more than four consecutive spaces", () => {
    expect(normalizeTemplateTextParam("Hello     world      again")).toBe(
      "Hello world again",
    );
  });

  it("5. preserves emojis and Indian phone numbers", () => {
    expect(normalizeTemplateTextParam("🙏 Call\n98765 43210\nThanks! 🎉")).toBe(
      "🙏 Call 98765 43210 Thanks! 🎉",
    );
  });

  it("6. trims and rejects empty/whitespace-only input", () => {
    expect(normalizeTemplateTextParam("   \n\t  ")).toBe("");
    expect(normalizeTemplateTextParam("  padded  ")).toBe("padded");
  });

  it("standalone carriage returns become spaces", () => {
    expect(normalizeTemplateTextParam("Line one\rLine two\r\rLine three")).toBe(
      "Line one Line two Line three",
    );
  });

  it("unicode line/paragraph separators become spaces", () => {
    expect(normalizeTemplateTextParam("First\u2028Second\u2029Third")).toBe(
      "First Second Third",
    );
  });

  it("non-breaking spaces collapse to ordinary spaces", () => {
    expect(normalizeTemplateTextParam("Hello\u00a0\u00a0world")).toBe("Hello world");
  });

  it("multiple paragraphs become one clean line", () => {
    expect(
      normalizeTemplateTextParam("Para one.\n\nPara two.\r\n\r\nPara three.\n\t- item"),
    ).toBe("Para one. Para two. Para three. - item");
  });

  it("exact production failure example normalizes to the expected parameter", () => {
    const original =
      "Follow up with I am Animation creator\n\nPhone: 916296413616\n\nRemember to contact this lead at the scheduled time.";
    expect(normalizeTemplateTextParam(original)).toBe(
      "Follow up with I am Animation creator Phone: 916296413616 Remember to contact this lead at the scheduled time.",
    );
  });
});

describe("reminder send paths (#132018)", () => {
  it("7. normal free-text delivery preserves original line breaks", async () => {
    await sendReminderToAgent(fakeDb() as never, "acct-1", {
      to: "919876543210",
      text: MULTILINE,
    });
    expect(h.textCalls).toHaveLength(1);
    expect(h.textCalls[0]).toMatchObject({ to: "919876543210", text: MULTILINE });
  });

  it("8. template fallback sends the normalized single-line parameter", async () => {
    const res = await sendReminderViaTemplate(fakeDb() as never, "acct-1", {
      to: "919876543210",
      text: MULTILINE,
    });
    expect(res).toMatchObject({ via: "template", whatsappMessageId: "wamid-tpl-1" });
    expect(h.templateCalls).toHaveLength(1);
    const params = h.templateCalls[0].messageParams as { body: string[] };
    expect(params.body).toEqual([
      "Follow up with Rushikesh S More Phone: 919130287749 Remember to contact this lead at the scheduled time.",
    ]);
    // Would have thrown #132018 via the mock if newlines survived.
  });

  it("whitespace-only text is rejected on the template path", async () => {
    await expect(
      sendReminderViaTemplate(fakeDb() as never, "acct-1", {
        to: "919876543210",
        text: "   \n\t  ",
      }),
    ).rejects.toMatchObject({ code: "bad_request" });
    expect(h.templateCalls).toHaveLength(0);
  });

  it("empty text is rejected on the template path", async () => {
    await expect(
      sendReminderViaTemplate(fakeDb() as never, "acct-1", { to: "919876543210", text: "" }),
    ).rejects.toMatchObject({ code: "bad_request" });
    expect(h.templateCalls).toHaveLength(0);
  });

  it("production example sends end-to-end with exact template structure", async () => {
    const original =
      "Follow up with I am Animation creator\n\nPhone: 916296413616\n\nRemember to contact this lead at the scheduled time.";
    const res = await sendReminderViaTemplate(fakeDb() as never, "acct-1", {
      to: "919130287749",
      text: original,
    });
    expect(res).toMatchObject({
      via: "template",
      templateName: "reminder_fallback",
      templateLanguage: "en_US",
      phoneNumberId: "pn-1",
      whatsappMessageId: "wamid-tpl-1",
    });
    expect(h.templateCalls).toHaveLength(1);
    expect(h.templateCalls[0]).toMatchObject({
      phoneNumberId: "pn-1",
      accessToken: "decrypted(enc)",
      to: "919130287749",
      templateName: "reminder_fallback",
      language: "en_US",
      messageParams: {
        body: [
          "Follow up with I am Animation creator Phone: 916296413616 Remember to contact this lead at the scheduled time.",
        ],
      },
    });
  });

  it("stored reminder message_text is never modified by sending", async () => {
    const stored = {
      message_text:
        "Follow up with I am Animation creator\n\nPhone: 916296413616\n\nRemember to contact this lead at the scheduled time.",
    };
    const snapshot = stored.message_text;
    await sendReminderViaTemplate(fakeDb() as never, "acct-1", {
      to: "919876543210",
      text: stored.message_text,
    });
    // The row object is untouched; only the in-memory template
    // parameter was normalized.
    expect(stored.message_text).toBe(snapshot);
    expect(stored.message_text).toContain("\n");
  });
});
