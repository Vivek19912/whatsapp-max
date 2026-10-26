// ============================================================
// Meta Lead Ads → Google Sheets — dedicated Google OAuth.
//
// SEPARATE from the Flow Tables Google connection
// (`google_connections` + lib/google/oauth). Meta Sheets uses its
// own scopes, its own callback path, its own encrypted tokens in
// `meta_lead_sheets_connections`, and a hashed one-time state in
// `meta_lead_sheets_oauth_states` — so a Flow Tables grant can
// never sync Meta leads and vice versa.
//
// Scopes (least-privileged for the paste-URL + create workflow):
//   spreadsheets  — read/write ONLY the spreadsheets the user can
//                   already access (validate a pasted spreadsheet,
//                   ensure tab + header, append/update rows; also
//                   covers creating a new spreadsheet).
//   userinfo.email — show which Google account is connected.
// We deliberately do NOT request Drive full access. The trade-off
// vs the Flow Tables `drive.file` scope: Meta Sheets CAN work with
// an existing customer spreadsheet (required by the feature), at
// the cost of the sensitive `spreadsheets` scope (Googleuesta
// verification + 100-user cap until verified).
//
// Required env (same Cloud project as Flow Tables is fine):
//   GOOGLE_CLIENT_ID
//   GOOGLE_CLIENT_SECRET
// Redirect URI (whitelist in Cloud Console):
//   {origin}/api/integrations/meta-lead-ads/google/callback
// ============================================================

import crypto from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { decrypt, encrypt } from "@/lib/whatsapp/encryption";
import { parseRetryAfterMs } from "./throttle";

export const META_SHEETS_GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/userinfo.email",
].join(" ");

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT = "https://www.googleapis.com/oauth2/v2/userinfo";

const EXPIRY_SKEW_MS = 60_000;
const STATE_TTL_MS = 10 * 60_000;

export function metaSheetsOAuthConfigured(): boolean {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

/** Redirect URI for the Meta Sheets callback (derived from request). */
export function metaSheetsRedirectUri(request: Request): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL;
  const base = explicit
    ? explicit.replace(/\/$/, "")
    : originFromHeaders(request);
  return `${base}/api/integrations/meta-lead-ads/google/callback`;
}

function originFromHeaders(request: Request): string {
  const proto = request.headers.get("x-forwarded-proto") ?? "https";
  const host =
    request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  return `${proto}://${host}`;
}

function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/**
 * Create a one-time OAuth state bound to (account, user). Returns the
 * raw state to put in the consent URL; only its hash is stored.
 */
export async function createSheetsOAuthState(
  db: SupabaseClient,
  args: { accountId: string; userId: string },
): Promise<string> {
  const raw = crypto.randomBytes(32).toString("hex");
  const stateHash = sha256Hex(raw);
  const { error } = await db.from("meta_lead_sheets_oauth_states").insert({
    state_hash: stateHash,
    account_id: args.accountId,
    user_id: args.userId,
    expires_at: new Date(Date.now() + STATE_TTL_MS).toISOString(),
  });
  if (error) throw error;
  return raw;
}

/** Atomically consume an unexpired state. Null = replayed/expired/unknown. */
export async function consumeSheetsOAuthState(
  db: SupabaseClient,
  rawState: string,
): Promise<{ accountId: string; userId: string } | null> {
  const stateHash = sha256Hex(rawState);
  const { data, error } = await db
    .from("meta_lead_sheets_oauth_states")
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

/** Consent URL for the Meta Sheets connection. */
export function buildSheetsAuthUrl(rawState: string, redirectUri: string): string {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: META_SHEETS_GOOGLE_SCOPES,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: rawState,
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
}

/** Exchange an auth code for tokens + account email. */
export async function exchangeSheetsCodeForTokens(
  code: string,
  redirectUri: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  scope: string;
  email: string | null;
}> {
  const res = await fetchImpl(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) {
    throw new Error(`Google token exchange failed: ${await res.text()}`);
  }
  const data = (await res.json()) as TokenResponse;
  if (!data.refresh_token) {
    throw new Error(
      "Google did not return a refresh token. Revoke the app's access in your Google account and reconnect.",
    );
  }
  let email: string | null = null;
  try {
    const me = await fetchImpl(USERINFO_ENDPOINT, {
      headers: { Authorization: `Bearer ${data.access_token}` },
    });
    if (me.ok) {
      const body = (await me.json()) as { email?: string };
      email = body.email ?? null;
    }
  } catch {
    email = null;
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: new Date(Date.now() + data.expires_in * 1000),
    scope: data.scope ?? META_SHEETS_GOOGLE_SCOPES,
    email,
  };
}

/** Persist an encrypted Meta Sheets connection (upsert per account). */
export async function saveSheetsConnection(
  db: SupabaseClient,
  accountId: string,
  grant: {
    accessToken: string;
    refreshToken: string;
    expiresAt: Date;
    scope: string;
    email: string | null;
  },
  connectedBy: string | null,
): Promise<void> {
  const { error } = await db.from("meta_lead_sheets_connections").upsert(
    {
      account_id: accountId,
      google_email: grant.email,
      access_token: encrypt(grant.accessToken),
      refresh_token: encrypt(grant.refreshToken),
      token_expiry: grant.expiresAt.toISOString(),
      scope: grant.scope,
      connected_by: connectedBy,
      last_error: null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "account_id" },
  );
  if (error) throw error;
}

export class SheetsAuthError extends Error {
  readonly code = "needs_reauth" as const;
}

/**
 * Throttled Google endpoint (token refresh or Sheets API) — the
 * drain backs off and retries; never a re-auth signal. Carries
 * the server's Retry-After when provided.
 */
export class SheetsQuotaError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | null;
  constructor(
    message: string,
    opts: { status?: number; retryAfterMs?: number | null } = {},
  ) {
    super(message);
    this.name = "SheetsQuotaError";
    this.status = opts.status ?? 429;
    this.retryAfterMs = opts.retryAfterMs ?? null;
  }
}

