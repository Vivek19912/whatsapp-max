// ============================================================
// Mobile-device user authentication — resolve a Supabase user
// access token (from a logged-in app, e.g. CallVault) into an
// account context.
//
// This is the user-identity counterpart of `requireApiKey`
// (machine credentials → account). Where an API key says "some
// holder of this account's secret", a user token says "this
// specific authenticated user, and transitively their account".
//
// Calling convention — routes that accept uploads from logged-in
// devices do:
//
//   const token = bearerToken(request);
//   const dev = token && !looksLikeApiKey(token)
//     ? await requireDeviceUser(request)   // user session
//     : await requireApiKey(request, 'x'); // machine key (legacy)
//
// Why two clients: the RLS user client proves the token and
// scopes member reads; the service client performs the
// privileged writes (storage upload, catalog insert) exactly as
// the API-key path already does, with the same explicit
// account_id discipline.
// ============================================================

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { supabaseAdmin } from '@/lib/flows/admin-client';
import { sessionIdFromJwt } from '@/lib/auth/callvault-session';
import { hasMinRole, isAccountRole, type AccountRole } from '@/lib/auth/roles';
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import { forbidden, rateLimited, unauthorized, unavailable } from '@/lib/api/v1/respond';

/** Sanitize a device id the same way the dial-ws sidecar does. */
export function sanitizeDeviceId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const clean = raw.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64);
  return clean ? clean : null;
}

export interface DeviceAuthContext {
  /** Discriminant — lets shared logic tell user auth from key auth. */
  authType: 'user';
  /** RLS-scoped client carrying the caller's JWT. */
  supabase: SupabaseClient;
  /** Service-role client for privileged writes (storage, catalog). */
  service: SupabaseClient;
  /** auth.uid() — the actual authenticated user. */
  userId: string;
  /** The account this user belongs to (server-derived, never client input). */
  accountId: string;
  /** The user's role within their account. */
  role: AccountRole;
  /** Display name for attribution surfaces. */
  fullName: string | null;
  /** Auth email (may be null for exotic providers). */
  email: string | null;
  /** Sanitized `x-callvault-device-id` header, or null when absent. */
  deviceId: string | null;
  /** GoTrue session_id decoded from the verified bearer, or null. */
  sessionId: string | null;
}

/**
 * Extract the bearer token from the `Authorization` header.
 * Returns null when absent. Unlike `requireApiKey`, no shape
 * requirement — any non-empty bearer value is a session candidate.
 */
export function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header) return null;
  const value = header.startsWith('Bearer ')
    ? header.slice('Bearer '.length).trim()
    : header.trim();
  return value.length > 0 ? value : null;
}

/**
 * Authenticate a device request bearing a Supabase user access
 * token and authorize recording uploads.
 *
 * Throws an `ApiError` (mapped by `toApiErrorResponse`):
 *   401 unauthorized — no token, invalid/expired session, no profile
 *   403 forbidden    — valid session but role may not upload (viewer)
 *   429 rate_limited — per-user budget exhausted
 *
 * Role rule: recording upload is operational write access, the
 * same bar as sending messages — agent and above. Viewers are
 * read-only and must never gain write access merely by logging
 * in. Owner/admin/agent all pass.
 */
export interface DeviceIdentity {
  /** RLS-scoped client carrying the caller's JWT. */
  userClient: SupabaseClient;
  /** Service-role client for privileged reads. */
  service: SupabaseClient;
  /** auth.uid() — the actual authenticated user. */
  userId: string;
  /** The account this user belongs to (server-derived, never client input). */
  accountId: string;
  /** The user's role within their account. */
  role: AccountRole;
  /** Display name for attribution surfaces. */
  fullName: string | null;
  /** Auth email (may be null for exotic providers). */
  email: string | null;
  /** The verified bearer token (never logged, never persisted). */
  token: string;
}

/**
 * Identity-only device verification: bearer → getUser → membership
 * → role → rate limit, WITHOUT the revocation gate.
 *
 * Used by the revocation-status endpoint, which must stay answerable
 * for revoked sessions: the gate in requireDeviceUser denies them
 * with 401, so routing status through the gate would make the phone
 * unable to ever learn it was revoked.
 */
