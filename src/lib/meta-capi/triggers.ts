// ============================================================
// Meta Conversions API — trigger helpers.
//
// These are the ONLY entry points domain code should call. Each:
//   * no-ops fast when CAPI isn't configured (no queries, no work),
//   * loads the minimum contact match data server-side,
//   * fires the matching events, and
//   * NEVER throws — Conversions API must never be able to break a
//     lead capture, a flow completion, or a Workspace cell save.
//
// Events are fired from real server-side domain operations only —
// never from a UI click, page load, or an unchanged value.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { metaLeadAdsConfig } from "@/lib/meta-lead-ads/config";

import type { CapiPlatform } from "./client";
import { fireCapiForAction } from "./deliver";
import type { UserDataInput } from "./hash";

/** The shared platform Meta app provides the Graph version + app secret. */
export function metaCapiPlatform(): CapiPlatform | null {
  const config = metaLeadAdsConfig();
  if (!config) return null;
  return { graphVersion: config.graphVersion, appSecret: config.appSecret };
}

async function loadMatchData(
  db: SupabaseClient,
  contactId: string | null | undefined,
): Promise<UserDataInput | null> {
  if (!contactId) return null;
  const { data } = await db
    .from("contacts")
    .select("phone, name, email, ctwa_clid")
    .eq("id", contactId)
    .maybeSingle();
  const contact = data as
    | { phone?: string | null; name?: string | null; email?: string | null; ctwa_clid?: string | null }
    | null;
  if (!contact) return null;
  return {
    phone: contact.phone ?? null,
    fullName: contact.name ?? null,
    email: contact.email ?? null,
    ctwaClid: contact.ctwa_clid ?? null,
  };
}

async function runSafely<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    console.error(
      `[meta-capi] ${label} trigger failed:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * A Meta Instant Form lead was just ingested into the Workspace.
 * Called right after the lead's `flow_runs` row is written.
 */
export async function onMetaLeadReceived(
  db: SupabaseClient,
  args: {
    accountId: string;
    flowRunId: string;
    contactId?: string | null;
    occurredAt?: string | null;
    matchData?: UserDataInput | null;
  },
): Promise<void> {
  const platform = metaCapiPlatform();
  if (!platform) return;
  await runSafely("meta-lead", async () => {
    const matchData = args.matchData ?? (await loadMatchData(db, args.contactId));
    return fireCapiForAction(db, platform, {
      accountId: args.accountId,
      action: "meta_lead_received",
      flowRunId: args.flowRunId,
      contactId: args.contactId ?? null,
      occurredAt: args.occurredAt ? new Date(args.occurredAt) : new Date(),
      matchData,
    });
  });
}

/**
 * A WhatsApp flow run finished as `completed`. Called from the engine's
 * completion path only (never for handed_off/failed/timed_out).
 */
export async function onFlowCompleted(
  db: SupabaseClient,
  runId: string,
): Promise<void> {
  const platform = metaCapiPlatform();
  if (!platform) return;
  await runSafely("flow-completed", async () => {
    const { data } = await db
      .from("flow_runs")
      .select("account_id, contact_id, ended_at")
      .eq("id", runId)
      .maybeSingle();
    const run = data as
      | { account_id: string; contact_id: string | null; ended_at: string | null }
      | null;
    if (!run) return null;
    const matchData = await loadMatchData(db, run.contact_id);
    return fireCapiForAction(db, platform, {
      accountId: run.account_id,
      action: "flow_completed",
      flowRunId: runId,
      contactId: run.contact_id,
      occurredAt: run.ended_at ? new Date(run.ended_at) : new Date(),
      matchData,
    });
  });
}

/**
 * A Workspace column was set to a value. Callers MUST only invoke this
 * when the stored value actually changed (not on a re-save of the same
 * value) — the route enforces that before calling.
 */
export async function onWorkspaceValueChanged(
  db: SupabaseClient,
  args: {
    accountId: string;
    flowRunId: string;
    contactId?: string | null;
    fieldName: string;
    value: string;
    occurredAt?: Date;
  },
): Promise<void> {
  const platform = metaCapiPlatform();
  if (!platform) return;
  await runSafely("workspace-field", async () => {
    const matchData = await loadMatchData(db, args.contactId);
    return fireCapiForAction(db, platform, {
      accountId: args.accountId,
      action: "workspace_field_changed",
      flowRunId: args.flowRunId,
      contactId: args.contactId ?? null,
      fieldName: args.fieldName,
      value: args.value,
      occurredAt: args.occurredAt ?? new Date(),
      matchData,
    });
  });
}
