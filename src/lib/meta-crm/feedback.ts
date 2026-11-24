// ============================================================
// Meta CRM feedback — config, durable event outbox, and drain
// (Feature: Instant Form lead-quality → Meta Conversions API).
//
// Flow:
//   * "Lead Quality" cell saved -> stores the status ONLY (the
//     workspace-values save path deliberately contains no CRM
//     hook; selecting, clearing, or re-saving never sends).
//   * Explicit Send to Meta (POST .../manual-send, after the user
//     reviews the backend-generated preview from GET .../preview)
//     -> enqueue the mapped event for the CURRENT stored status.
//   * Drain (cron sweep + prompt post-response trigger) sends
//     pending rows server-side with the account's stored Meta
//     connection token. Tokens are never persisted here, never
//     logged, never returned.
//
// This is a NEW, independent integration. It does NOT inspect,
// reuse, or depend on the retired Conversions API (`meta-capi`)
// implementation, which remains untouched and hidden.
//
// Deduplication: UNIQUE(account_id, flow_run_id, event_name,
// from_quality, to_quality) — re-saving an unchanged value can
// never create a second event; races collapse to the existing row.
// The row's event_uuid stays internal (history/retries/auditing)
// and is never sent to Meta — the Meta payload carries no
// event_id, and retries resend the identical stored occurrence.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { decrypt, encrypt } from "@/lib/whatsapp/encryption";

import { isUniqueViolation } from "./store";
import { MetaCrmError, verifyDatasetOwnership } from "./datasets";
import {
  buildCrmEventPayload,
  leadQualityToEvent,
  sendCrmEvent,
  type CrmEventName,
} from "./lead-quality";
import { resolveLeadMatchHashes } from "./matching";

// ---------- config ---------------------------------------------

export interface CrmFeedbackConfig {
  account_id: string;
  dataset_ref: string | null;
  dataset_id: string | null;
  business_portfolio_id: string | null;
  dataset_name: string | null;
  /**
   * Dedicated Meta CRM access token, application-encrypted
   * (AES-256-GCM). NEVER the Meta Lead Ads connection token, never
   * plaintext, never returned by any API.
   */
  access_token: string | null;
  enabled: boolean;
  verified_at: string | null;
  last_error: string | null;
  last_event_at: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
  /**
   * Opt-in: automatically enqueue the initial `Lead` event when a
   * new Meta Instant Form lead arrives. Defaults to false — later
   * stages are always manual.
   */
  auto_send_lead: boolean;
  /**
   * UI-only: display the Lead Quality column in Workspace tables.
   * Defaults to true. Hiding changes nothing stored or sent.
   */
  show_lead_quality: boolean;
  /**
   * Enforced table allowlist: Meta Lead Ads flow ids whose leads
   * may send CRM events to Meta. NULL (including all rows created
   * before this column existed) = unrestricted legacy behavior.
   * An explicit array — even empty — is enforced everywhere
   * (enqueue, preview/manual send, drain). Names are never
   * stored, so renames cannot corrupt the selection.
   */
  allowed_flow_ids: string[] | null;
}

export interface PublicCrmFeedbackConfig {
  enabled: boolean;
  datasetId: string | null;
  businessPortfolioId: string | null;
  datasetName: string | null;
  verifiedAt: string | null;
  lastError: string | null;
  lastEventAt: string | null;
  /** Whether a CRM token is stored — the value itself never leaves the server. */
  hasToken: boolean;
  /** Opt-in automatic initial Lead events for new Meta leads. */
  autoSendLead: boolean;
  /** UI-only: display the Lead Quality column in Workspace tables. */
  showLeadQuality: boolean;
  /**
   * Enforced table allowlist (flow ids). Null = unrestricted
   * legacy behavior; an explicit array (even empty) is enforced.
   */
  allowedFlowIds: string[] | null;
}

export function toPublicCrmFeedbackConfig(row: CrmFeedbackConfig | null): PublicCrmFeedbackConfig {
  return {
    enabled: row?.enabled ?? false,
    datasetId: row?.dataset_id ?? null,
    businessPortfolioId: row?.business_portfolio_id ?? null,
    datasetName: row?.dataset_name ?? null,
    verifiedAt: row?.verified_at ?? null,
    lastError: row?.last_error ?? null,
    lastEventAt: row?.last_event_at ?? null,
    hasToken: !!row?.access_token,
    autoSendLead: row?.auto_send_lead ?? false,
    showLeadQuality: row?.show_lead_quality ?? true,
    allowedFlowIds: Array.isArray(row?.allowed_flow_ids)
      ? (row.allowed_flow_ids as unknown[]).filter((v): v is string => typeof v === "string")
      : null,
  };
}

