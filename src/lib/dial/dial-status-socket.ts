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
import { withAuthTimeout } from '@/lib/auth/auth-errors';

export interface DialStatusUpdate {
  requestId: string;
  status: string;
  expiresAt: string | null;
}

/**
 * Minimal supabase surface this socket needs. Structurally typed (not
 * `SupabaseClient`) so tests can inject a mock and so older/mocked
 * clients missing `getUser`/`onAuthStateChange` degrade gracefully.
 */
export interface DialSocketSupabase {
  auth: {
    getSession: () => Promise<{
      data: { session: { access_token?: string | null } | null };
    }>;
    getUser?: () => Promise<{ data: { user: unknown } }>;
    onAuthStateChange?: (
      callback: (event: string) => void,
    ) => { data: { subscription: { unsubscribe: () => void } } };
  };
}

export interface SubscribeDialStatusOptions {
  /**
   * Injected supabase client (tests). Defaults to the shared browser
   * client from `@/lib/supabase/client`, created lazily so importing
   * this module never constructs a client. No import cycle: that module
   * only depends on cookie-options.
   */
  supabase?: DialSocketSupabase;
}

type Listener = (update: DialStatusUpdate) => void;

const listeners = new Map<string, Set<Listener>>();

let socket: WebSocket | null = null;
let started = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;
let activeGeneration = 0;
// Set on SIGNED_OUT: the socket is closed and auto-reconnect is parked
// until a fresh sign-in/refresh proves a session exists again. Cleared
// by TOKEN_REFRESHED/SIGNED_IN or by an explicit reconnect trigger.
let signedOut = false;
let authSubscribed = false;
let authUnsubscribe: (() => void) | null = null;
let injectedSupabase: DialSocketSupabase | null = null;

const MAX_BACKOFF_MS = 30_000;
/** Bound for the getUser() refresh fallback (mirrors session-recovery). */
const GET_USER_FALLBACK_TIMEOUT_MS = 4000;

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

function getSupabase(): DialSocketSupabase {
  if (injectedSupabase) return injectedSupabase;
  return createClient() as unknown as DialSocketSupabase;
}

async function accessToken(
  supabase?: DialSocketSupabase,
  opts?: { forceServerVerify?: boolean },
): Promise<string | null> {
  const client = supabase ?? getSupabase();
  if (!opts?.forceServerVerify) {
    try {
      const { data } = await client.auth.getSession();
      const token = data.session?.access_token;
      if (typeof token === 'string' && token) return token;
    } catch {
      // Local read failed or hung — fall through to the server check.
    }
  }
  // Local session missing/stale (post-refresh rotation, torn cookie
  // read): one bounded server check. getUser() revalidates against the
  // stored refresh token and lets a just-rotated session recover, so a
  // 4401 close or an empty local read does not stick with a dead token.
  // Never a full login — null stays null and the caller backs off.
  try {
    if (typeof client.auth.getUser !== 'function') return null;
    const { data } = await withAuthTimeout(
      client.auth.getUser(),
      GET_USER_FALLBACK_TIMEOUT_MS,
    );
    // getUser() resolves user:null on failure — only a confirmed user
    // counts. The call itself revalidates via the server (refreshing a
    // just-rotated session as a side effect), so re-read the local
    // session for the fresh access token.
    if (!data.user) return null;
    try {
      const { data: reread } = await client.auth.getSession();
      const refreshed = reread.session?.access_token;
      return typeof refreshed === 'string' && refreshed ? refreshed : null;
    } catch {
      return null;
    }
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
  if (reconnectTimer !== null || signedOut) return;
  const delay = backoffMs(reconnectAttempt);
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, delay);
}

/** Soft reconnect: drop the live socket so the snapshot replays on a
 * fresh connection. Bumps the generation so the old socket's (async)
 * onclose can never schedule a duplicate reconnect, and resets backoff
 * to the fast 1s lane — the trigger was a confirmed token rotation,
 * not a failure. */
function softReconnect(): void {
  let remaining = 0;
  for (const set of listeners.values()) remaining += set.size;
  signedOut = false;
  reconnectAttempt = 0;
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (remaining === 0) return;
  activeGeneration += 1;
  const stale = socket;
  socket = null;
  if (stale) {
    try {
      stale.close(1000, 'token-rotated');
    } catch {
      // onclose still fires (or the socket was already gone).
    }
  }
  void connect();
}

function handleSignedOut(): void {
  signedOut = true;
  activeGeneration += 1;
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (socket) {
    try {
      socket.close(1000, 'signed-out');
    } catch {
      // ignore
    }
    socket = null;
  }
}

function ensureAuthSubscription(supabase: DialSocketSupabase): void {
  if (authSubscribed || typeof window === 'undefined') return;
  authSubscribed = true;
  try {
    if (typeof supabase.auth.onAuthStateChange !== 'function') return;
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'TOKEN_REFRESHED') {
        // Live socket holds the pre-rotation token: reconnect so the
        // handshake re-authenticates with the fresh one.
        if (signedOut) signedOut = false;
        softReconnect();
      } else if (event === 'SIGNED_IN') {
        // Re-login after a parked SIGNED_OUT: prove the session, then go.
        if (signedOut) {
          signedOut = false;
          reconnectAttempt = 0;
          void connect();
        }
      } else if (event === 'SIGNED_OUT') {
        // Confirmed sign-out: close and PARK — no retry loop against a
        // dead session. A later SIGNED_IN/TOKEN_REFRESHED revives us.
        handleSignedOut();
      }
    });
    authUnsubscribe = () => {
      try {
        data.subscription.unsubscribe();
      } catch {
        // ignore
      }
    };
  } catch {
    // Older/mocked clients without auth events: polling-free socket
    // still works, it just won't proactively rotate the token.
  }
}

async function connect(supabase?: DialSocketSupabase): Promise<void> {
  const gen = activeGeneration;
  if (typeof WebSocket === 'undefined' || signedOut) return;
  const url = wsUrl();
  if (!url) return;
  const client = supabase ?? getSupabase();
  const token = await accessToken(client);
  if (gen !== activeGeneration || signedOut) return;
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

  const onGone = (event?: { code?: number }) => {
    if (socket === ws) socket = null;
    if (gen !== activeGeneration || signedOut) return;
    if (event && event.code === 4401) {
      // Sidecar rejected the token (stale post-rotation JWT). The local
      // read would just hand back the same dead token, so force ONE
      // server verify via the getUser() fallback — its round-trip lets a
      // just-rotated session recover — then take the normal backoff lane
      // (no hot retry with the same dead token).
      const refreshClient = client;
      void accessToken(refreshClient, { forceServerVerify: true }).finally(() => {
        if (gen === activeGeneration && !signedOut) scheduleReconnect();
      });
      return;
    }
    scheduleReconnect();
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

function ensureStarted(supabase?: DialSocketSupabase): void {
  const client = supabase ?? getSupabase();
  ensureAuthSubscription(client);
  if (started || typeof window === 'undefined') return;
  started = true;
  activeGeneration += 1;
  reconnectAttempt = 0;
  void connect(client);
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
  listener: Listener,
  options?: SubscribeDialStatusOptions,
): () => void {
  if (!requestId) return () => {};
  if (options?.supabase) injectedSupabase = options.supabase;
  ensureStarted(options?.supabase);
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
    authUnsubscribe?.();
  } catch {
    // ignore
  }
  authUnsubscribe = null;
  authSubscribed = false;
  signedOut = false;
  injectedSupabase = null;
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
