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
  token_app_id: string | null;
  token_type: string | null;
  dataset_id: string | null;
  setup_source: "oauth" | "manual";
  status: "connected" | "needs_reauth" | "revoked";
  last_error: string | null;
  connected_by: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Store the manually-pasted credentials. The token is encrypted at
 * rest and never returned. A pasted System User token is treated as
 * long-lived (no refresh loop); a revoked token is surfaced as
 * `needs_reauth` by the processing path.
 */
export async function saveCredentials(
  db: SupabaseClient,
  accountId: string,
  input: {
    accessToken: string;
    datasetId: string | null;
    pageName: string | null;
    connectedBy: string | null;
  },
): Promise<void> {
  const { error } = await db.from("meta_lead_connections").upsert(
    {
      account_id: accountId,
      meta_user_name: input.pageName,
      access_token: encrypt(input.accessToken),
      dataset_id: input.datasetId,
      setup_source: "manual",
      token_expiry: null,
      status: "connected",
      last_error: null,
      connected_by: input.connectedBy,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "account_id" },
  );
  if (error) throw error;
}

/**
 * Store an OAuth-issued connection. `datasetId` is omitted when
 * undefined so an existing dataset is never cleared by accident.
 */
export async function saveOAuthConnection(
  db: SupabaseClient,
  accountId: string,
  input: {
    accessToken: string;
    tokenExpiry: string | null;
    scopes: string[];
    metaUserId: string | null;
    metaUserName: string | null;
    tokenAppId: string;
    tokenType: string | null;
    datasetId?: string | null;
    connectedBy: string | null;
  },
): Promise<void> {
  const payload: Record<string, unknown> = {
    account_id: accountId,
    meta_user_id: input.metaUserId,
    meta_user_name: input.metaUserName,
    access_token: encrypt(input.accessToken),
    token_expiry: input.tokenExpiry,
    scopes: input.scopes.join(","),
    token_app_id: input.tokenAppId,
    token_type: input.tokenType,
    setup_source: "oauth",
    status: "connected",
    last_error: null,
    connected_by: input.connectedBy,
    updated_at: new Date().toISOString(),
  };
  if (input.datasetId !== undefined) {
    payload.dataset_id = input.datasetId;
  }
  const { error } = await db
    .from("meta_lead_connections")
    .upsert(payload, { onConflict: "account_id" });
  if (error) throw error;
}

export interface OAuthPageOption {
  id: string;
  name: string | null;
  tasks: string[];
}

export interface OAuthSessionRow {
  id: string;
  account_id: string;
  user_id: string;
  access_token: string;
  token_expiry: string | null;
  scopes: string[];
  meta_user_id: string | null;
  meta_user_name: string | null;
  pages: OAuthPageOption[];
  expires_at: string;
}

function parseOAuthPages(raw: unknown): OAuthPageOption[] {
  if (!Array.isArray(raw)) return [];
  const out: OAuthPageOption[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id.trim() : "";
    if (!/^\d{5,32}$/.test(id)) continue;
    out.push({
      id,
      name: typeof row.name === "string" ? row.name : null,
      tasks: Array.isArray(row.tasks)
        ? row.tasks.filter((task): task is string => typeof task === "string")
        : [],
    });
  }
  return out;
}

/** Persist a one-time OAuth state hash for CSRF + account binding. */
export async function createOAuthState(
  db: SupabaseClient,
  input: { accountId: string; userId: string; stateHash: string; expiresAt: string },
): Promise<void> {
  const { error } = await db.from("meta_lead_oauth_states").insert({
    account_id: input.accountId,
    user_id: input.userId,
    state_hash: input.stateHash,
    expires_at: input.expiresAt,
  });
  if (error) throw error;
}

/**
 * Atomically consume an unexpired OAuth state. Returns null for
 * replayed, expired, or unknown state.
 */
export async function consumeOAuthState(
  db: SupabaseClient,
  stateHash: string,
): Promise<{ accountId: string; userId: string } | null> {
  const { data, error } = await db
    .from("meta_lead_oauth_states")
    .update({ consumed_at: new Date().toISOString() })
    .eq("state_hash", stateHash)
    .is("consumed_at", null)
    .gt("expires_at", new Date().toISOString())
    .select("account_id, user_id")
    .maybeSingle();
  if (error) throw error;
  const row = data as { account_id: string; user_id: string } | null;
  return row ? { accountId: row.account_id, userId: row.user_id } : null;
}