export async function getCrmFeedbackConfig(
  db: SupabaseClient,
  accountId: string,
): Promise<CrmFeedbackConfig | null> {
  const { data, error } = await db
    .from("meta_crm_config")
    .select("*")
    .eq("account_id", accountId)
    .maybeSingle();
  if (error) throw error;
  return (data as CrmFeedbackConfig | null) ?? null;
}

/**
 * Table allowlist check: may this Workspace table's leads send CRM
 * events to Meta?
 *
 * - No config row, or an `allowed_flow_ids` of NULL (every row
 *   predating migration 183), means the owner never configured a
 *   selection → unrestricted legacy behavior (true).
 * - A missing `allowed_flow_ids` column (migration 183 not
 *   applied) also means no selection could exist → unrestricted
 *   (true), never a send-time 500.
 * - An explicit array (even empty) is enforced by stable flow id:
 *   names are never consulted, so renames cannot bypass or break
 *   the check. An unattributable (empty/unknown) flow id under an
 *   explicit allowlist fails closed (false).
 */
export async function isFlowAllowedForCrm(
  db: SupabaseClient,
  accountId: string,
  flowId: string | null | undefined,
): Promise<boolean> {
  let config: CrmFeedbackConfig | null;
  try {
    config = await getCrmFeedbackConfig(db, accountId);
  } catch (err) {
    if (isMissingConfigColumn(err, "allowed_flow_ids")) return true;
    throw err;
  }
  if (!config) return true;
  const raw: unknown = (config as { allowed_flow_ids?: unknown }).allowed_flow_ids;
  if (raw === null || raw === undefined) return true;
  if (!Array.isArray(raw)) return true;
  if (typeof flowId !== "string" || flowId === "") return false;
  return (raw as unknown[]).some((v) => v === flowId);
}

/** Exact user-facing message when a table is not selected for CRM sending. */
export const TABLE_NOT_SELECTED_MESSAGE =
  "Meta CRM sending is disabled for this Workspace table. Enable this table in CRM Integration settings to send events.";

/**
 * Save the per-account feedback config. Enabling requires a
 * dataset that belongs to this account AND a dedicated Meta CRM
 * access token that passes Meta verification (fail closed).
 * Disabling (or clearing the dataset) never needs verification and
 * never erases the stored token.
 *
 * Token semantics (`accessToken` arg):
 *   * `undefined` → keep the currently stored token (including on
 *     disable — temporarily switching feedback off never erases it).
 *   * `""`        → securely remove the stored token.
 *   * non-empty   → validate + verify the replacement against the
 *     chosen dataset, then store it encrypted.
 *
 * `autoSendLead` / `showLeadQuality` (when provided) are stored
  * in both paths —
 * disabling feedback never implies disabling the preference, and
 * enabling never flips it on silently. Omitted → preserved.
 *
 * The Meta Lead Ads connection token is NEVER consulted here — not
 * for verification, not for sending, not as a fallback.
 */
