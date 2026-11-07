import { describe, expect, it } from "vitest";
import {
  FOLLOWUP_MESSAGE_MAX,
  AGENT_NUMBER_DEFAULT_COUNTRY_CODE,
  displayFollowupStatus,
  formatAgentNumberForDisplay,
  isFollowupStatus,
  normalizeAgentWhatsappNumber,
  normalizeRecipientPhone,
  validateFollowupInput,
} from "./types";

const FUTURE = "2999-01-01T10:00:00.000Z";
const PAST = "2000-01-01T10:00:00.000Z";

describe("reminder input validation", () => {
  it("accepts a future reminder with customer context", () => {
    const out = validateFollowupInput({
      contact_id: "c-1",
      scheduled_for: FUTURE,
      message_text: "  Hi there  ",
    });
    expect(out).toMatchObject({
      contact_id: "c-1",
      message_text: "Hi there",
      template_name: null,
    });
  });

  it("treats customer as optional context", () => {
    for (const contact_id of [undefined, null, ""]) {
      const out = validateFollowupInput({
        contact_id,
        scheduled_for: FUTURE,
        message_text: "Call the Dubai lead after lunch",
      });
      expect(out.contact_id).toBeNull();
    }
  });

  it("rejects past date/time", () => {
    expect(() =>
      validateFollowupInput({
        contact_id: "c-1",
        scheduled_for: PAST,
        message_text: "Hi",
      }),
    ).toThrow(/future/i);
  });

  it("requires date, time (as instant), and message — but not a customer", () => {
    expect(() =>
      validateFollowupInput({ contact_id: 123, scheduled_for: FUTURE, message_text: "Hi" }),
    ).toThrow(/customer/i);
    expect(() =>
      validateFollowupInput({ contact_id: "c-1", scheduled_for: "not-a-date", message_text: "Hi" }),
    ).toThrow(/valid date/i);
    expect(() =>
      validateFollowupInput({ contact_id: "c-1", scheduled_for: FUTURE, message_text: "  " }),
    ).toThrow(/message/i);
  });

  it("enforces the message length cap without modifying text", () => {
    const msg = "x".repeat(FOLLOWUP_MESSAGE_MAX);
    expect(
      validateFollowupInput({ contact_id: "c-1", scheduled_for: FUTURE, message_text: msg })
        .message_text,
    ).toBe(msg);
    expect(() =>
      validateFollowupInput({
        contact_id: "c-1",
        scheduled_for: FUTURE,
        message_text: `${msg}x`,
      }),
    ).toThrow(/characters/i);
  });

  it("accepts an optional template with language default", () => {
    const out = validateFollowupInput({
      contact_id: "c-1",
      scheduled_for: FUTURE,
      message_text: "Hi",
      template_name: "hello_world",
    });
    expect(out.template_name).toBe("hello_world");
    expect(out.template_language).toBe("en_US");
  });

  it("recognizes the five statuses", () => {
    for (const s of ["scheduled", "processing", "sent", "failed", "cancelled"]) {
      expect(isFollowupStatus(s)).toBe(true);
    }
    expect(isFollowupStatus("pending")).toBe(false);
  });
});

describe("normalizeRecipientPhone", () => {
  it("normalizes to digits-only E.164", () => {
    expect(normalizeRecipientPhone("+91 98765 43210")).toBe("919876543210");
    expect(normalizeRecipientPhone("+1 (415) 555-1212")).toBe("14155551212");
  });

  it("fails closed on anything else — never falls back", () => {
    expect(normalizeRecipientPhone(null)).toBeNull();
    expect(normalizeRecipientPhone(undefined)).toBeNull();
    expect(normalizeRecipientPhone("")).toBeNull();
    expect(normalizeRecipientPhone("   ")).toBeNull();
    expect(normalizeRecipientPhone("not a number")).toBeNull();
    expect(normalizeRecipientPhone("123")).toBeNull();
    expect(normalizeRecipientPhone(919876543210)).toBeNull();
  });
});

describe("strict agent WhatsApp numbers (India +91 default)", () => {
  it("1/2. bare 10-digit numbers gain the India default, no warning", () => {
    expect(normalizeAgentWhatsappNumber("8737064453")).toBe("918737064453");
    expect(normalizeAgentWhatsappNumber("9876543210")).toBe("919876543210");
    expect(normalizeAgentWhatsappNumber("  98765 43210 ")).toBe("919876543210");
    expect(AGENT_NUMBER_DEFAULT_COUNTRY_CODE).toBe("91");
  });

  it("3/4. already-international numbers pass through untouched", () => {
    expect(normalizeAgentWhatsappNumber("919174158819")).toBe("919174158819");
    expect(normalizeAgentWhatsappNumber("919876544321")).toBe("919876544321");
    expect(normalizeAgentWhatsappNumber("+918737064453")).toBe("918737064453");
    expect(normalizeAgentWhatsappNumber("+91 98765 43210")).toBe("919876543210");
    expect(normalizeAgentWhatsappNumber("+1 415 555 2671")).toBe("14155552671");
  });

  it("6/9. malformed numbers still fail via existing validation", () => {
    for (const bad of [null, undefined, "", "   ", "not-a-number", "123", "1234567890123456", 919876543210]) {
      expect(normalizeAgentWhatsappNumber(bad)).toBeNull();
    }
  });
});

describe("reminder number display formatting (stored value untouched)", () => {
  it("groups stored Indian numbers as +91 XXXXX XXXXX", () => {
    expect(formatAgentNumberForDisplay("916387495389")).toBe("+91 63874 95389");
    expect(formatAgentNumberForDisplay("919876543210")).toBe("+91 98765 43210");
  });

  it("prefixes other digit strings with + without regrouping", () => {
    expect(formatAgentNumberForDisplay("14155552671")).toBe("+14155552671");
  });

  it("passes non-digit input through and blanks empty input", () => {
    expect(formatAgentNumberForDisplay("+91 63874 95389")).toBe("+91 63874 95389");
    expect(formatAgentNumberForDisplay("")).toBe("");
    expect(formatAgentNumberForDisplay(null)).toBe("");
  });
});

describe("display delivery state (Meta acceptance is not delivery)", () => {
  const base = {
    status: "sent",
    delivered_at: null,
    read_at: null,
  } as const;

  it("keeps non-sent statuses verbatim", () => {
    for (const status of [
      "scheduled",
      "processing",
      "failed",
      "cancelled",
    ] as const) {
      expect(
        displayFollowupStatus({ status, delivered_at: null, read_at: null }),
      ).toBe(status);
    }
  });

  it("treats bare sent as Meta acceptance only", () => {
    expect(displayFollowupStatus({ ...base })).toBe("sent");
  });

  it("requires delivered_at for Delivered, read_at for Read", () => {
    expect(
      displayFollowupStatus({ ...base, delivered_at: "2026-11-08T10:30:18.000Z" }),
    ).toBe("delivered");
    expect(
      displayFollowupStatus({
        ...base,
        delivered_at: "2026-11-08T10:30:18.000Z",
        read_at: "2026-11-08T10:34:26.000Z",
      }),
    ).toBe("read");
    // Read wins even if delivered_at is somehow missing.
    expect(
      displayFollowupStatus({ ...base, read_at: "2026-11-08T10:34:26.000Z" }),
    ).toBe("read");
  });
});