/** Replace any prior OAuth session before storing a new callback grant. */
export async function createOAuthSession(
  db: SupabaseClient,
  input: {
    accountId: string;
    userId: string;
    accessToken: string;
    tokenExpiry: string | null;
    scopes: string[];
    metaUserId: string | null;
    metaUserName: string | null;
    pages: OAuthPageOption[];
    expiresAt: string;
  },
): Promise<string> {
  const { error: deleteError } = await db
    .from("meta_lead_oauth_sessions")
    .delete()
    .eq("account_id", input.accountId);
  if (deleteError) throw deleteError;

  const { data, error } = await db
    .from("meta_lead_oauth_sessions")
    .insert({
      account_id: input.accountId,
      user_id: input.userId,
      access_token: encrypt(input.accessToken),
      token_expiry: input.tokenExpiry,
      scopes: input.scopes.join(","),
      meta_user_id: input.metaUserId,
      meta_user_name: input.metaUserName,
      pages: input.pages,
      expires_at: input.expiresAt,
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("oauth session insert failed");
  return (data as { id: string }).id;
}

/** Latest unexpired OAuth session for this account, with token decrypted. */
export async function getOAuthSession(
  db: SupabaseClient,
  accountId: string,
): Promise<OAuthSessionRow | null> {
  const { data, error } = await db
    .from("meta_lead_oauth_sessions")
    .select(
      "id, account_id, user_id, access_token, token_expiry, scopes, meta_user_id, meta_user_name, pages, expires_at",
    )
    .eq("account_id", accountId)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  const row = data as
    | {
        id: string;
        account_id: string;
        user_id: string;
        access_token: string;
        token_expiry: string | null;
        scopes: string | null;
        meta_user_id: string | null;
        meta_user_name: string | null;
        pages: unknown;
        expires_at: string;
      }
    | null;
  if (!row) return null;
  return {
    id: row.id,
    account_id: row.account_id,
    user_id: row.user_id,
    access_token: decrypt(row.access_token),
    token_expiry: row.token_expiry,
    scopes:
      (row.scopes ?? "")
        .split(",")
        .map((scope) => scope.trim())
        .filter((scope) => scope !== ""),
    meta_user_id: row.meta_user_id,
    meta_user_name: row.meta_user_name,
    pages: parseOAuthPages(row.pages),
    expires_at: row.expires_at,
  };
}

export async function deleteOAuthSession(
  db: SupabaseClient,
  accountId: string,
): Promise<void> {
  const { error } = await db
    .from("meta_lead_oauth_sessions")
    .delete()
    .eq("account_id", accountId);
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

/** Decrypted System User access token; throws `needs_reauth` when unusable. */
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

/**
 * Decrypted Page token for a Page that THIS account has connected.
 *
 * The Page row MUST exist for `accountId`: falling back to the user
 * token for an arbitrary Page would let an account read leads from a
 * Page it never connected (a cross-tenant leak). When the row exists
 * but Meta omitted a Page token, the user token is used as documented.
 */
export async function getPageToken(
  db: SupabaseClient,
  accountId: string,
  pageId: string,
): Promise<string> {
  const { data, error } = await db
    .from("meta_lead_pages")
    .select("access_token")
    .eq("account_id", accountId)
    .eq("page_id", pageId)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    throw new MetaLeadAdsError(
      "page_not_found",
      "Connect this Facebook Page first.",
      409,
    );
  }
  const encrypted = (data as { access_token: string | null }).access_token;
  if (encrypted) return decrypt(encrypted);
  return getUserToken(db, accountId);
}

/**
 * Flag the connection as needing reauthorization.
 *
 * Callers that observed the connection BEFORE a Graph call must pass
 * `expectedUpdatedAt` (the `updated_at` they read). The update then
 * only applies when the row is still connected AND unchanged, so a
 * slow/stale worker can never overwrite a token the customer re-saved
 * in the meantime.
 */
export async function markNeedsReauth(
  db: SupabaseClient,
  accountId: string,
  error: string,
  opts: { expectedUpdatedAt?: string | null } = {},
): Promise<void> {
  let query = db
    .from("meta_lead_connections")
    .update({
      status: "needs_reauth",
      last_error: error,
      updated_at: new Date().toISOString(),
    })
    .eq("account_id", accountId)
    .eq("status", "connected");
  if (opts.expectedUpdatedAt) {
    query = query.eq("updated_at", opts.expectedUpdatedAt);
  }
  await query;
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
