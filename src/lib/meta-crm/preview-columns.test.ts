// Meta CRM preview — production schema regression guard.
//
// Root cause of the drawer "Internal server error": the preview
// assembled `flow_runs.created_at`, but that column does NOT exist
// (flow_runs only has started_at/last_advanced_at/ended_at).
// PostgREST rejects the whole query (42703, a plain object — not
// an Error with .status), so toErrorResponse logged it and
// returned a bare 500.
//
// This suite runs the REAL assembly against a strict mock whose
// per-table column allowlists mirror the migrations. Any select of
// a non-existent column throws the PostgREST-shaped error — so a
// future bad column reference fails here instead of in the drawer.
// Uses the affected Instagram lead id (digits only, no PII).

import { describe, expect, it } from "vitest";

import { encrypt } from "@/lib/whatsapp/encryption";

import { assembleLeadQualityPreview } from "./preview";
import { buildCrmRequestBody, serializeCrmRequestBody } from "./lead-quality";

// Column allowlists mirroring supabase/migrations:
// 010_flows (flow_runs: NO created_at — started_at only),
// 088_workspace_custom_columns, 119_meta_lead_ads, 001/017 (contacts),
// 175_meta_crm_feedback.
const COLUMNS: Record<string, Set<string>> = {
  flow_runs: new Set([
    "id", "flow_id", "user_id", "contact_id", "conversation_id", "status",
    "current_node_key", "last_prompt_message_id", "vars", "reprompt_count",
    "started_at", "last_advanced_at", "ended_at", "end_reason",
    "account_id", "incomplete_synced_at", "incomplete_master_synced_at",
  ]),
  workspace_fields: new Set([
    "id", "account_id", "flow_id", "name", "field_type", "position",
    "options", "default_value", "currency_code", "created_at", "updated_at",
  ]),
  workspace_values: new Set([
    "id", "account_id", "field_id", "flow_run_id", "value_text",
    "created_at", "updated_at",
  ]),
  meta_lead_submissions: new Set([
    "id", "account_id", "meta_lead_id", "page_id", "form_id", "form_name",
    "source", "meta_created_time", "answers", "field_data", "flow_run_id",
    "contact_id", "status", "attempts", "last_error", "next_retry_at",
    "claimed_at", "processed_at", "created_at", "updated_at",
  ]),
  contacts: new Set([
    "id", "user_id", "phone", "name", "email", "company", "avatar_url",
    "created_at", "updated_at", "account_id",
  ]),
  meta_crm_config: new Set([
    "account_id", "dataset_ref", "dataset_id", "business_portfolio_id",
    "dataset_name", "access_token", "enabled", "verified_at", "last_error",
    "last_event_at", "updated_by", "created_at", "updated_at", "auto_send_lead",
  ]),
  meta_crm_events: new Set([
    "id", "account_id", "flow_id", "flow_run_id", "submission_id",
    "meta_lead_id", "event_name", "from_quality", "to_quality",
    "event_time", "event_uuid", "dataset_id", "status", "attempts",
    "max_attempts", "last_error", "next_retry_at", "sent_at",
    "meta_response", "created_at", "updated_at",
  ]),
};

type Row = Record<string, unknown>;

function strictDb(tables: Record<string, Row[]>) {
  const applyFilters = (rows: Row[], filters: Array<[string, unknown]>) =>
    rows.filter((r) =>
      filters.every(([c, v]) => {
        if (c === "__limit" || c === "__sort") return true;
        if (c === "__ilike") {
          const [col, val] = v as [string, string];
          return String(r[col] ?? "").toLowerCase() === String(val).toLowerCase();
        }
        return r[c] === v;
      }),
    );
  const chain = (table: string, cols: string[], filters: Array<[string, unknown]> = []): Record<string, (...a: never[]) => unknown> => {
    const rejectUnknown = () => {
      const allowed = COLUMNS[table];
      for (const c of cols) {
        if (c !== "*" && allowed && !allowed.has(c)) {
          // PostgREST-shaped rejection: plain object, no .status —
          // exactly what toErrorResponse turns into a bare 500.
          throw { code: "42703", message: `column ${table}.${c} does not exist` };
        }
      }
    };
    const api: Record<string, (...a: never[]) => unknown> = {
      select: () => chain(table, cols, filters),
      eq: (c: string, v: unknown) => chain(table, cols, [...filters, [c, v]]),
      ilike: (c: string, v: unknown) => chain(table, cols, [...filters, ["__ilike", [c, v]]]),
      order: (c: string, o?: { ascending?: boolean }) =>
        chain(table, cols, [...filters, ["__sort", [c, o?.ascending ?? true]]]),
      limit: (n: number) => chain(table, cols, [...filters, ["__limit", n]]),
      maybeSingle: async () => {
        rejectUnknown();
        const rows = applyFilters(tables[table] ?? [], filters);
        return { data: rows[0] ?? null, error: null };
      },
      single: async () => {
        rejectUnknown();
        const rows = applyFilters(tables[table] ?? [], filters);
        return rows.length > 0
          ? { data: rows[0], error: null }
          : { data: null, error: { message: "none" } };
      },
    };
    return api;
  };
  return {
    from: (table: string) => ({
      select: (cols: string) => chain(table, cols.split(",").map((s) => s.trim()).filter(Boolean)),
    }),
  };
}