export async function saveCrmFeedbackConfig(
  db: SupabaseClient,
  args: {
    accountId: string;
    enabled: boolean;
    datasetRowId: string | null;
    actorUserId: string;
    accessToken?: string;
    autoSendLead?: boolean;
    showLeadQuality?: boolean;
    /**
     * Enforced table allowlist (Meta Lead Ads flow ids).
     * `undefined` = preserve the stored value. An explicit array
     * (even empty) replaces it after ownership validation: every
     * id must be one of this account's Meta Lead Ads tables.
     */
    allowedFlowIds?: string[];
    fetchImpl?: typeof fetch;
  },
): Promise<{ config: CrmFeedbackConfig; ownershipVerified: boolean }> {
  const { data: datasets, error: dsErr } = await db
    .from("meta_crm_datasets")
    .select("id, dataset_id, business_portfolio_id, dataset_name")
    .eq("account_id", args.accountId);
  if (dsErr) throw dsErr;
  const rows = (datasets ?? []) as Array<{
    id: string;
    dataset_id: string;
    business_portfolio_id: string;
    dataset_name: string;
  }>;

  if (!args.enabled) {
    // Disabling clears the dataset selection but NEVER the stored
    // CRM token (explicit removal only) and never needs Meta.
    const tokenPatch: Record<string, unknown> =
      args.accessToken === undefined
        ? {}
        : args.accessToken.trim() === ""
          ? { access_token: null }
          : { access_token: encrypt(args.accessToken.trim()) };
    // Ownership-validated table allowlist rides along when the
    // caller provides it (omitted = preserved).
    const tablesPatch = await resolveAllowedFlowIdsPatch(db, args.accountId, args.allowedFlowIds);
    const { data, error } = await db
      .from("meta_crm_config")
      .upsert(
        {
          account_id: args.accountId,
          dataset_ref: null,
          dataset_id: null,
          business_portfolio_id: null,
          dataset_name: null,
          enabled: false,
          verified_at: null,
          last_error: null,
          updated_by: args.actorUserId,
          updated_at: new Date().toISOString(),
          ...tokenPatch,
          ...tablesPatch,
          ...(args.autoSendLead === undefined ? {} : { auto_send_lead: args.autoSendLead }),
          ...(args.showLeadQuality === undefined ? {} : { show_lead_quality: args.showLeadQuality }),
        },
        { onConflict: "account_id" },
      )
      .select("*")
      .single();
    if (error || !data) throw error ?? new Error("Failed to save CRM feedback config.");
    return { config: data as CrmFeedbackConfig, ownershipVerified: false };
  }

  const chosen = rows.find((r) => r.id === args.datasetRowId);
  if (!chosen) {
    throw new MetaCrmError({
      code: "invalid_input",
      message: "Select a CRM dataset from this workspace first.",
      status: 400,
    });
  }

  // Resolve the dedicated CRM token: an explicit replacement wins,
  // explicit removal while enabling is rejected, otherwise the
  // stored token applies. The Meta Lead Ads connection token is
  // never consulted — not here, not at send time, never.
  const tokenOp =
    args.accessToken === undefined
      ? "keep"
      : args.accessToken.trim() === ""
        ? "remove"
        : "replace";
  if (tokenOp === "remove") {
    throw new MetaCrmError({
      code: "invalid_input",
      message: "Cannot enable CRM feedback while removing its access token. Save a replacement token first.",
      status: 400,
    });
  }
  const candidateToken = tokenOp === "replace" ? (args.accessToken as string).trim() : null;
  let effectiveToken: string | null = candidateToken;
  if (!effectiveToken) {
    try {
      effectiveToken = await getCrmAccessToken(db, args.accountId);
    } catch {
      effectiveToken = null;
    }
  }
  if (!effectiveToken) {
    throw new MetaCrmError({
      code: "invalid_input",
      message: "Add a Meta CRM access token below before enabling feedback. The token is verified against the selected dataset.",
      status: 400,
    });
  }

  // Verify with the dedicated CRM credential only. Every uncertainty
  // surfaces its own precise error (expired token, missing
  // permission, bad portfolio id, outage) — never the generic
  // ownership message. A saved-then-stored token is re-verified on
  // every enable; saving alone never marks anything verified.
  const token: string = effectiveToken;
  let ownership: { verified: true } | { verified: false; reason: string };
  try {
    ownership = await verifyDatasetOwnership({
      businessPortfolioId: chosen.business_portfolio_id,
      datasetId: chosen.dataset_id,
      accessToken: token,
      fetchImpl: args.fetchImpl ?? fetch,
    });
  } catch (err) {
    // Precise failure (auth / permission / bad id / outage):
    // record it verbatim and stay disabled. Fail closed, but loud.
    const message =
      err instanceof MetaCrmError
        ? err.message
        : "Could not verify dataset ownership with Meta. Try again.";
    const { error: saveErr } = await db
      .from("meta_crm_config")
      .upsert(
        {
          account_id: args.accountId,
          dataset_ref: chosen.id,
          dataset_id: chosen.dataset_id,
          business_portfolio_id: chosen.business_portfolio_id,
          dataset_name: chosen.dataset_name,
          enabled: false,
          verified_at: null,
          last_error: message.slice(0, 500),
          updated_by: args.actorUserId,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "account_id" },
      );
    if (saveErr) throw saveErr;
    throw err;
  }
  if (!ownership.verified) {
    const { error } = await db
      .from("meta_crm_config")
      .upsert(
        {
          account_id: args.accountId,
          dataset_ref: chosen.id,
          dataset_id: chosen.dataset_id,
          business_portfolio_id: chosen.business_portfolio_id,
          dataset_name: chosen.dataset_name,
          enabled: false,
          verified_at: null,
          last_error: ownership.reason.slice(0, 500),
          updated_by: args.actorUserId,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "account_id" },
      );
    if (error) throw error;
    throw new MetaCrmError({
      code: "forbidden",
      message: ownership.reason,
      status: 403,
    });
  }

  const now = new Date().toISOString();
  // Ownership-validated table allowlist (omitted = preserved).
  const tablesPatch = await resolveAllowedFlowIdsPatch(db, args.accountId, args.allowedFlowIds);
  const { data, error } = await db
    .from("meta_crm_config")
    .upsert(
      {
        account_id: args.accountId,
        dataset_ref: chosen.id,
        dataset_id: chosen.dataset_id,
        business_portfolio_id: chosen.business_portfolio_id,
        dataset_name: chosen.dataset_name,
        enabled: true,
        verified_at: now,
        last_error: null,
        updated_by: args.actorUserId,
        updated_at: now,
        // Store the replacement only after it verified above.
        // Untouched (`keep`) omits the key so the stored token
        // survives the upsert byte-for-byte. The auto-send
        // preference rides along only when explicitly provided.
        ...(tokenOp === "replace" ? { access_token: encrypt(candidateToken as string) } : {}),
        ...tablesPatch,
        ...(args.autoSendLead === undefined ? {} : { auto_send_lead: args.autoSendLead }),
        ...(args.showLeadQuality === undefined ? {} : { show_lead_quality: args.showLeadQuality }),
      },
      { onConflict: "account_id" },
    )
    .select("*")
    .single();
  if (error || !data) throw error ?? new Error("Failed to save CRM feedback config.");
  return { config: data as CrmFeedbackConfig, ownershipVerified: true };
}

