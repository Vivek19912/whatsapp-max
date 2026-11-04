// ============================================================
// CallVault device revocation helper — session-scoped check
// shared by the device list route.
//
// NOTE: the former presence/disconnection monitoring helpers
// (heartbeat interval, 120s staleness timeout, disconnect
// episodes) were removed with the disconnection-alert feature.
// This module intentionally keeps ONLY the revocation predicate
// used by Owner remote logout. Session-expiry display math
// lives next to its callers.
// ============================================================

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
