// ============================================================
// CallVault session identity — extract the GoTrue session_id
// from an already-VERIFIED bearer token.
//
// The session_id claim is how remote logout stays scoped: the
// owner revokes one (device, session) pair, never the user, and
// the gate denies only bearers carrying that exact session.
// Other sessions on other devices keep working (multi-session
// safety: no signOut with global scope anywhere in this flow).
//
// Pure, unit-testable, no I/O. Never logs the token.
// ============================================================

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Decode the payload of a JWT and return its `session_id` claim
 * when it has a UUID shape, else null. The token must already be
 * verified (getUser / requireDeviceUser) before calling — this
 * function proves nothing, it only reads.
 */
export function sessionIdFromJwt(token: string): string | null {
  try {
    if (typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length < 2 || !parts[1]) return null;
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const json =
      typeof Buffer !== 'undefined'
        ? Buffer.from(padded, 'base64').toString('utf8')
        : atob(padded);
    const payload: unknown = JSON.parse(json);
    const sid =
      payload !== null && typeof payload === 'object'
        ? (payload as Record<string, unknown>).session_id
        : null;
    return typeof sid === 'string' && UUID_RE.test(sid) ? sid : null;
  } catch {
    return null;
  }
}
