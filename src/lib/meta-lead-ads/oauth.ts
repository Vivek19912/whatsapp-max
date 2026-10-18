// ============================================================
// Meta Lead Ads — OAuth authorization.
//
// Standard Meta "Facebook Login for Business" code flow:
//   1. Redirect the admin to the versioned consent dialog with a
//      `state` that is BOTH encrypted (confidentiality + integrity,
//      via the shared AES-256-GCM helper) AND bound to a random
//      nonce we also drop in an httpOnly cookie. The callback
//      requires the decrypted account to match the signed-in admin
//      AND the nonce to match the cookie — that is the CSRF check.
//   2. Exchange the one-time `code` for a short-lived user token,
//      then for a long-lived (~60 day) user token.
//   3. Page tokens are obtained separately (listPages) and stored
//      alongside; long-lived Page tokens do not expire, so there is
//      no refresh loop — expiry of the user token surfaces as
//      `needs_reauth`.
//
// Nothing here ever exposes a token to the browser: the tokens live
// only in server memory during the callback and at rest encrypted.
// ============================================================

import crypto from "node:crypto";

import { encrypt, decrypt } from "@/lib/whatsapp/encryption";

import {
  META_LEAD_ADS_SCOPES,
  graphBase,
  oauthBase,
  type MetaLeadAdsConfig,
} from "./config";
import { MetaLeadAdsError } from "./errors";

export const OAUTH_STATE_COOKIE = "meta_lead_ads_oauth_state";
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

interface StatePayload {
  /** account id */
  a: string;
  /** random nonce, mirrored in the httpOnly cookie */
  n: string;
  /** issued-at ms */
  t: number;
}

export function newStateNonce(): string {
  return crypto.randomBytes(16).toString("hex");
}

/** Encrypt {account, nonce, issuedAt} as the OAuth `state`. */
export function encodeOAuthState(
  accountId: string,
  nonce: string,
  now: number = Date.now(),
): string {
  const payload: StatePayload = { a: accountId, n: nonce, t: now };
  return encrypt(JSON.stringify(payload));
}

/**
 * Decrypt + validate the OAuth `state`. Throws MetaLeadAdsError with
 * `bad_state`/`expired_state` so the callback can map it to a clear
 * error. Never trusts the payload beyond the encryption boundary.
 */
export function parseOAuthState(
  state: string,
  now: number = Date.now(),
  ttlMs: number = OAUTH_STATE_TTL_MS,
): { accountId: string; nonce: string } {
  let payload: StatePayload;
  try {
    payload = JSON.parse(decrypt(state)) as StatePayload;
  } catch {
    throw new MetaLeadAdsError("bad_state", "OAuth state could not be verified.");
  }
  if (
    !payload ||
    typeof payload.a !== "string" ||
    typeof payload.n !== "string" ||
    typeof payload.t !== "number"
  ) {
    throw new MetaLeadAdsError("bad_state", "OAuth state could not be verified.");
  }
  if (now - payload.t > ttlMs || payload.t > now + 60_000) {
    throw new MetaLeadAdsError("expired_state", "This authorization link has expired. Please try again.");
  }
  return { accountId: payload.a, nonce: payload.n };
}

/** The versioned consent dialog URL. */
export function buildAuthUrl(
  config: MetaLeadAdsConfig,
  accountId: string,
  redirectUri: string,
  nonce: string,
): string {
  const params = new URLSearchParams({
    client_id: config.appId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: META_LEAD_ADS_SCOPES.join(","),
    state: encodeOAuthState(accountId, nonce),
  });
  return `${oauthBase(config.graphVersion)}?${params.toString()}`;
}

interface TokenExchangeResponse {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
}

export interface UserTokenGrant {
  accessToken: string;
  expiresAt: Date | null;
}

async function requestUserToken(
  config: MetaLeadAdsConfig,
  params: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<TokenExchangeResponse> {
  const url = new URL(`${graphBase(config.graphVersion)}/oauth/access_token`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetchImpl(url.toString());
  const text = await res.text();
  let body: TokenExchangeResponse & { error?: { message?: string } } = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = {};
  }
  if (!res.ok || !body.access_token) {
    // Deliberately drop the raw body from the message (may contain
    // token fragments); the exchange failure is what matters.
    throw new MetaLeadAdsError(
      "exchange_failed",
      body.error?.message ?? "Meta authorization failed.",
      502,
    );
  }
  return body;
}

/** Exchange the one-time auth code for a short-lived user token. */
export async function exchangeCodeForUserToken(
  config: MetaLeadAdsConfig,
  code: string,
  redirectUri: string,
  fetchImpl: typeof fetch = fetch,
): Promise<UserTokenGrant> {
  const body = await requestUserToken(
    config,
    {
      client_id: config.appId,
      client_secret: config.appSecret,
      redirect_uri: redirectUri,
      code,
    },
    fetchImpl,
  );
  return {
    accessToken: body.access_token as string,
    expiresAt:
      typeof body.expires_in === "number"
        ? new Date(Date.now() + body.expires_in * 1000)
        : null,
  };
}

/** Upgrade a short-lived user token to a long-lived (~60 day) token. */
export async function exchangeForLongLivedUserToken(
  config: MetaLeadAdsConfig,
  shortLivedToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<UserTokenGrant> {
  const body = await requestUserToken(
    config,
    {
      grant_type: "fb_exchange_token",
      client_id: config.appId,
      client_secret: config.appSecret,
      fb_exchange_token: shortLivedToken,
    },
    fetchImpl,
  );
  return {
    accessToken: body.access_token as string,
    expiresAt:
      typeof body.expires_in === "number"
        ? new Date(Date.now() + body.expires_in * 1000)
        : null,
  };
}