const AFFECTED_LEAD_ID = "1176464514919762";

function seedTables() {
  // Relative instants (fixed dates rot into the future-gate as
  // wall-clock time moves on).
  const t = (minsAgo: number) => new Date(Date.now() - minsAgo * 60_000).toISOString();
  return {
    flow_runs: [
      // NOTE: no created_at — the production table has none.
      { id: "run-1", account_id: "acct-1", flow_id: "flow-1", contact_id: "c-1", started_at: t(65) },
    ],
    contacts: [
      { id: "c-1", account_id: "acct-1", email: "Lead@Example.com", phone: "9876543210" },
    ],
    workspace_fields: [
      { id: "f-q", account_id: "acct-1", flow_id: "flow-1", name: "Lead Quality" },
    ],
    workspace_values: [
      {
        account_id: "acct-1",
        field_id: "f-q",
        flow_run_id: "run-1",
        value_text: "Qualified Lead",
        updated_at: t(60),
      },
    ],
    meta_lead_submissions: [
      {
        id: "sub-1",
        account_id: "acct-1",
        flow_run_id: "run-1",
        meta_lead_id: AFFECTED_LEAD_ID,
        meta_created_time: t(70),
        created_at: t(65),
        answers: {},
        field_data: [],
      },
    ],
    meta_crm_config: [
      { account_id: "acct-1", enabled: true, dataset_id: "1830596054845292", access_token: encrypt("CRM_TOKEN_strict") },
    ],
    meta_crm_events: [],
  };
}

describe("preview against the production column set", () => {
  it("assembles the affected Instagram lead end to end (no 500)", async () => {
    const tables = seedTables();
    const storedAt = (tables.workspace_values[0] as Row).updated_at as string;
    const preview = await assembleLeadQualityPreview(strictDb(tables) as never, {
      accountId: "acct-1",
      flowId: "flow-1",
      runId: "run-1",
    });
    expect(preview.sendable).toBe(true);
    expect(preview.eventName).toBe("QualifiedLead");
    expect(preview.metaLeadId).toBe(AFFECTED_LEAD_ID);
    // Occurrence = the stored status-change instant.
    expect(preview.occurrenceTimeIso).toBe(storedAt);
    expect(preview.payload?.event_time).toBe(Math.floor(Date.parse(storedAt) / 1000));
    // Hashed contact identifiers included; exact lead id verbatim.
    expect(preview.matchInfo).toEqual({ hasEmail: true, hasPhone: true });
    expect(preview.payload?.user_data.lead_id).toBe(AFFECTED_LEAD_ID);
    expect(preview.payload?.user_data.em).toHaveLength(1);
    // Complete outgoing body wraps the event in `data`.
    expect(preview.requestBody).toEqual(buildCrmRequestBody(preview.payload!));
    // Wire serialization emits the documented integer form.
    const wire = JSON.parse(serializeCrmRequestBody(preview.requestBody!));
    expect(wire.data[0].user_data.lead_id).toBe(1176464514919762);
    expect(typeof preview.previewId).toBe("string");
  });

  it("falls back to the Meta creation instant when no status is stored", async () => {
    const tables = seedTables();
    tables.workspace_values = [];
    const metaCreated = (tables.meta_lead_submissions[0] as Row).meta_created_time as string;
    const preview = await assembleLeadQualityPreview(strictDb(tables) as never, {
      accountId: "acct-1",
      flowId: "flow-1",
      runId: "run-1",
    });
    expect(preview.sendable).toBe(true);
    expect(preview.status).toBe("Lead");
    expect(preview.eventName).toBe("Lead");
    expect(preview.occurrenceTimeIso).toBe(metaCreated);
  });

  it("rejects a strict-mock column error the way production does", async () => {
    // Sanity: the strict mock really does throw PostgREST-shaped
    // errors for unknown columns (the drawer 500 signature).
    const db = strictDb(seedTables());
    await expect(
      (db.from("flow_runs").select("id, created_at") as unknown as { maybeSingle: () => Promise<unknown> }).maybeSingle(),
    ).rejects.toMatchObject({ code: "42703" });
  });
});
