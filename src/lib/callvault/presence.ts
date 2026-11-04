// ============================================================
// CallVault presence — single source of truth for device
// connectivity timing, mirrored on the Android client.
//
//   HEARTBEAT_INTERVAL_S = 30  — the phone sends
//     {type:'heartbeat', device_id, session_id} over its live
//     dial-ws socket every 30s (and the sidecar touches
//     last_seen_at on every handshake too).
//   DISCONNECT_TIMEOUT_S = 120 — the presence cron
//     (GET /api/callvault/presence-cron, every minute) opens a
//     callvault_device_events row for a non-revoked, non-expired
//     device unseen for this long.
//
// Pure helpers only — no DB, no I/O, no clock reads — so this
// module is unit-testable in the node vitest env. Callers pass
// `now` (server time, ms) explicitly.
//
// Precedence (deliberate, tested):
//   revoked (remote logout)  >  session expired (60d)  >
//   disconnect-timeout. A revoked or expired device NEVER reads
//   as an ordinary disconnect.
// ============================================================

/** Phone heartbeat cadence. Mirrored on Android — keep in sync. */
export const HEARTBEAT_INTERVAL_S = 30;

/** Staleness threshold. Mirrored on Android — keep in sync. */
export const DISCONNECT_TIMEOUT_S = 120;

/** CallVault sessions live 60 days (display/close only — the
 *  monitor never revokes and never touches tokens). */
export const CALLVAULT_SESSION_TTL_MS = 60 * 24 * 60 * 60 * 1000;

export type DevicePresence =
  | 'connected'
  | 'disconnected'
  | 'remote_logout'
  | 'session_expired';

export interface RevocationState {
  revokedAt: string | null;
  revokedSessionId: string | null;
  sessionId: string | null;
}

/** Session-scoped revocation: a row is revoked iff
 *  revoked_session_id equals its session_id (migration 151),
 *  or revoked_at is set. */
export function isRevokedDevice(row: RevocationState): boolean {
  if (typeof row.revokedAt === 'string' && row.revokedAt !== '') return true;
  return (
    typeof row.revokedSessionId === 'string' &&
    row.revokedSessionId !== '' &&
    row.revokedSessionId === row.sessionId
  );
}

/** True when created_at + 60d is before now. */
export function isSessionExpired(
  sessionCreatedAt: string | null,
  nowMs: number,
): boolean {
  const ms = typeof sessionCreatedAt === 'string' ? Date.parse(sessionCreatedAt) : NaN;
  if (!Number.isFinite(ms)) return false;
  return ms + CALLVAULT_SESSION_TTL_MS < nowMs;
}

/**
 * True when the device is stale: last seen more than
 * DISCONNECT_TIMEOUT_S ago. A null/unparseable last_seen means
 * "never reported" (register + every authed path stamp it, so
 * only pre-feature rows lack it) — those read stale.
 * Exactly-at-timeout still counts as connected; staleness is
 * strictly-greater-than.
 */
export function isStale(lastSeenAt: string | null, nowMs: number): boolean {
  const ms = typeof lastSeenAt === 'string' ? Date.parse(lastSeenAt) : NaN;
  if (!Number.isFinite(ms)) return true;
  return nowMs - ms > DISCONNECT_TIMEOUT_S * 1000;
}

export interface ClassifyPresenceInput {
  lastSeenAt: string | null;
  /** Session-scoped revocation (already resolved via isRevokedDevice). */
  revoked: boolean;
  /** Device row created_at (session start, for the 60-day rule). */
  sessionCreatedAt: string | null;
  /** Server time in ms. */
  now: number;
}

/**
 * Server-side presence for one device. Revoked wins over the
 * timeout (an owner-logged-out phone is never "disconnected"),
 * and an aged-out session wins over disconnect (silent history
 * close, never a banner).
 */
export function classifyPresence(input: ClassifyPresenceInput): DevicePresence {
  if (input.revoked) return 'remote_logout';
  if (isSessionExpired(input.sessionCreatedAt, input.now)) return 'session_expired';
  if (isStale(input.lastSeenAt, input.now)) return 'disconnected';
  return 'connected';
}

export interface ShouldCreateEventInput extends ClassifyPresenceInput {
  /** Whether an open (reconnected_at IS NULL) event already
   *  exists for this device. The partial unique index is the
   *  real dedupe under concurrency; this flag lets callers
   *  skip the write attempt entirely. */
  hasOpenEvent: boolean;
}

/**
 * Whether the monitor should open a disconnect event for this
 * device: stale AND neither revoked nor expired AND no open
 * event already. Revoked/expired rows are never alerted
 * (expired closes silently with reason='session_expired').
 */
export function shouldCreateEvent(input: ShouldCreateEventInput): boolean {
  if (input.revoked) return false;
  if (isSessionExpired(input.sessionCreatedAt, input.now)) return false;
  if (input.hasOpenEvent) return false;
  return isStale(input.lastSeenAt, input.now);
}

/**
 * Length of a disconnect episode in ms, floored at 0.
 * Pass reconnectedAtMs=null for an ongoing episode (uses now).
 */
export function disconnectDuration(
  disconnectedAtMs: number,
  reconnectedAtMs: number | null,
  nowMs: number,
): number {
  const end = reconnectedAtMs ?? nowMs;
  const ms = end - disconnectedAtMs;
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}