/**
 * Validate + normalize a caller-provided table allowlist. Omitted
 * (`undefined`) = preserve the stored value (no key in the patch).
 * An explicit array replaces it after ownership validation: every
 * id must be one of this account's Meta Lead Ads tables
 * (names are never trusted — ids only). Unknown, foreign, or
 * non-Meta ids are rejected, never silently stored.
 */
async function resolveAllowedFlowIdsPatch(
  db: SupabaseClient,
  accountId: string,
  allowedFlowIds: string[] | undefined,
): Promise<Record<string, unknown>> {
  if (allowedFlowIds === undefined) return {};
  if (!Array.isArray(allowedFlowIds)) {
    throw new MetaCrmError({
      code: "invalid_input",
      message: "Select Workspace tables from this account's Meta Lead Ads tables.",
      status: 400,
    });
  }
  const ids = [...new Set(allowedFlowIds.filter((v): v is string => typeof v === "string"))];
  if (ids.length === 0) return { allowed_flow_ids: [] };
  const { data, error } = await db
    .from("flows")
    .select("id")
    .eq("account_id", accountId)
    .eq("kind", "meta_lead_ads")
    .in("id", ids);
  if (error) throw error;
  const own = new Set(((data ?? []) as Array<{ id: unknown }>).map((r) => r.id));
  const foreign = ids.filter((id) => !own.has(id));
  if (foreign.length > 0) {
    throw new MetaCrmError({
      code: "invalid_input",
      message: "Select Workspace tables from this account's Meta Lead Ads tables.",
      status: 400,
    });
  }
  return { allowed_flow_ids: ids };
}

/**
 * True when a Supabase/PostgREST error means the named
 * meta_crm_config column does not exist — i.e. its migration has
 * not been applied in this environment. The error is a plain
 * object (no `.status`), which is exactly what toErrorResponse
 * turns into a bare 500, so callers must map it to an actionable
 * message instead.
 */
export function isMissingConfigColumn(err: unknown, column: "access_token" | "auto_send_lead" | "show_lead_quality" | "allowed_flow_ids"): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  const message = (err as { message?: unknown }).message;
  return (
    code === "42703" &&
    typeof message === "string" &&
    message.includes(column)
  );
}

export function isMissingAccessTokenColumn(err: unknown): boolean {
  return isMissingConfigColumn(err, "access_token");
}

/** Actionable message when migrations 176–178 are missing (shared by routes). */
export const TOKEN_STORAGE_MISSING_MESSAGE =
  "CRM storage is not ready: database migrations 176–178 have not been applied. Apply them, then save again.";

/** Actionable message when migration 183 is missing (shared by routes). */
export const TABLES_STORAGE_MISSING_MESSAGE =
  "CRM table selection is not ready yet: database migration 183_meta_crm_allowed_tables has not been applied. Apply it, then save again.";

/**
 * Retrieve the workspace's dedicated Meta CRM access token,
 * decrypted in server memory only. Throws `invalid_input` when no
 * token is stored (callers park the work instead of retrying) and
 * never logs or returns the value. A missing storage column (42703
 * when migration 176 is not applied) becomes an actionable 503,
 * never a bare 500. The Meta Lead Ads connection token is never
 * consulted.
 */
export async function getCrmAccessToken(
  db: SupabaseClient,
  accountId: string,
): Promise<string> {
  const { data, error } = await db
    .from("meta_crm_config")
    .select("access_token")
    .eq("account_id", accountId)
    .maybeSingle();
  if (error) {
    if (isMissingAccessTokenColumn(error)) {
      throw new MetaCrmError({
        code: "invalid_input",
        message: TOKEN_STORAGE_MISSING_MESSAGE,
        status: 503,
      });
    }
    throw error;
  }
  const encrypted = (data as { access_token: string | null } | null)?.access_token;
  if (!encrypted) {
    throw new MetaCrmError({
      code: "invalid_input",
      message:
        "No Meta CRM access token is configured for this workspace. Add one in Settings → Meta → CRM Integration before sending.",
      status: 400,
    });
  }
  try {
    return decrypt(encrypted);
  } catch {
    throw new MetaCrmError({
      code: "invalid_input",
      message:
        "The stored Meta CRM access token cannot be read. Save a new token in Settings → Meta → CRM Integration.",
      status: 400,
    });
  }
}