function safeHeader(res: Response, name: string): string | null {
  try {
    return res.headers?.get(name) ?? null;
  } catch {
    return null;
  }
}

/**
 * Valid access token for the account's Meta Sheets connection.
 * Refreshes + persists when expired. Throws SheetsAuthError when
 * there is no connection or the refresh fails (expired/revoked).
 * Never returns a token for another account (account_id filter).
 */
export async function getSheetsAccessToken(
  db: SupabaseClient,
  accountId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const { data, error } = await db
    .from("meta_lead_sheets_connections")
    .select("access_token, refresh_token, token_expiry")
    .eq("account_id", accountId)
    .maybeSingle();
  if (error) throw error;
  const conn = data as {
    access_token: string;
    refresh_token: string;
    token_expiry: string;
  } | null;
  if (!conn) throw new SheetsAuthError("No Google account is connected.");

  if (new Date(conn.token_expiry).getTime() - EXPIRY_SKEW_MS > Date.now()) {
    return decrypt(conn.access_token);
  }

  const refreshToken = decrypt(conn.refresh_token);
  const res = await fetchImpl(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // A throttled/failing token endpoint is NOT a revoked grant:
    // surface it as a quota-style retryable error and leave the
    // stored connection (and its last_error) untouched so the UI
    // never asks for a reconnect over a 429/5xx.
    if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
      throw new SheetsQuotaError(
        `Google token endpoint throttled (${res.status}); retrying with backoff.`,
        { status: res.status, retryAfterMs: parseRetryAfterMs(safeHeader(res, "retry-after")) },
      );
    }
    // Best-effort: record the failure for the settings status, but
    // never let a write denial (e.g. a non-admin caller through an
    // RLS-scoped client) mask the real auth error below.
    try {
      await db
        .from("meta_lead_sheets_connections")
        .update({
          last_error: `Google authorization expired or was revoked (${res.status}). Reconnect Google Sheets.`,
          updated_at: new Date().toISOString(),
        })
        .eq("account_id", accountId);
    } catch (persistErr) {
      console.warn(
        "[meta-sheets] could not persist token refresh failure:",
        persistErr instanceof Error ? persistErr.message : persistErr,
      );
    }
    throw new SheetsAuthError(
      `Google token refresh failed (${res.status}): ${text.slice(0, 200)}`,
    );
  }
  const refreshed = (await res.json()) as TokenResponse;
  const newExpiry = new Date(Date.now() + refreshed.expires_in * 1000);
  // Best-effort persist: an RLS-scoped caller without write rights
  // (member-level reads) still gets a valid token for this request;
  // the next call refreshes again. Owners persist normally.
  try {
    await db
      .from("meta_lead_sheets_connections")
      .update({
        access_token: encrypt(refreshed.access_token),
        token_expiry: newExpiry.toISOString(),
        last_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq("account_id", accountId);
  } catch (persistErr) {
    console.warn(
      "[meta-sheets] could not persist refreshed Google token:",
      persistErr instanceof Error ? persistErr.message : persistErr,
    );
  }
  return refreshed.access_token;
}

/** Remove the Meta Sheets connection (config auto_sync is disabled separately). */
export async function deleteSheetsConnection(
  db: SupabaseClient,
  accountId: string,
): Promise<void> {
  const { error } = await db
    .from("meta_lead_sheets_connections")
    .delete()
    .eq("account_id", accountId);
  if (error) throw error;
}
