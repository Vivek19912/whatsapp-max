// ============================================================
// Browser WebSocket client for live dial-request status.
//
// One shared socket per tab (never polled): the sidecar pushes a
// `status_snapshot` on connect and `status` events for every
// persisted transition afterwards, so a Workspace cell flips
// Queued → Delivered → Opened in real time. Reconnects re-fetch
// the snapshot, so no HTTP status read is ever needed.
//
// Security properties (mirrored from the sidecar contract):
//   - the socket is authenticated with the viewer's own Supabase
//     session token, separately from any phone connection;
//   - the server only sends this account+user's rows;
//   - status events are applied only for the subscribed request id,
//     so one lead's cell can never flip another's;
//   - Delivered/Opened are shown ONLY when the server says so —
//     never optimistically, never from a timer.
// ============================================================

import { createClient } from '@/lib/supabase/client';

export interface DialStatusUpdate {
  requestId: string;
  status: string;
  expiresAt: string | null;
}

type Listener = (update: DialStatusUpdate) => void;

const listeners = new Map<string, Set<Listener>>();

let socket: WebSocket | null = null;
let started = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;
let activeGeneration = 0;

const MAX_BACKOFF_MS = 30_000;

function backoffMs(attempt: number): number {
  const capped = Math.min(attempt, 6);
  const base = 1000 * 2 ** capped;
  return Math.min(base, MAX_BACKOFF_MS);
}

function wsUrl(): string | null {
  if (typeof window === 'undefined' || typeof window.location === 'undefined') {
    return null;
  }
  const { protocol, host, hostname } = window.location;
  if (protocol === 'https:') {
    return `wss://${host}/ws/dial?client=browser`;
  }
  if (protocol === 'http:') {
    // Local dev only: plain ws straight at the sidecar.
    return `ws://${hostname}:3001/ws/dial?client=browser`;
  }
  return null;
}

async function accessToken(): Promise<string | null> {
  try {
    const supabase = createClient();
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    return typeof token === 'string' && token ? token : null;
  } catch {
    return null;
  }
}

function dispatch(update: DialStatusUpdate): void {
  const set = listeners.get(update.requestId);
  if (!set || set.size === 0) return;
  for (const listener of [...set]) {
    try {
      listener(update);
    } catch {
      // A throwing cell must not break delivery to other cells.
    }
  }
}

function applySnapshot(requests: unknown): void {
  if (!Array.isArray(requests)) return;
  for (const row of requests) {
    if (!row || typeof row !== 'object') continue;
    const rec = row as Record<string, unknown>;
    // Snapshot rows use `id`; tolerate `request_id` too.
    const requestId = typeof rec.id === 'string' ? rec.id : rec.request_id;
    const status = rec.status;
    const expiresAt = rec.expires_at;
    if (typeof requestId !== 'string' || !requestId || typeof status !== 'string') continue;
    dispatch({
      requestId,
      status,
      expiresAt: typeof expiresAt === 'string' ? expiresAt : null,
    });
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer !== null) return;
  const delay = backoffMs(reconnectAttempt);
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, delay);
}

async function connect(): Promise<void> {
  const gen = activeGeneration;
  if (typeof WebSocket === 'undefined') return;
  const url = wsUrl();
  if (!url) return;
  const token = await accessToken();
  if (gen !== activeGeneration) return;
  if (!token) {
    // No session (signed out): back off and retry; a later login
    // triggers a fresh subscribe → connect cycle anyway.
    scheduleReconnect();
    return;
  }
  // Browsers cannot set custom headers on the WebSocket handshake,
  // so the session token travels as a query parameter over TLS
  // (same bearer discipline as the phone's Authorization header:
  // HTTPS only, never logged — the sidecar never logs request
  // URLs and nginx access logging is disabled for /ws/dial).
  const authed = `${url}&access_token=${encodeURIComponent(token)}`;
  let ws: WebSocket;
  try {
    ws = new WebSocket(authed);
  } catch {
    socket = null;
    scheduleReconnect();
    return;
  }
  socket = ws;
  reconnectAttempt = 0;

  ws.onmessage = (event: MessageEvent) => {
    let message: unknown;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (!message || typeof message !== 'object') return;
    const msg = message as Record<string, unknown>;
    if (msg.type === 'status_snapshot') {
      applySnapshot(msg.requests);
      return;
    }
    if (msg.type === 'status') {
      const requestId = msg.request_id;
      const status = msg.status;
      if (typeof requestId !== 'string' || !requestId || typeof status !== 'string') return;
      dispatch({
        requestId,
        status,
        expiresAt: typeof msg.expires_at === 'string' ? msg.expires_at : null,
      });
    }
  };

  const onGone = () => {
    if (socket === ws) socket = null;
    if (gen === activeGeneration) scheduleReconnect();
  };
  ws.onclose = onGone;
  ws.onerror = () => {
    try {
      ws.close();
    } catch {
      // ignore
    }
  };
}

function ensureStarted(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  activeGeneration += 1;
  reconnectAttempt = 0;
  void connect();
}

function maybeStop(): void {
  let remaining = 0;
  for (const set of listeners.values()) remaining += set.size;
  if (remaining === 0 && socket) {
    try {
      socket.close(1000, 'idle');
    } catch {
      // ignore
    }
    socket = null;
  }
  if (remaining === 0 && reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    reconnectAttempt = 0;
  }
}

/**
 * Subscribe a Workspace cell to live status for one dial request.
 * Updates are idempotent per (requestId, status): repeated events
 * and reconnect snapshots converge on the same label, and multiple
 * tabs each hold their own socket so no tab can action another's.
 */
export function subscribeDialStatus(
  requestId: string,
  listener: Listener
): () => void {
  if (!requestId) return () => {};
  ensureStarted();
  let set = listeners.get(requestId);
  if (!set) {
    set = new Set();
    listeners.set(requestId, set);
  }
  set.add(listener);
  if (socket && socket.readyState !== WebSocket.OPEN) {
    // Socket is (re)connecting — the snapshot on open will
    // immediately bring this cell up to date.
  }
  return () => {
    const current = listeners.get(requestId);
    if (current) {
      current.delete(listener);
      if (current.size === 0) listeners.delete(requestId);
    }
    maybeStop();
  };
}

/** Test seam: reset module state between tests. */
export function __resetDialStatusSocketForTest(): void {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  try {
    socket?.close();
  } catch {
    // ignore
  }
  socket = null;
  listeners.clear();
  started = false;
  reconnectAttempt = 0;
  activeGeneration += 1;
}
