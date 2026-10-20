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

import { metaGraphVersion } from "@/lib/meta-lead-ads/config";

import type { CapiPlatform } from "./client";
import { fireCapiForAction } from "./deliver";
import type { UserDataInput } from "./hash";

/**
 * CAPI needs only the Graph version. It deliberately does NOT use the
 * platform Lead Ads app credentials: a customer's System User token can
 * belong to a different Meta app, and an `appsecret_proof` computed with
 * the wrong (platform) secret is rejected by Meta.
 */
export function metaCapiPlatform(): CapiPlatform | null {
  const graphVersion = metaGraphVersion();
  if (!graphVersion) return null;
  return { graphVersion };
}

async function loadMatchData(
  db: SupabaseClient,
  accountId: string,
  contactId: string | null | undefined,
): Promise<UserDataInput | null> {
  if (!contactId) return null;
  const { data } = await db
    .from("contacts")
    .select("phone, name, email, ctwa_clid")
    .eq("account_id", accountId)
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
    const matchData =
      args.matchData ?? (await loadMatchData(db, args.accountId, args.contactId));
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
  const matchData = await loadMatchData(db, run.account_id, run.contact_id);
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
 * value) — the callers enforce that before calling. Prefer
 * `recordWorkspaceStatusChanged`, which centralizes the unchanged /
 * cleared guards.
 */
export async function onWorkspaceValueChanged(
  db: SupabaseClient,
  args: {
    accountId: string;
    flowRunId: string;
    contactId?: string | null;
    fieldName: string;
    value: string;
    previousValue?: string | null;
    occurredAt?: Date;
  },
): Promise<void> {
  const platform = metaCapiPlatform();
  if (!platform) return;
  await runSafely("workspace-field", async () => {
    const matchData = await loadMatchData(db, args.accountId, args.contactId);
    return fireCapiForAction(db, platform, {
      accountId: args.accountId,
      action: "workspace_field_changed",
      flowRunId: args.flowRunId,
      contactId: args.contactId ?? null,
      fieldName: args.fieldName,
      value: args.value,
      previousValue: args.previousValue ?? null,
      occurredAt: args.occurredAt ?? new Date(),
      matchData,
    });
  });
}

export interface WorkspaceStatusChange {
  accountId: string;
  flowRunId: string;
  contactId?: string | null;
  fieldName: string;
  /** Stored value before the write (null when previously empty). */
  previousValue: string | null;
  /** Stored value after the write (null/empty when cleared). */
  newValue: string | null;
  occurredAt?: Date;
}

/**
 * Shared server-side status-change hook. Call after a successful
 * Workspace value write from ANY route (inline Workspace edits, Travel
 * CRM sync, future writers). Guards:
 *   * unchanged values never trigger;
 *   * cleared/deleted values never trigger;
 *   * CAPI failures never throw (delivery is best-effort).
 *
 * Returns true when a trigger was evaluated.
 */
export async function recordWorkspaceStatusChanged(
  db: SupabaseClient,
  change: WorkspaceStatusChange,
): Promise<boolean> {
  const previous = change.previousValue ?? "";
  const next = change.newValue ?? "";
  if (next === "" || next === previous) return false;
  await onWorkspaceValueChanged(db, {
    accountId: change.accountId,
    flowRunId: change.flowRunId,
    contactId: change.contactId,
    fieldName: change.fieldName,
    value: next,
    previousValue: previous === "" ? null : previous,
    occurredAt: change.occurredAt,
  });
  return true;
}
