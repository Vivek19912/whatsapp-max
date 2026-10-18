// ============================================================
// Meta Lead Ads — persistence helpers.
//
// All token reads/writes go through here so encryption is applied
// in exactly one place and no route ever touches a raw token.
// Every query is account-scoped (tenant isolation); callers pass a
// service-role client for webhook/worker paths and the RLS client
// for user-initiated reads.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { encrypt, decrypt } from "@/lib/whatsapp/encryption";

import { MetaLeadAdsError } from "./errors";

const EXPIRY_SKEW_MS = 60_000;

export interface ConnectionRow {
  id: string;
  account_id: string;
  meta_user_id: string | null;
  meta_user_name: string | null;
  access_token: string;
  token_expiry: string | null;
  scopes: string | null;
  status: "connected" | "needs_reauth" | "revoked";
  last_error: string | null;
  connected_by: string | null;
  created_at: string;
  updated_at: string;
}

export async function saveConnection(
  db: SupabaseClient,
  accountId: string,
  grant: {
    accessToken: string;
    expiresAt: Date | null;
    metaUserId?: string | null;
    metaUserName?: string | null;
    scopes?: string | null;
  },
  connectedBy: string | null,
): Promise<void> {
  const { error } = await db.from("meta_lead_connections").upsert(
    {
      account_id: accountId,
      meta_user_id: grant.metaUserId ?? null,
      meta_user_name: grant.metaUserName ?? null,
      access_token: encrypt(grant.accessToken),
      token_expiry: grant.expiresAt ? grant.expiresAt.toISOString() : null,
      scopes: grant.scopes ?? null,
      status: "connected",
      last_error: null,
      connected_by: connectedBy,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "account_id" },
  );
  if (error) throw error;
}

export async function getConnection(
  db: SupabaseClient,
  accountId: string,
): Promise<ConnectionRow | null> {
  const { data } = await db
    .from("meta_lead_connections")
    .select("*")
    .eq("account_id", accountId)
    .maybeSingle();
  return (data as ConnectionRow | null) ?? null;
}

export function isConnectionExpired(row: ConnectionRow, now = Date.now()): boolean {
  if (row.status === "revoked" || row.status === "needs_reauth") return true;
  if (!row.token_expiry) return false; // long-lived / non-expiring
  return new Date(row.token_expiry).getTime() - EXPIRY_SKEW_MS <= now;
}

/** Decrypted long-lived user token; throws `needs_reauth` when unusable. */
export async function getUserToken(
  db: SupabaseClient,
  accountId: string,
): Promise<string> {
  const row = await getConnection(db, accountId);
  if (!row) {
    throw new MetaLeadAdsError("needs_reauth", "No Meta account is connected.", 409);
  }
  if (isConnectionExpired(row)) {
    throw new MetaLeadAdsError(
      "needs_reauth",
      "The Meta authorization has expired. Please reconnect.",
      409,
    );
  }
  return decrypt(row.access_token);
}

/** Decrypted Page token; falls back to the user token when absent. */
export async function getPageToken(
  db: SupabaseClient,
  accountId: string,
  pageId: string,
): Promise<string> {
  const { data } = await db
    .from("meta_lead_pages")
    .select("access_token")
    .eq("account_id", accountId)
    .eq("page_id", pageId)
    .maybeSingle();
  const encrypted = (data as { access_token: string | null } | null)?.access_token;
  if (encrypted) return decrypt(encrypted);
  return getUserToken(db, accountId);
}

export async function markNeedsReauth(
  db: SupabaseClient,
  accountId: string,
  error: string,
): Promise<void> {
  await db
    .from("meta_lead_connections")
    .update({ status: "needs_reauth", last_error: error, updated_at: new Date().toISOString() })
    .eq("account_id", accountId);
}

/** Remove the account authorization + selected pages. Historical
 *  submissions and their Workspace runs are preserved. */
export async function disconnectAccount(
  db: SupabaseClient,
  accountId: string,
): Promise<void> {
  await db.from("meta_lead_connections").delete().eq("account_id", accountId);
  await db.from("meta_lead_pages").delete().eq("account_id", accountId);
  await db
    .from("meta_lead_forms")
    .update({ enabled: false, updated_at: new Date().toISOString() })
    .eq("account_id", accountId);
}

/** Remove one Page + disable its forms (leads are retained). */
export async function disconnectPage(
  db: SupabaseClient,
  accountId: string,
  pageId: string,
): Promise<void> {
  await db
    .from("meta_lead_pages")
    .delete()
    .eq("account_id", accountId)
    .eq("page_id", pageId);
  await db
    .from("meta_lead_forms")
    .update({ enabled: false, updated_at: new Date().toISOString() })
    .eq("account_id", accountId)
    .eq("page_id", pageId);
}
