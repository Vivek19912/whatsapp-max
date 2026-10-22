import { describe, expect, it } from "vitest";

import type { MetaCapiMappingRow } from "./types";
import {
  buildCapiEvent,
  buildCrmCustomData,
  buildCustomData,
  buildEventId,
  buildRequestPayload,
  matchesMapping,
  requiresValue,
  valueCriteriaMet,
} from "./payload";

function mapping(overrides: Partial<MetaCapiMappingRow> = {}): MetaCapiMappingRow {
  return {
    id: "map-1",
    account_id: "acct-1",
    name: "Enquiry",
    source_action: "meta_lead_received",
    source_field: null,
    source_value: null,
    meta_event_name: "Lead",
    action_source: "business_messaging",
    requires_value: false,
    event_value: null,
    currency: null,
    enabled: true,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("matchesMapping", () => {
  it("ignores mappings for a different action", () => {
    expect(
      matchesMapping(mapping(), {
        accountId: "acct-1",
        action: "flow_completed",
      }),
    ).toBe(false);
  });

  it("matches a plain lead mapping", () => {
    expect(
      matchesMapping(mapping(), {
        accountId: "acct-1",
        action: "meta_lead_received",
      }),
    ).toBe(true);
  });

  it("only matches a workspace mapping on the exact column + value", () => {
    const m = mapping({
      source_action: "workspace_field_changed",
      source_field: "Stage",
      source_value: "Booking Confirmed",
    });
    const base = { accountId: "acct-1", action: "workspace_field_changed" as const };

    expect(matchesMapping(m, { ...base, fieldName: "Stage", value: "Paid" })).toBe(false);
    expect(matchesMapping(m, { ...base, fieldName: "Other", value: "Booking Confirmed" })).toBe(false);
    expect(matchesMapping(m, { ...base, fieldName: "Stage", value: "Booking Confirmed" })).toBe(true);
    // Empty value never matches.
    expect(matchesMapping(m, { ...base, fieldName: "Stage", value: "" })).toBe(false);
  });
});

describe("value gating", () => {
  it("flags Purchase as value-requiring", () => {
    expect(requiresValue(mapping({ meta_event_name: "Purchase" }))).toBe(true);
    expect(requiresValue(mapping({ meta_event_name: "Lead" }))).toBe(false);
  });

  it("blocks a Purchase with no value, value <= 0, or no currency", () => {
    expect(valueCriteriaMet(mapping({ meta_event_name: "Purchase" }))).toBe(false);
    expect(
      valueCriteriaMet(mapping({ meta_event_name: "Purchase", event_value: 0, currency: "USD" })),
    ).toBe(false);
    expect(
      valueCriteriaMet(mapping({ meta_event_name: "Purchase", event_value: 100 })),
    ).toBe(false);
    expect(
      valueCriteriaMet(mapping({ meta_event_name: "Purchase", event_value: 100, currency: "USD" })),
    ).toBe(true);
  });

  it("never blocks a non-value event", () => {
    expect(valueCriteriaMet(mapping({ meta_event_name: "Lead" }))).toBe(true);
  });
});

describe("buildEventId", () => {
  const at = new Date("2026-01-02T03:04:05.000Z");

  it("is stable across retries for lead + completion events", () => {
    const m = mapping();
    const a = buildEventId(m, { accountId: "acct-1", action: "meta_lead_received", flowRunId: "run-1" }, at);
    const b = buildEventId(m, { accountId: "acct-1", action: "meta_lead_received", flowRunId: "run-1" }, new Date());
    expect(a).toBe(b);
    expect(a).toContain("run-1");
  });

  it("distinguishes two workspace transitions but collapses the same one", () => {
    const m = mapping({ source_action: "workspace_field_changed" });
    const base = { accountId: "acct-1", action: "workspace_field_changed" as const, flowRunId: "run-1", fieldName: "Stage", previousValue: "New" };
    const paid = buildEventId(m, { ...base, value: "Paid" }, at);
    const booked = buildEventId(m, { ...base, value: "Booked" }, at);
    const paidAgain = buildEventId(m, { ...base, value: "Paid" }, new Date());
    expect(paid).not.toBe(booked);
    expect(paid).toBe(paidAgain);
  });

  it("keys identical concurrent transitions to the same id regardless of clock", () => {
    const m = mapping({ source_action: "workspace_field_changed" });
    const transition = {
      accountId: "acct-1",
      action: "workspace_field_changed" as const,
      flowRunId: "run-1",
      fieldName: "Stage",
      previousValue: "New",
      value: "Qualified",
    };
    const first = buildEventId(m, transition, new Date("2026-01-02T03:04:05.000Z"));
    const second = buildEventId(m, transition, new Date("2026-01-02T03:04:05.250Z"));
    expect(first).toBe(second);
  });
});

describe("payload assembly", () => {
  it("builds custom_data only when a value/currency is present", () => {
    expect(buildCustomData(mapping())).toEqual({});
    expect(
      buildCustomData(mapping({ event_value: 150, currency: "EUR" })),
    ).toEqual({ value: 150, currency: "EUR" });
  });

  it("builds a full event with hashed user_data and epoch event_time", () => {
    const event = buildCapiEvent({
      eventName: "Lead",
      eventId: "e1",
      actionSource: "business_messaging",
      eventTime: new Date("2026-01-02T03:04:05.000Z"),
      userData: { em: "hash" },
      customData: { value: 10, currency: "USD" },
    });
    expect(event.event_time).toBe(Math.floor(Date.parse("2026-01-02T03:04:05.000Z") / 1000));
    expect(event.event_name).toBe("Lead");
    expect(event.user_data).toEqual({ em: "hash" });
    expect(event.custom_data).toEqual({ value: 10, currency: "USD" });
  });

  it("wraps the event in a CAPI request payload with an optional test code", () => {
    const event = buildCapiEvent({
      eventName: "Lead",
      eventId: "e1",
      actionSource: "business_messaging",
      eventTime: new Date(),
      userData: {},
    });
    expect(buildRequestPayload(event)).toEqual({ data: [event] });
    expect(buildRequestPayload(event, "TEST123")).toEqual({
      data: [event],
      test_event_code: "TEST123",
    });
  });

  it("builds CRM custom_data with the validated crm markers (and no messaging_channel)", () => {
    expect(buildCrmCustomData(mapping())).toEqual({
      event_source: "crm",
      lead_event_source: "WhatsApp Max",
    });
  });

  it("builds CRM custom_data on top of value/currency without mutating them", () => {
    expect(
      buildCrmCustomData(mapping({ event_value: 150, currency: "EUR" })),
    ).toEqual({
      value: 150,
      currency: "EUR",
      event_source: "crm",
      lead_event_source: "WhatsApp Max",
    });
    expect(
      buildCrmCustomData(mapping({ event_value: 150, currency: "EUR" })),
    ).not.toHaveProperty("messaging_channel");
  });
});
