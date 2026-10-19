// Meta Conversions API — delivery engine behaviour.
//
// Focuses on the rules that protect data + spend:
//   * idempotent: one logical conversion is sent at most once;
//   * fail-closed: a Purchase with no real value/currency is recorded
//     as skipped and NEVER sent;
//   * precise triggers: a workspace mapping fires only on the exact
//     column + value;
//   * retries reuse the stored payload (same event_id) with a bounded
//     backoff.
//
// Meta Graph is mocked; the pure payload/hash logic is exercised for
// real.

import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  config: null as Record<string, unknown> | null,
  token: "tok" as string | null,
  appSecret: null as string | null,
  mappings: [] as Array<Record<string, unknown>>,
  inserted: [] as Array<Record<string, unknown>>,
  sent: [] as Array<{ id: string; attempts: number }>,
  failed: [] as Array<{ id: string; error: string; nextRetryAt: string | null }>,
  eventIds: new Set<string>(),
  sendCalls: [] as Array<Record<string, unknown>>,
  sendOpts: [] as Array<Record<string, unknown>>,
  sendImpl: null as null | ((body: Record<string, unknown>) => Record<string, unknown>),
  claimResult: null as Record<string, unknown> | null,
}));

vi.mock("./store", () => ({
  getConfig: async () => h.config,
  getDecryptedToken: async () => h.token,
  getDecryptedAppSecret: async () => h.appSecret,
  listEnabledMappingsForAction: async (
    _db: unknown,
    accountId: string,
    action: string,
  ) =>
    h.mappings.filter(
      (m) =>
        m.enabled === true &&
        m.source_action === action &&
        m.account_id === accountId,
    ),
  insertDelivery: async (_db: unknown, row: Record<string, unknown>) => {
    const key = String(row.event_id);
    if (h.eventIds.has(key)) return null;
    h.eventIds.add(key);
    const delivery: Record<string, unknown> = {
      id: `d${h.inserted.length + 1}`,
      attempts: 0,
      ...row,
    };
    h.inserted.push(delivery);
    return delivery;
  },
  markDeliverySent: async (
    _db: unknown,
    id: string,
    _response: unknown,
    attempts: number,
  ) => {
    h.sent.push({ id, attempts });
  },
  markDeliveryFailed: async (
    _db: unknown,
    id: string,
    _attempts: number,
    error: string,
    nextRetryAt: string | null,
  ) => {
    h.failed.push({ id, error, nextRetryAt });
  },
  claimDelivery: async () => h.claimResult,
  getDelivery: async () => h.claimResult,
  listDueDeliveries: async () => (h.claimResult ? [h.claimResult] : []),
}));

vi.mock("./client", () => ({
  sendEvents: async (
    _platform: unknown,
    _dataset: unknown,
    _token: unknown,
    body: Record<string, unknown>,
    opts?: Record<string, unknown>,
  ) => {
    h.sendCalls.push(body);
    h.sendOpts.push(opts ?? {});
    if (!h.sendImpl) return { events_received: 1, fbtrace_id: "trace" };
    return h.sendImpl(body);
  },
}));

const { fireCapiForAction, runDueDeliveries } = await import("./deliver");

const db = {} as SupabaseClient;
const platform = { graphVersion: "v21.0" };

function mapping(overrides: Record<string, unknown> = {}) {
  return {
    id: "map-1",
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
    ...overrides,
  };
}

function firstEvent(body: Record<string, unknown>) {
  return (body.data as Array<Record<string, unknown>>)[0];
}

beforeEach(() => {
  h.config = {
    account_id: "acct-1",
    dataset_id: "12345",
    access_token: "enc",
    status: "connected",
    action_source: "business_messaging",
  };
  h.token = "tok";
  h.appSecret = null;
  h.mappings = [mapping()];
  h.inserted = [];
  h.sent = [];
  h.failed = [];
  h.eventIds = new Set();
  h.sendCalls = [];
  h.sendOpts = [];
  h.sendImpl = null;
  h.claimResult = null;
});

