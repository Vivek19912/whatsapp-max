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
