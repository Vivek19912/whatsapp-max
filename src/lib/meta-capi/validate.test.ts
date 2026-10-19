import { describe, expect, it } from "vitest";

import { parseMappingInput, toMappingInput } from "./validate";
import type { MetaCapiMappingRow } from "./types";

describe("parseMappingInput", () => {
  it("accepts a minimal lead mapping", () => {
    const parsed = parseMappingInput({
      name: "Lead enquiry",
      source_action: "meta_lead_received",
      meta_event_name: "Lead",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toMatchObject({
      name: "Lead enquiry",
      source_action: "meta_lead_received",
      source_field: null,
      source_value: null,
      meta_event_name: "Lead",
      action_source: "business_messaging",
      requires_value: false,
      enabled: false,
    });
  });

  it("rejects an unknown trigger source", () => {
    const parsed = parseMappingInput({
      name: "x",
      source_action: "something_else",
      meta_event_name: "Lead",
    });
    expect(parsed.ok).toBe(false);
  });

  it("requires a column AND a value for workspace mappings", () => {
    const missingField = parseMappingInput({
      name: "x",
      source_action: "workspace_field_changed",
      meta_event_name: "Lead",
      source_value: "Paid",
    });
    expect(missingField.ok).toBe(false);

    const missingValue = parseMappingInput({
      name: "x",
      source_action: "workspace_field_changed",
      meta_event_name: "Lead",
      source_field: "Stage",
    });
    expect(missingValue.ok).toBe(false);

    const ok = parseMappingInput({
      name: "x",
      source_action: "workspace_field_changed",
      meta_event_name: "Lead",
      source_field: "Stage",
      source_value: "Paid",
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.source_field).toBe("Stage");
  });

  it("forces a value + currency for Purchase and rejects inventing one", () => {
    const noValue = parseMappingInput({
      name: "Sale",
      source_action: "workspace_field_changed",
      meta_event_name: "Purchase",
      source_field: "Stage",
      source_value: "Paid",
    });
    expect(noValue.ok).toBe(false);

    const noCurrency = parseMappingInput({
      name: "Sale",
      source_action: "meta_lead_received",
      meta_event_name: "Purchase",
      event_value: 99,
    });
    expect(noCurrency.ok).toBe(false);

    const ok = parseMappingInput({
      name: "Sale",
      source_action: "meta_lead_received",
      meta_event_name: "Purchase",
      event_value: "99.50",
      currency: "usd",
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.value.requires_value).toBe(true);
      expect(ok.value.event_value).toBe(99.5);
      expect(ok.value.currency).toBe("USD");
    }
  });

  it("merges against a base row so PATCH only needs the changed field", () => {
    const existing: MetaCapiMappingRow = {
      id: "m1",
      account_id: "acct-1",
      name: "Lead",
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
    };
    const parsed = parseMappingInput({ enabled: false }, toMappingInput(existing));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.name).toBe("Lead");
      expect(parsed.value.enabled).toBe(false);
    }
  });
});
