// ============================================================
// Dial WebSocket event contract.
//
// The wire event is a SIGNAL, not the data. It carries only the
// request id (plus timing metadata) so a phone must fetch the
// authoritative row through the authenticated API before it can
// dial. The phone number is deliberately absent: a compromised
// WebSocket payload can never choose the number.
//
// Pure + exported so the route, the socket server and the unit
// tests share one shape.
// ============================================================

import { randomUUID } from 'node:crypto';

export interface DialRequestSignalRow {
  id: string;
  status: string;
  expires_at: string;
  created_at: string;
}

export interface DialWsEvent {
  type: 'dial_request';
  /** Unique per delivery attempt; lets a client suppress replays. */
  event_id: string;
  request_id: string;
  expires_at: string;
  created_at: string;
  sent_at: string;
}

export interface BuildDialWsEventOptions {
  /** Injectable for deterministic tests. */
  eventId?: string;
  /** Injectable for deterministic tests. */
  nowMs?: number;
}

/**
 * Builds the data-minimal signal sent over the socket.
 *
 * Throws only when the row has no usable id — callers should treat
 * that as "nothing to send", never as a reason to log the row.
 */
export function buildDialWsEvent(
  row: DialRequestSignalRow,
  opts: BuildDialWsEventOptions = {}
): DialWsEvent {
  const id = typeof row.id === 'string' ? row.id.trim() : '';
  if (!id) throw new Error('dial request id is required');
  const nowMs = opts.nowMs ?? Date.now();
  return {
    type: 'dial_request',
    event_id: opts.eventId ?? randomUUID(),
    request_id: id,
    expires_at: row.expires_at,
    created_at: row.created_at,
    sent_at: new Date(nowMs).toISOString(),
  };
}

/** True when the ISO instant is still in the future (unparseable → not live). */
export function isLiveExpiry(expiresAt: string, nowMs: number = Date.now()): boolean {
  const ms = Date.parse(expiresAt);
  return Number.isFinite(ms) && ms > nowMs;
}

/**
 * Rows a freshly connected device may receive: pending only.
 *
 * Delivered-but-not-opened rows are intentionally excluded. If the
 * app dies after acknowledging receipt, replaying them on every
 * reconnect would reopen the dialer repeatedly for one request —
 * the exact duplicate-delivery failure this contract forbids.
 */
export function isConnectDeliverable(
  row: { status: string; expires_at: string },
  nowMs: number = Date.now()
): boolean {
  return row.status === 'pending' && isLiveExpiry(row.expires_at, nowMs);
}

/**
 * UUID validity for request ids. Shared with the sidecar's own
 * check so both ends reject the same malformed frames.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isDialRequestId(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value.trim());
}

// ============================================================
// Browser status channel (Workspace live updates, no polling).
//
// Desktop browsers hold one authenticated socket each (query
// `?client=browser`). They never receive dial signals and their
// messages are never treated as device acks — the socket is
// display-only. On connect the server sends a `status_snapshot`
// with the user's recent requests; afterwards every persisted
// transition is pushed as a `status` event. A reconnect therefore
// recovers the latest state with no HTTP status reads.
// ============================================================

export interface DialStatusRow {
  id: string;
  status: string;
  expires_at: string;
  created_at: string;
}

export interface DialStatusSnapshot {
  type: 'status_snapshot';
  requests: DialStatusRow[];
  sent_at: string;
}

export interface DialStatusEvent {
  type: 'status';
  request_id: string;
  status: string;
  at: string;
}

/**
 * Server-side effective status for display: a row the server still
 * stores as pending/delivered but whose TTL has passed reads as
 * expired. This is a read-time mapping only — persistence of expiry
 * stays with the explicit read paths (lazy expiry on GET).
 */
export function effectiveDisplayStatus(
  row: { status: string; expires_at: string },
  nowMs: number = Date.now()
): string {
  if (
    (row.status === 'pending' || row.status === 'delivered') &&
    !isLiveExpiry(row.expires_at, nowMs)
  ) {
    return 'expired';
  }
  return row.status;
}

export function buildStatusSnapshot(
  rows: DialStatusRow[],
  opts: { nowMs?: number } = {}
): DialStatusSnapshot {
  const nowMs = opts.nowMs ?? Date.now();
  return {
    type: 'status_snapshot',
    requests: rows
      .filter((row) => typeof row.id === 'string' && row.id.trim())
      .map((row) => ({
        id: row.id,
        status: effectiveDisplayStatus(row, nowMs),
        expires_at: row.expires_at,
        created_at: row.created_at,
      })),
    sent_at: new Date(nowMs).toISOString(),
  };
}

export function buildStatusEvent(
  requestId: string,
  status: string,
  opts: { nowMs?: number } = {}
): DialStatusEvent {
  const id = typeof requestId === 'string' ? requestId.trim() : '';
  if (!id) throw new Error('request id is required');
  const nowMs = opts.nowMs ?? Date.now();
  return {
    type: 'status',
    request_id: id,
    status,
    at: new Date(nowMs).toISOString(),
  };
}

// ============================================================
// Consume fast path (server-validated dial payload over the socket).
//
// Replaces the extra HTTPS GET round trip in the common case: the
// phone's `received` ack atomically consumes the pending row
// server-side, and the server answers on the same socket with the
// validated number. Security properties preserved:
//   - the signal itself still carries no number;
//   - only the owning user's authenticated socket receives a
//     payload, and only for rows the server just verified;
//   - one-time consumption is enforced by the conditional status
//     update (pending → delivered), never by the client;
//   - the phone still validates expiry + dialability before opening.
// A rejected/expired/missing consume falls back to the
// authenticated GET (unchanged behavior).
// ============================================================

export interface DialConsumeReply {
  type: 'consume';
  request_id: string;
  phone_number: string;
  expires_at: string;
  created_at: string;
  sent_at: string;
}

export interface DialConsumeRejected {
  type: 'consume_rejected';
  request_id: string;
}

export function buildConsumeReply(
  row: { id: string; phone_number: string; expires_at: string; created_at: string },
  opts: { nowMs?: number } = {}
): DialConsumeReply {
  const id = typeof row.id === 'string' ? row.id.trim() : '';
  const phone = typeof row.phone_number === 'string' ? row.phone_number.trim() : '';
  if (!id || !phone) throw new Error('consume reply needs an id and a number');
  const nowMs = opts.nowMs ?? Date.now();
  return {
    type: 'consume',
    request_id: id,
    phone_number: phone,
    expires_at: row.expires_at,
    created_at: row.created_at,
    sent_at: new Date(nowMs).toISOString(),
  };
}

export function buildConsumeRejected(requestId: string): DialConsumeRejected {
  const id = typeof requestId === 'string' ? requestId.trim() : '';
  if (!id) throw new Error('request id is required');
  return { type: 'consume_rejected', request_id: id };
}