describe("fireCapiForAction", () => {
  it("delivers an applicable mapping and marks it sent", async () => {
    const result = await fireCapiForAction(db, platform, {
      accountId: "acct-1",
      action: "meta_lead_received",
      flowRunId: "run-1",
      matchData: { phone: "+15551234567" },
    });

    expect(result).toEqual({ fired: 1, failed: 0, skipped: 0 });
    expect(h.sendCalls).toHaveLength(1);
    expect(firstEvent(h.sendCalls[0]).event_name).toBe("Lead");
    expect(h.sent).toHaveLength(1);
  });

  it("forwards the customer App Secret when one is stored", async () => {
    h.appSecret = "customer-app-secret";
    await fireCapiForAction(db, platform, {
      accountId: "acct-1",
      action: "meta_lead_received",
      flowRunId: "run-1",
    });

    expect(h.sendOpts[0]).toMatchObject({ appSecret: "customer-app-secret" });
  });

  it("never fabricates a proof when no App Secret is stored", async () => {
    await fireCapiForAction(db, platform, {
      accountId: "acct-1",
      action: "meta_lead_received",
      flowRunId: "run-1",
    });

    expect(h.sendOpts[0]).toMatchObject({ appSecret: null });
  });

  it("is idempotent — the same conversion is never sent twice", async () => {
    const event = {
      accountId: "acct-1",
      action: "meta_lead_received" as const,
      flowRunId: "run-1",
    };

    await fireCapiForAction(db, platform, event);
    const second = await fireCapiForAction(db, platform, event);

    expect(second.fired).toBe(0);
    expect(h.sendCalls).toHaveLength(1);
  });

  it("does nothing when no dataset/token is stored", async () => {
    h.config = null;
    const result = await fireCapiForAction(db, platform, {
      accountId: "acct-1",
      action: "meta_lead_received",
      flowRunId: "run-1",
    });
    expect(result).toEqual({ fired: 0, failed: 0, skipped: 0 });
    expect(h.sendCalls).toHaveLength(0);
  });

  it("records a Purchase with no value as skipped and never sends it", async () => {
    h.mappings = [
      mapping({ meta_event_name: "Purchase", requires_value: true, event_value: null }),
    ];

    const result = await fireCapiForAction(db, platform, {
      accountId: "acct-1",
      action: "meta_lead_received",
      flowRunId: "run-1",
    });

    expect(result.fired).toBe(0);
    expect(result.skipped).toBe(1);
    expect(h.sendCalls).toHaveLength(0);
    expect(h.inserted[0].status).toBe("skipped");
  });

  it("sends a Purchase with the configured value + currency", async () => {
    h.mappings = [
      mapping({
        meta_event_name: "Purchase",
        requires_value: true,
        event_value: 150,
        currency: "USD",
      }),
    ];

    await fireCapiForAction(db, platform, {
      accountId: "acct-1",
      action: "meta_lead_received",
      flowRunId: "run-1",
    });

    const event = firstEvent(h.sendCalls[0]);
    expect(event.custom_data).toEqual({ value: 150, currency: "USD" });
  });

  it("fires a workspace mapping only on the exact column + value", async () => {
    h.mappings = [
      mapping({
        source_action: "workspace_field_changed",
        source_field: "Stage",
        source_value: "Booking Confirmed",
      }),
    ];

    const noMatch = await fireCapiForAction(db, platform, {
      accountId: "acct-1",
      action: "workspace_field_changed",
      flowRunId: "run-1",
      fieldName: "Stage",
      value: "New Lead",
    });
    expect(noMatch.fired).toBe(0);

    const match = await fireCapiForAction(db, platform, {
      accountId: "acct-1",
      action: "workspace_field_changed",
      flowRunId: "run-1",
      fieldName: "Stage",
      value: "Booking Confirmed",
    });
    expect(match.fired).toBe(1);
    expect(h.sendCalls).toHaveLength(1);
  });

  it("records a failure with a bounded retry window", async () => {
    h.sendImpl = () => {
      throw new Error("Meta 500");
    };

    const result = await fireCapiForAction(db, platform, {
      accountId: "acct-1",
      action: "meta_lead_received",
      flowRunId: "run-1",
    });

    expect(result.failed).toBe(1);
    expect(h.failed).toHaveLength(1);
    expect(h.failed[0].nextRetryAt).toBeTruthy();
  });
});

describe("runDueDeliveries", () => {
  it("retries with the SAME event_id (Meta de-duplicates)", async () => {
    h.sendImpl = () => {
      throw new Error("Meta 500");
    };
    await fireCapiForAction(db, platform, {
      accountId: "acct-1",
      action: "meta_lead_received",
      flowRunId: "run-1",
    });
    const originalId = firstEvent(h.sendCalls[0]).event_id;

    // The stored row becomes claimable, and Meta now succeeds.
    h.claimResult = h.inserted[0];
    h.sendImpl = null;

    const sweep = await runDueDeliveries(db, platform, 10, "acct-1");

    expect(sweep.sent).toBe(1);
    expect(h.sendCalls).toHaveLength(2);
    expect(firstEvent(h.sendCalls[1]).event_id).toBe(originalId);
  });
});
