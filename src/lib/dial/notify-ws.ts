// ============================================================
// Server → WebSocket sidecar notification.
//
// The dial-request POST does not push the request over HTTP to a
// phone. It inserts the durable row, then nudges the local
// WebSocket sidecar (scripts/dial-ws-server.mjs) with only the
// request/account/user ids. The sidecar reads the row itself and
// emits the data-minimal signal.
//
// This is an internal, loopback-only call protected by a shared
// secret. It is fire-and-forget: a sidecar outage must never fail
// or delay creating the dial request. A phone that connects later
// receives the still-pending row on connect.
//
// There is no HTTP polling in this path.
// ============================================================

export interface DialNotificationTarget {
  id: string;
  account_id: string;
  requested_by: string;
  status: string;
  expires_at: string;
  created_at: string;
}

const DEFAULT_URL = 'http://127.0.0.1:3001';
const NOTIFY_TIMEOUT_MS = 1_500;

let missingConfigWarned = false;

function internalUrl(): string {
  return (process.env.DIAL_WS_INTERNAL_URL || DEFAULT_URL).replace(/\/+$/, '');
}

/**
 * Nudges the sidecar. Returns true only when it accepted the event.
 * Never throws and never includes a phone number in a log line.
 */
export async function notifyDialRequest(
  target: DialNotificationTarget
): Promise<boolean> {
  const secret = process.env.DIAL_WS_INTERNAL_SECRET;
  if (!secret) {
    if (!missingConfigWarned) {
      missingConfigWarned = true;
      console.warn(
        '[dial-ws] DIAL_WS_INTERNAL_SECRET not set — live delivery disabled; pending rows will be sent when a device connects'
      );
    }
    return false;
  }

  try {
    const res = await fetch(`${internalUrl()}/internal/dial-event`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-dial-internal-secret': secret,
      },
      body: JSON.stringify({
        request_id: target.id,
        account_id: target.account_id,
        user_id: target.requested_by,
      }),
      signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[dial-ws] sidecar rejected event: HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    // Sanitized: class/name only. The ids stay out of error logs too.
    const name = err instanceof Error ? err.name : 'Error';
    console.warn(`[dial-ws] sidecar unreachable (${name}); request stays pending`);
    return false;
  }
}

export interface DialStatusTarget {
  id: string;
  account_id: string;
  requested_by: string;
  status: string;
}/**
 * Tells the sidecar about a transition the app just persisted
 * (opened / failed / cancelled / completed from the v1 ack path).
 * The sidecar re-reads the row and broadcasts only the persisted
 * status to the user's browser sockets — browser cells therefore
 * never display Delivered/Opened before the database confirms it.
 *
 * Same fire-and-forget discipline as the dial nudge: never throws,
 * never logs phone numbers or ids beyond a prefix.
 */
export async function notifyDialStatus(
  target: DialStatusTarget
): Promise<boolean> {
  const secret = process.env.DIAL_WS_INTERNAL_SECRET;
  if (!secret) {
    return false;
  }

  try {
    const res = await fetch(`${internalUrl()}/internal/status-event`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-dial-internal-secret': secret,
      },
      body: JSON.stringify({
        request_id: target.id,
        account_id: target.account_id,
        user_id: target.requested_by,
        status: target.status,
      }),
      signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[dial-ws] sidecar status event rejected: HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    const name = err instanceof Error ? err.name : 'Error';
    console.warn(`[dial-ws] sidecar status unreachable (${name})`);
    return false;
  }
}

export interface DeviceLogoutTarget {
  account_id: string;
  user_id: string;
  device_id: string;
  session_id: string | null;
}

/**
 * Nudges the sidecar to push a `logout_device` frame to the exact
 * live phone socket (account + user + device). Persisted-first:
 * callers invoke this AFTER the DB revocation commit, so an
 * offline phone still enforces on reconnect/status-poll. Same
 * fire-and-forget discipline as the dial nudge: never throws,
 * never logs ids beyond the outcome.
 */
export async function notifyDeviceLogout(
  target: DeviceLogoutTarget
): Promise<boolean> {
  const secret = process.env.DIAL_WS_INTERNAL_SECRET;
  if (!secret) {
    return false;
  }

  try {
    const res = await fetch(`${internalUrl()}/internal/logout-device`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-dial-internal-secret': secret,
      },
      body: JSON.stringify({
        account_id: target.account_id,
        user_id: target.user_id,
        device_id: target.device_id,
        session_id: target.session_id,
      }),
      signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[dial-ws] sidecar logout event rejected: HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    const name = err instanceof Error ? err.name : 'Error';
    console.warn(`[dial-ws] sidecar logout unreachable (${name})`);
    return false;
  }
}