export async function requireDeviceIdentity(
  request: Request
): Promise<DeviceIdentity> {
  const token = bearerToken(request);
  if (!token) {
    throw unauthorized('Missing credentials');
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) {
    throw unauthorized('Authentication is not configured');
  }

  // The token travels only in this server-side client, which is
  // never persisted (no session storage) and never logged.
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await userClient.auth.getUser();
  const userId = !error ? data.user?.id : undefined;
  if (!userId) {
    // Invalid, expired, or revoked session — indistinguishable on
    // the wire from a missing one, so probes learn nothing.
    throw unauthorized('Invalid or expired session');
  }
  const authEmail =
    typeof data.user?.email === 'string' && data.user.email ? data.user.email : null;

  // Membership + role come from our own profiles row (service-role
  // read: the user JWT itself is proof of authentication, and RLS
  // member-reads would couple this check to policy details).
  // A user with no profile row is not a workspace member.
  const { data: profile, error: profileError } = await supabaseAdmin()
    .from('profiles')
    .select('account_id, account_role, full_name')
    .eq('user_id', userId)
    .maybeSingle();
  const accountId = !profileError
    ? (profile as { account_id?: unknown } | null)?.account_id
    : undefined;
  const role = !profileError
    ? (profile as { account_role?: unknown } | null)?.account_role
    : undefined;
  if (typeof accountId !== 'string' || !isAccountRole(role)) {
    throw unauthorized('Account membership not found');
  }

  if (!hasMinRole(role, 'agent')) {
    throw forbidden('Your WhatsApp Max account does not have permission to upload recordings.');
  }

  const limit = checkRateLimit(`device:${userId}`, RATE_LIMITS.publicApi);
  if (!limit.success) {
    throw rateLimited(limit);
  }

  const fullNameRaw = (profile as { full_name?: unknown } | null)?.full_name;

  return {
    userClient,
    service: supabaseAdmin(),
    userId,
    accountId,
    role,
    fullName:
      typeof fullNameRaw === 'string' && fullNameRaw.trim() ? fullNameRaw.trim() : null,
    email: authEmail,
    token,
  };
}

export async function requireDeviceUser(
  request: Request
): Promise<DeviceAuthContext> {
  const ident = await requireDeviceIdentity(request);

  // CallVault remote logout (migration 151). The session comes
  // from the VERIFIED bearer (decoded above via getUser) — never
  // from client input — so a revoked session is denied even when
  // the caller omits the device header (bypass-proof). A row is
  // revoked iff revoked_session_id equals its session_id; without
  // a session in the token, a device header matching a currently
  // revoked row still denies.
  const sessionId = sessionIdFromJwt(ident.token);
  const deviceId = sanitizeDeviceId(request.headers.get('x-callvault-device-id'));
  if (sessionId || deviceId) {
    await enforceDeviceNotRevoked(ident.accountId, ident.userId, sessionId, deviceId);
    if (deviceId) {
      touchDeviceLastSeen(ident.accountId, ident.userId, deviceId);
    }
  }

  return {
    authType: 'user',
    supabase: ident.userClient,
    service: ident.service,
    userId: ident.userId,
    accountId: ident.accountId,
    role: ident.role,
    fullName: ident.fullName,
    email: ident.email,
    deviceId,
    sessionId,
  };
}

/**
 * Deny (401, same shape as an expired session so probes learn
 * nothing) when any of the caller's device rows is revoked for
 * this session. Fail-closed: when the table is missing
 * (pre-migration rollout) or otherwise unreadable, throw 503
 * `unavailable` — a registry outage must never silently allow a
 * revoked device through. The status endpoint handles its own
 * registry errors separately (it reports instead of gating).
 */
async function enforceDeviceNotRevoked(
  accountId: string,
  userId: string,
  sessionId: string | null,
  deviceId: string | null
): Promise<void> {
  let rows: Array<{
    device_id?: unknown;
    session_id?: unknown;
    revoked_session_id?: unknown;
  }> = [];
  try {
    const { data, error } = await supabaseAdmin()
      .from('callvault_devices')
      .select('device_id, session_id, revoked_session_id')
      .eq('account_id', accountId)
      .eq('user_id', userId);
    if (error) throw error;
    const list = data as typeof rows | null;
    rows = list ?? [];
  } catch (err) {
    // Fail-closed: missing table or any transient read failure
    // denies with 503 so revocation state is never guessed.
    const message = err instanceof Error ? err.message : String(err);
    const code =
      err !== null && typeof err === 'object' && 'code' in err
        ? String((err as Record<string, unknown>).code)
        : '';
    if (code === '42P01' || /does not exist|relation/i.test(message)) {
      console.warn('[device-auth] callvault_devices table missing — denying (503)');
    } else {
      console.warn('[device-auth] revocation check failed (fail-closed):', message);
    }
    throw unavailable('Device registry temporarily unavailable');
  }
  for (const row of rows) {
    const revoked =
      typeof row.revoked_session_id === 'string' && row.revoked_session_id;
    if (!revoked) continue;
    // Revoked iff the token's session equals the row's
    // revoked_session_id — session-scoped, never user-scoped.
    if (sessionId && row.revoked_session_id === sessionId) {
      throw unauthorized('Invalid or expired session');
    }
    // No session in the token (legacy): a device header matching
    // a currently-revoked row still denies.
    if (
      !sessionId &&
      deviceId &&
      row.device_id === deviceId &&
      row.revoked_session_id === row.session_id
    ) {
      throw unauthorized('Invalid or expired session');
    }
  }
}

/**
 * Fire-and-forget last_seen_at touch. Never fails the request:
 * any write error is swallowed (logged at warn at most once per
 * failure — no ids, no tokens).
 */
function touchDeviceLastSeen(
  accountId: string,
  userId: string,
  deviceId: string
): void {
  void (async () => {
    try {
      await supabaseAdmin()
        .from('callvault_devices')
        .update({ last_seen_at: new Date().toISOString() })
        .eq('account_id', accountId)
        .eq('user_id', userId)
        .eq('device_id', deviceId);
    } catch {
      // Best-effort only.
    }
  })();
}