// ---------- events ----------------------------------------------

export type CrmEventStatus = "pending" | "sent" | "failed" | "skipped";

export interface CrmEventRow {
  id: string;
  account_id: string;
  flow_id: string | null;
  flow_run_id: string | null;
  submission_id: string | null;
  meta_lead_id: string;
  event_name: string;
  from_quality: string;
  to_quality: string;
  event_time: string;
  event_uuid: string;
  dataset_id: string;
  status: CrmEventStatus;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  meta_response: unknown;
  next_retry_at: string;
  sent_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface EnqueueLeadQualityEventArgs {
  accountId: string;
  flowId: string | null;
  runId: string;
  /** Stored display values ("" = implicit initial Lead). */
  fromQuality: string;
  toQuality: string;
  eventTimeIso: string;
  actorUserId: string | null;
  /** Injectable Meta fetch for tests (verification only). */
  fetchImpl?: typeof fetch;
}

/** A previously recorded event for one dataset + lead + event name. */
export interface ExistingCrmEvent {
  id: string;
  status: string;
}

/**
 * Cross-table duplicate lookup: the newest recorded row for one
 * Meta dataset + Meta Lead ID + event name, regardless of table,
 * run, or quality transition. Preference order is sent, then
 * pending, then failed, then skipped (newest first within a
 * state), so callers report the most meaningful delivery state.
 * Returns null when nothing was ever recorded — the ONLY case in
 * which a new submission may be created.
 */
export async function findExistingCrmEvent(
  db: SupabaseClient,
  args: { accountId: string; datasetId: string | null; metaLeadId: string; eventName: string },
): Promise<ExistingCrmEvent | null> {
  if (!args.datasetId || !args.metaLeadId.trim()) return null;
  const { data, error } = await db
    .from("meta_crm_events")
    .select("id, status, created_at")
    .eq("account_id", args.accountId)
    .eq("dataset_id", args.datasetId)
    .eq("meta_lead_id", args.metaLeadId.trim())
    .eq("event_name", args.eventName)
    .order("created_at", { ascending: false })
    .limit(25);
  if (error) throw error;
  const rows = ((data ?? []) as Array<{ id: unknown; status: unknown; created_at: unknown }>).filter(
    (r) => typeof r.id === "string" && r.id !== "",
  );
  if (rows.length === 0) return null;
  const rank = (s: unknown): number =>
    s === "sent" ? 0 : s === "pending" ? 1 : s === "failed" ? 2 : s === "skipped" ? 3 : 4;
  rows.sort((a, b) => {
    const byStatus = rank(a.status) - rank(b.status);
    if (byStatus !== 0) return byStatus;
    return String(b.created_at ?? "") < String(a.created_at ?? "") ? -1 : 1;
  });
  const winner = rows[0];
  return {
    id: winner.id as string,
    status: typeof winner.status === "string" ? winner.status : "pending",
  };
}

export type EnqueueOutcome =
  | { enqueued: true; eventId: string; deduplicated: boolean }
  | { enqueued: false; reason: "unchanged" | "unmapped" | "disabled" | "no_meta_lead" | "table_not_selected" };

export type AutoLeadOutcome =
  | { enqueued: true; eventId: string; deduplicated: boolean }
  | { enqueued: false; reason: "auto_send_off" | "disabled" | "no_token" | "no_meta_lead" | "table_not_selected" };

/**
 * Opt-in automatic initial `Lead` event for a newly received Meta
 * Instant Form lead. Enqueues exactly one ledger row per lead
 * (from "" to "Lead"); webhook retries and reprocessing collapse
 * via the ledger UNIQUE key to `deduplicated`. Returns without
 * writing when the workspace has not opted in (`auto_send_off`),
 * feedback is disabled/unconfigured (`disabled`), or no dedicated
 * CRM token is stored (`no_token`). Never throws for any of those
 * gates — only for unexpected database failures, which callers
 * isolate so lead capture is unaffected. The dedicated CRM token
 * is resolved (not merely presence-checked) so a corrupt row fails
 * closed here instead of at send time.
 */
export async function maybeEnqueueInitialLeadEvent(
  db: SupabaseClient,
  args: { accountId: string; flowId: string | null; runId: string; eventTimeIso: string },
): Promise<AutoLeadOutcome> {
  let config: CrmFeedbackConfig | null;
  try {
    config = await getCrmFeedbackConfig(db, args.accountId);
  } catch (err) {
    // A missing auto_send_lead column (migration 177 not applied)
    // means the opt-in cannot exist yet — treat as opted out, and
    // never let a schema gap fail lead capture.
    if (isMissingConfigColumn(err, "auto_send_lead")) return { enqueued: false, reason: "auto_send_off" };
    throw err;
  }
  if (!config?.auto_send_lead) return { enqueued: false, reason: "auto_send_off" };
  if (!config.enabled || !config.dataset_id) return { enqueued: false, reason: "disabled" };
  try {
    await getCrmAccessToken(db, args.accountId);
  } catch {
    return { enqueued: false, reason: "no_token" };
  }
  const outcome = await enqueueLeadQualityEvent(db, {
    accountId: args.accountId,
    flowId: args.flowId,
    runId: args.runId,
    fromQuality: "",
    toQuality: "Lead",
    eventTimeIso: args.eventTimeIso,
    actorUserId: null,
  });
  if (!outcome.enqueued) {
    // Preserve the precise downstream reason: an unmapped status
    // or an unselected table is not a generic "disabled".
    if (outcome.reason === "no_meta_lead" || outcome.reason === "table_not_selected") {
      return { enqueued: false as const, reason: outcome.reason };
    }
    return { enqueued: false as const, reason: "disabled" as const };
  }
  return outcome;
}

/**
 * Enqueue one CRM event for a genuine quality transition. Returns
 * without writing when: nothing changed, the value maps to no
 * event, feedback is disabled/unconfigured, or the run has no
 * original Meta Lead ID (non-Meta leads keep internal status
 * only — never fabricated). Never throws for missing config.
 */
export async function enqueueLeadQualityEvent(
  db: SupabaseClient,
  args: EnqueueLeadQualityEventArgs,
): Promise<EnqueueOutcome> {
  const from = (args.fromQuality ?? "").trim();
  const to = (args.toQuality ?? "").trim();
  if (from.toLowerCase() === to.toLowerCase()) return { enqueued: false, reason: "unchanged" };

  const eventName = leadQualityToEvent(to);
  if (!eventName) return { enqueued: false, reason: "unmapped" };

  // Only Meta Instant Form leads carry the original lead id.
  const { data: sub, error: subErr } = await db
    .from("meta_lead_submissions")
    .select("id, meta_lead_id")
    .eq("account_id", args.accountId)
    .eq("flow_run_id", args.runId)
    .maybeSingle();
  if (subErr) throw subErr;
  const submission = sub as { id: string; meta_lead_id: string } | null;
  if (!submission || !submission.meta_lead_id.trim()) {
    return { enqueued: false, reason: "no_meta_lead" };
  }

  const config = await getCrmFeedbackConfig(db, args.accountId);
  if (!config || !config.enabled || !config.dataset_id) {
    return { enqueued: false, reason: "disabled" };
  }

  // Table allowlist: only leads from selected Workspace tables
  // may enqueue (automatic and manual alike). Unconfigured (NULL)
  // or pre-migration configs stay unrestricted; an explicit
  // selection (even empty) is enforced by stable flow id.
  if (!(await isFlowAllowedForCrm(db, args.accountId, args.flowId))) {
    return { enqueued: false, reason: "table_not_selected" };
  }

  // Cross-table duplicate prevention: one dataset + one Meta lead
  // + one event name = at most one submission, regardless of
  // table or run. A prior row in ANY state blocks a fresh insert
  // (pending/sent must not duplicate; failed/skipped go through
  // the controlled retry of the existing row, never a new row).
  // This check is advisory — the partial unique index
  // meta_crm_events_dataset_lead_event_key enforces the pending/
  // sent subset atomically for concurrent submissions.
  const crossTable = await findExistingCrmEvent(db, {
    accountId: args.accountId,
    datasetId: config.dataset_id,
    metaLeadId: submission.meta_lead_id,
    eventName,
  });
  if (crossTable) {
    return { enqueued: true, eventId: crossTable.id, deduplicated: true };
  }

  const { data, error } = await db
    .from("meta_crm_events")
    .insert({
      account_id: args.accountId,
      flow_id: args.flowId,
      flow_run_id: args.runId,
      submission_id: submission.id,
      meta_lead_id: submission.meta_lead_id,
      event_name: eventName,
      from_quality: from,
      to_quality: to,
      event_time: args.eventTimeIso,
      dataset_id: config.dataset_id,
    })
    .select("id")
    .single();
  if (!error && data) {
    return { enqueued: true, eventId: (data as { id: string }).id, deduplicated: false };
  }
  if (error && isUniqueViolation(error)) {
    const { data: existing } = await db
      .from("meta_crm_events")
      .select("id")
      .eq("account_id", args.accountId)
      .eq("flow_run_id", args.runId)
      .eq("event_name", eventName)
      .eq("from_quality", from)
      .eq("to_quality", to)
      .maybeSingle();
    if (existing) {
      return { enqueued: true, eventId: (existing as { id: string }).id, deduplicated: true };
    }
  }
  throw error ?? new Error("Failed to enqueue CRM event.");
}

/** Bounded exponential backoff: 1m, 2m, 4m … capped at 30m. */
export function crmRetryDelayMs(attempt: number): number {
  const step = Math.max(0, attempt - 1);
  return Math.min(60_000 * 2 ** step, 30 * 60_000);
}

export const CRM_MAX_ATTEMPTS = 8;
export const CRM_DRAIN_LIMIT = 20;

export interface CrmDrainResult {
  attempted: number;
  sent: number;
  failed: number;
  skipped: number;
}

/**
 * Send due pending events. Per-row isolated: one row's failure
 * never affects others. Retries resend the identical stored
 * payload (same occurrence, same transition); no `event_id` is
 * ever sent to Meta — the row's event_uuid stays internal.
 * Terminal states: sent / failed (attempts spent) /
 * skipped (feedback disabled or misconfigured at send time).
 */
export async function drainCrmEventsQueue(
  db: SupabaseClient,
  opts: { limit?: number; onlyAccountId?: string; fetchImpl?: typeof fetch; eventIds?: string[] } = {},
): Promise<CrmDrainResult> {
  const limit = Math.max(1, Math.min(opts.limit ?? CRM_DRAIN_LIMIT, 100));
  const out: CrmDrainResult = { attempted: 0, sent: 0, failed: 0, skipped: 0 };
  let query = db
    .from("meta_crm_events")
    .select("*")
    .eq("status", "pending")
    .lte("next_retry_at", new Date().toISOString())
    .order("next_retry_at", { ascending: true })
    .limit(limit);
  if (opts.onlyAccountId) query = query.eq("account_id", opts.onlyAccountId);
  // Targeted drain for manual sends: restrict to specific rows while
  // keeping the pending-only gate, so an already-sent duplicate can
  // never be re-sent by a concurrent manual click.
  if (opts.eventIds && opts.eventIds.length > 0) {
    query = query.in("id", opts.eventIds.slice(0, 100));
  }
  const { data, error } = await query;
  if (error) throw error;
  const rows = ((data ?? []) as CrmEventRow[]).filter((r) => typeof r.id === "string");
  if (rows.length === 0) return out;

  // Attribute rows whose flow was nulled (flow deleted) back to
  // their run's flow in ONE batched read — never N+1. Rows that
  // stay unattributable keep their stored flow (possibly null)
  // and are decided by the allowlist check below.
  const missingFlowRunIds = [
    ...new Set(
      rows
        .filter((r) => typeof r.flow_id !== "string" || r.flow_id === "")
        .map((r) => r.flow_run_id)
        .filter((v): v is string => typeof v === "string" && v !== ""),
    ),
  ];
  const flowIdByRun = new Map<string, string>();
  if (missingFlowRunIds.length > 0) {
    const { data: runRows, error: runErr } = await db
      .from("flow_runs")
      .select("id, flow_id")
      .in("id", missingFlowRunIds);
    if (runErr) throw runErr;
    for (const r of ((runRows ?? []) as Array<{ id: unknown; flow_id: unknown }>)) {
      if (typeof r.id === "string" && typeof r.flow_id === "string") {
        flowIdByRun.set(r.id, r.flow_id);
      }
    }
  }

  for (const row of rows) {
    out.attempted += 1;
    try {
      const config = await getCrmFeedbackConfig(db, row.account_id);
      if (!config || !config.enabled || !config.dataset_id) {
        await db
          .from("meta_crm_events")
          .update({
            status: "skipped",
            last_error: "CRM feedback disabled or unconfigured at send time.",
            updated_at: new Date().toISOString(),
          })
          .eq("id", row.id);
        out.skipped += 1;
        continue;
      }
      // Table allowlist re-check at delivery time: a table
      // deselected after enqueue must not deliver. Unconfigured
      // (NULL) or pre-migration configs stay unrestricted;
      // previously sent rows are history and never revisited
      // (pending-only selection above).
      const rowFlowId =
        typeof row.flow_id === "string" && row.flow_id !== ""
          ? row.flow_id
          : typeof row.flow_run_id === "string"
            ? (flowIdByRun.get(row.flow_run_id) ?? null)
            : null;
      if (!(await isFlowAllowedForCrm(db, row.account_id, rowFlowId))) {
        await db
          .from("meta_crm_events")
          .update({
            status: "skipped",
            last_error: TABLE_NOT_SELECTED_MESSAGE,
            updated_at: new Date().toISOString(),
          })
          .eq("id", row.id);
        out.skipped += 1;
        continue;
      }
      // Authentication: the workspace's dedicated Meta CRM access
      // token ONLY. The Meta Lead Ads connection token is never
      // consulted here — no fallback, no mixing across workspaces
      // (every query is account-scoped). A missing token parks the
      // row as skipped with a meaningful message (it can never
      // succeed on retry until a token is configured).
      let token: string;
      try {
        token = await getCrmAccessToken(db, row.account_id);
      } catch (err) {
        if (err instanceof MetaCrmError && err.code === "invalid_input") {
          await db
            .from("meta_crm_events")
            .update({
              status: "skipped",
              last_error: err.message.slice(0, 500),
              updated_at: new Date().toISOString(),
            })
            .eq("id", row.id);
          out.skipped += 1;
          continue;
        }
        throw err;
      }
      let response: unknown = null;
      try {
        // Built inside the guarded section: a builder rejection
        // (bad id, bad time) lands in the invalid_input branch
        // below (skipped), never in the retry loop.
        const payload = buildCrmEventPayload({
          eventName: row.event_name as CrmEventName,
          eventTimeIso: row.event_time,
          metaLeadId: row.meta_lead_id,
          // Matching identifiers are resolved from the lead at send
          // time (same resolver the preview uses) — the ledger row
          // keeps the occurrence + identity, never raw PII. The
          // row's event_uuid is intentionally NOT passed: it stays
          // internal and never reaches Meta.
          match: await resolveRowMatchHashes(db, row),
        });
        ({ response } = await sendCrmEvent({
          datasetId: config.dataset_id,
          accessToken: token,
          payload,
          fetchImpl: opts.fetchImpl ?? fetch,
        }));
      } catch (err) {
        if (err instanceof MetaCrmError) {
          // Invalid input (bad id, bad time) can never succeed on
          // retry — park the row as skipped with the reason instead
          // of burning all attempts. Auth/permission failures still
          // retry until attempts are spent (the token may be
          // refreshed or re-granted).
          if (err.code === "invalid_input") {
            await db
              .from("meta_crm_events")
              .update({
                status: "skipped",
                last_error: err.message,
                updated_at: new Date().toISOString(),
              })
              .eq("id", row.id);
            out.skipped += 1;
            continue;
          }
          // Auth/permission failures still retry until attempts are
          // spent (the token may be refreshed or re-granted); the
          // diagnostic is preserved on the row either way.
          await failRow(db, row, err.message, true);
          out.failed += 1;
          continue;
        }
        throw err;
      }
      await db
        .from("meta_crm_events")
        .update({
          status: "sent",
          attempts: row.attempts + 1,
          last_error: null,
          meta_response: (response ?? null) as never,
          sent_at: new Date().toISOString(),
          next_retry_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id);
      await db
        .from("meta_crm_config")
        .update({ last_event_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("account_id", row.account_id);
      out.sent += 1;
    } catch (err) {
      console.error(
        "[meta-crm] event drain row failed:",
        err instanceof Error ? err.message : err,
      );
      try {
        await failRow(db, row, "Unexpected delivery error.", true);
      } catch {
        // Best-effort only; the next sweep retries.
      }
      out.failed += 1;
    }
  }
  return out;
}

/**
 * Match hashes for one ledger row at drain time. Best-effort: a
 * resolver failure must never lose the valid lead_id match, so it
 * resolves to no extra identifiers (the payload still carries the
 * exact Meta Lead ID) rather than failing the row.
 */
async function resolveRowMatchHashes(
  db: SupabaseClient,
  row: CrmEventRow,
): Promise<{ em: string[]; ph: string[] }> {
  try {
    const match = await resolveLeadMatchHashes(db, {
      accountId: row.account_id ?? "",
      runId: row.flow_run_id ?? "",
    });
    return { em: match.em, ph: match.ph };
  } catch {
    return { em: [], ph: [] };
  }
}

async function failRow(
  db: SupabaseClient,
  row: CrmEventRow,
  message: string,
  retryable: boolean,
): Promise<void> {
  const attempt = row.attempts + 1;
  const willRetry = retryable && attempt < Math.min(row.max_attempts || CRM_MAX_ATTEMPTS, 32);
  await db
    .from("meta_crm_events")
    .update({
      status: willRetry ? "pending" : "failed",
      attempts: attempt,
      last_error: message.slice(0, 500),
      next_retry_at: new Date(Date.now() + crmRetryDelayMs(attempt)).toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id);
}
