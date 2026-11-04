#!/usr/bin/env node
// ============================================================
// CallVault click-to-dial WebSocket sidecar.
//
// Runs beside the Next.js app on the same host (loopback only).
// nginx proxies wss://<host>/ws/dial here.
//
// Why a sidecar: Next.js route handlers cannot accept a WebSocket
// upgrade. This process owns the upgrade, authenticates the
// Supabase user token, and keeps one live connection per phone
// device (keyed by account + user + device; browsers separately).
//
// Guarantees:
//   * Auth: the Supabase access token must resolve to a user whose
//     profile is agent-or-above. No token, no socket. Browsers use
//     the same check with `?client=browser`; phone and browser
//     sockets are tracked separately and authenticated separately.
//   * Isolation: rows are filtered by account_id AND requested_by.
//     A user can never receive another user's request.
//   * Signal-only: the wire signal carries request ids, never a
//     phone number. The phone fetches the authoritative row via
//     GET /api/v1/dial-requests/{id} — or, on the fast path,
//     receives the server-validated number in a `consume` reply to
//     its own `received` ack (one-time, server-verified, same
//     socket; rejected/missing replies fall back to the GET).
//   * Status fan-out: persisted transitions are pushed to the
//     user's browser sockets as `status` events (plus a
//     `status_snapshot` on every browser connect). Never emitted
//     before the database confirms the transition.
//   * Pending on connect: a reconnect immediately receives every
//     pending, unexpired row for that user. No HTTP polling.
//   * Replay protection: only `pending` rows are sent on connect;
//     `delivered` rows are not replayed, so a reconnect cannot
//     reopen the dialer on every reconnect. Each socket also
//     suppresses duplicate ids.
//   * One socket per device: a newer connection for the SAME
//     (account, user, device) replaces the older one (close 4002).
//     DIFFERENT devices of the same user coexist — there is no
//     user-level replacement (no 4001 takeover). Browser tabs are
//     exempt (display-only, any number per user).
//
// Env:
//   NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY,
//   SUPABASE_SERVICE_ROLE_KEY, DIAL_WS_INTERNAL_SECRET,
//   DIAL_WS_PORT (default 3001), DIAL_WS_HOST (default 127.0.0.1)
// ============================================================

import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { createClient } from '@supabase/supabase-js';

// Node 20 ships no global WebSocket, but the bundled realtime client
// requires a constructor at SupabaseClient construction time — even
// though this process only ever uses REST + auth (never realtime).
// Provide the installed `ws` package as the constructor. No-op on
// Node 22+, where the native WebSocket already exists.
if (typeof globalThis.WebSocket === 'undefined') {
  const { default: NodeWebSocket } = await import('ws');
  globalThis.WebSocket = NodeWebSocket;
}

const PORT = Number(process.env.DIAL_WS_PORT || 3001);
const HOST = process.env.DIAL_WS_HOST || '127.0.0.1';
const INTERNAL_SECRET = process.env.DIAL_WS_INTERNAL_SECRET || '';
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_KEY) {
  console.error('[dial-ws] missing Supabase env (URL / anon / service role)');
  process.exit(1);
}
if (!INTERNAL_SECRET || INTERNAL_SECRET.length < 24) {
  console.error('[dial-ws] DIAL_WS_INTERNAL_SECRET must be set to at least 24 characters');
  process.exit(1);
}

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const AGENT_ROLES = new Set(['owner', 'admin', 'agent']);
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** accountId:userId:deviceId -> phone connection
 *  { ws, userId, accountId, deviceId, sessionId, sent:Set<string> }.
 *  One live socket per device; different devices of the same user
 *  coexist. Dial signals fan out to every live socket of the user;
 *  logout frames target one exact device key. */
const connections = new Map();
/**
 * userId -> Set of browser connections { ws, accountId }.
 * Browsers are display-only: they receive status snapshots + status
 * events, never dial signals, and their messages are never treated
 * as device acks. Multiple tabs per user are fine (no takeover).
 */
const browsers = new Map();

function short(id) {
  return typeof id === 'string' ? id.slice(0, 8) : '????????';
}

function log(message) {
  console.log(`[dial-ws] ${message}`);
}

function warn(message) {
  console.warn(`[dial-ws] ${message}`);
}

function bearer(header) {
  if (typeof header !== 'string') return null;
  const value = header.startsWith('Bearer ')
    ? header.slice('Bearer '.length).trim()
    : header.trim();
  return value || null;
}

/**
 * Browsers cannot set custom headers on the WebSocket handshake,
 * so they send the session token as `?access_token=` (TLS only).
 * The header form (phones) wins when both are present. Tokens are
 * never logged; nginx access logging is disabled for /ws/dial.
 */
function queryToken(url) {
  const t = url.searchParams.get('access_token');
  return typeof t === 'string' && t ? t : null;
}

function secretMatches(header) {
  const presented = Buffer.from(String(header || ''), 'utf8');
  const expected = Buffer.from(INTERNAL_SECRET, 'utf8');
  return (
    presented.length === expected.length && timingSafeEqual(presented, expected)
  );
}

async function authenticate(token) {
  if (!token) return null;
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await userClient.auth.getUser(token);
  const userId = !error ? data?.user?.id : null;
  if (!userId) return null;

  const { data: profile, error: profileError } = await admin
    .from('profiles')
    .select('account_id, account_role')
    .eq('user_id', userId)
    .maybeSingle();
  if (profileError || !profile) return null;
  if (!AGENT_ROLES.has(String(profile.account_role))) return null;
  return {
    userId,
    accountId: String(profile.account_id),
    // Session scope for CallVault remote logout (migration 151).
    // Decoded from the verified bearer only; never logged.
    sessionId: sessionIdFromToken(token),
  };
}

/**
 * GoTrue session_id of a verified access token (base64url payload
 * decode, UUID-shape check). Returns null for opaque/legacy
 * tokens. Mirrors src/lib/auth/callvault-session.ts.
 */
function sessionIdFromToken(token) {
  try {
    if (typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length < 2 || !parts[1]) return null;
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(b64, 'base64').toString('utf8');
    const sid = JSON.parse(json)?.session_id;
    return typeof sid === 'string' && UUID_RE.test(sid) ? sid : null;
  } catch {
    return null;
  }
}

/**
 * Server → phone logout signal. Frame contract (shared with the
 * Android client — do not deviate):
 *   {"type":"logout_device","device_id":"...","session_id":"..."}
 * Duplicate deliveries are idempotent: the phone dedupes by wipe
 * idempotency, so sending the same frame twice is harmless.
 *
 * Handshake path: the socket is closed (4403) right after so a
 * revoked device can never stay registered. Targeted-push path
 * (/internal/logout-device) does NOT close: the phone acks over
 * the same socket ({type:'logout_ack',...}), and the socket is
 * unenrolled when that ack is recorded (or when the phone
 * disconnects — HTTP-acked phones may use the ack endpoint
 * instead). Enforcement for a still-connected revoked socket is
 * the HTTP API gate (fail-closed) plus the handshake gate on
 * reconnect; dial pushes to a wiped phone are inert.
 */
function notifyPhoneLogout(ws, deviceId, sessionId) {
  try {
    if (ws.readyState === 1) {
      ws.send(
        JSON.stringify({ type: 'logout_device', device_id: deviceId, session_id: sessionId })
      );
    }
  } catch {
    // ignore — the close below still unenrolls the socket.
  }
  try {
    ws.close(4403, 'device logged out');
  } catch {
    // ignore
  }
}

/**
 * True when the (user, device) pair is revoked for the session
 * the socket authenticated with. A row is revoked iff
 * revoked_session_id equals its session_id.
 *
 * Fail-OPEN with a warning when the table is missing
 * (pre-migration rollout) or unreadable — deliberately, and
 * differently from the HTTP API gate (fail-closed 503). WHY: a
 * socket carries ids only and reads no data; every data read the
 * phone can make goes through the HTTP gate, which denies on
 * registry outage. Refusing sockets here would brick live dial
 * delivery for healthy devices during a registry blip, while a
 * revoked device learns nothing from a socket alone.
 */
async function isDeviceRevoked(accountId, userId, deviceId, sessionId) {
  if (!sessionId && !deviceId) return false;
  let rows;
  try {
    const { data, error } = await admin
      .from('callvault_devices')
      .select('device_id, session_id, revoked_session_id')
      .eq('account_id', accountId)
      .eq('user_id', userId);
    if (error) throw error;
    rows = data || [];
  } catch (err) {
    warn(`device revocation read failed: ${err?.message || err?.name || 'unknown'} (allowing)`);
    return false;
  }
  for (const row of rows) {
    const revoked =
      typeof row.revoked_session_id === 'string' && row.revoked_session_id;
    if (!revoked) continue;
    if (sessionId && row.revoked_session_id === sessionId) return true;
    if (
      !sessionId &&
      deviceId &&
      row.device_id === deviceId &&
      row.revoked_session_id === row.session_id
    ) {
      return true;
    }
  }
  return false;
}

// Logout push: POST /internal/logout-device (see the HTTP handler
// below) sends the logout_device frame to one exact device key.
// Mid-session enforcement is the HTTP API gate (fail-closed: every
// device request re-checks) plus the phone's status polling; the
// sidecar enforces at handshake (4403 + logout_device) so a
// revoked device can never (re)register, and unenrolls sockets on
// logout_ack.

function buildEvent(row) {
  return {
    type: 'dial_request',
    event_id: randomUUID(),
    request_id: row.id,
    expires_at: row.expires_at,
    created_at: row.created_at,
    sent_at: new Date().toISOString(),
  };
}

function isLive(row, nowMs = Date.now()) {
  const ms = Date.parse(row.expires_at);
  return row.status === 'pending' && Number.isFinite(ms) && ms > nowMs;
}

/**
 * Display status for browser snapshots: a row the DB still stores as
 * pending/delivered but whose TTL has passed reads as expired. This
 * is a read-time mapping only — persistence of expiry stays with the
 * explicit read paths (lazy expiry on GET).
 */
function displayStatus(row, nowMs = Date.now()) {
  if (
    (row.status === 'pending' || row.status === 'delivered') &&
    !isLiveExpiry(row.expires_at, nowMs)
  ) {
    return 'expired';
  }
  return row.status;
}

function isLiveExpiry(expiresAt, nowMs = Date.now()) {
  const ms = Date.parse(expiresAt);
  return Number.isFinite(ms) && ms > nowMs;
}

function sendRow(connection, row) {
  if (!connection || connection.ws.readyState !== 1) return false;
  if (!isLive(row)) return false;
  if (connection.sent.has(row.id)) return false;
  connection.sent.add(row.id);
  while (connection.sent.size > 100) {
    connection.sent.delete(connection.sent.values().next().value);
  }
  connection.ws.send(JSON.stringify(buildEvent(row)));
  log(
    `sent ${short(row.id)} to user ${short(connection.userId)} device ${short(connection.deviceId)}`
  );
  return true;
}

async function loadPending(userId, accountId) {
  const { data, error } = await admin
    .from('dial_requests')
    .select('id, status, expires_at, created_at')
    .eq('account_id', accountId)
    .eq('requested_by', userId)
    .eq('status', 'pending')
    .gte('expires_at', new Date().toISOString())
    .order('created_at', { ascending: true })
    .limit(10);
  if (error) {
    warn(`pending read failed: ${error.message}`);
    return [];
  }
  return (data || []).filter((row) => isLive(row));
}

/** Recent requests for a browser snapshot, any status (display only). */
async function loadRecent(userId, accountId, limit = 20) {
  const { data, error } = await admin
    .from('dial_requests')
    .select('id, status, expires_at, created_at')
    .eq('account_id', accountId)
    .eq('requested_by', userId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    warn(`recent read failed: ${error.message}`);
    return [];
  }
  return data || [];
}

/**
 * Push a status event to every browser socket of the user. Returns
 * the number of sockets that accepted it. Browsers apply updates
 * idempotently keyed by (request_id, status).
 */
function sendStatusToBrowsers(userId, accountId, requestId, status) {
  const set = browsers.get(userId);
  if (!set || set.size === 0) return 0;
  const text = JSON.stringify({
    type: 'status',
    request_id: requestId,
    status,
    at: new Date().toISOString(),
  });
  let n = 0;
  for (const b of [...set]) {
    if (b.accountId !== accountId) continue;
    if (b.ws.readyState !== 1) {
      set.delete(b);
      continue;
    }
    try {
      b.ws.send(text);
      n++;
    } catch {
      set.delete(b);
    }
  }
  return n;
}

/**
 * Mark a row delivered on the phone's `received` ack. The conditional
 * update (still pending + owned by this user) is the one-time
 * consumption gate: it returns the consumed row (with the validated
 * number for the consume fast path) or null when there is nothing to
 * consume (duplicate, expired, foreign, or reordered id).
 */
async function ackReceived(connection, requestId) {
  const now = new Date().toISOString();
  const { data, error } = await admin
    .from('dial_requests')
    .update({ status: 'delivered', delivered_at: now })
    .eq('id', requestId)
    .eq('account_id', connection.accountId)
    .eq('requested_by', connection.userId)
    .eq('status', 'pending')
    .select('id, phone_number, expires_at, created_at')
    .maybeSingle();
  if (error) {
    warn(`delivered ack ${short(requestId)} failed: ${error.message}`);
    return null;
  }
  if (!data) return null;
  log(`delivered ack ${short(requestId)} user ${short(connection.userId)}`);
  return data;
}

/**
 * Mark a row failed on the phone's `failed` report (undialable
 * number or unusable consume payload). Only pending/delivered rows
 * move; anything else is already terminal.
 */
async function ackFailed(connection, requestId) {
  const { data, error } = await admin
    .from('dial_requests')
    .update({ status: 'failed' })
    .eq('id', requestId)
    .eq('account_id', connection.accountId)
    .eq('requested_by', connection.userId)
    .in('status', ['pending', 'delivered'])
    .select('id, status')
    .maybeSingle();
  if (error) {
    warn(`failed ack ${short(requestId)} failed: ${error.message}`);
    return null;
  }
  if (!data) return null;
  log(`failed ack ${short(requestId)} user ${short(connection.userId)}`);
  return data;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'POST' && url.pathname === '/internal/dial-event') {
    if (!secretMatches(req.headers['x-dial-internal-secret'])) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end('{"error":"unauthorized"}');
      return;
    }
    let body;
    try {
      body = await readJson(req);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end('{"error":"bad json"}');
      return;
    }
    const requestId = String(body?.request_id || '');
    const accountId = String(body?.account_id || '');
    const userId = String(body?.user_id || '');
    if (!UUID_RE.test(requestId) || !UUID_RE.test(accountId) || !UUID_RE.test(userId)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end('{"error":"bad ids"}');
      return;
    }

    const { data: row, error } = await admin
      .from('dial_requests')
      .select('id, status, expires_at, created_at')
      .eq('id', requestId)
      .eq('account_id', accountId)
      .eq('requested_by', userId)
      .maybeSingle();
    if (error) {
      warn(`internal read failed: ${error.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('{"error":"read failed"}');
      return;
    }
    // No row / expired / already handled: accepting is still correct.
    // The phone will get it on connect if it is pending, otherwise not.
    // Fan-out: every live socket of this (account, user) gets the
    // signal — different devices coexist, each with its own
    // dedupe set.
    const targets = [];
    for (const c of connections.values()) {
      if (c.userId === userId && c.accountId === accountId) targets.push(c);
    }
    if (row && isLive(row) && targets.length > 0) {
      let accepted = 0;
      for (const t of targets) {
        if (sendRow(t, row)) accepted += 1;
      }
      if (accepted === 0) {
        log(`no live socket for ${short(requestId)} (queued for connect)`);
      }
    } else {
      log(`no live socket for ${short(requestId)} (queued for connect)`);
    }
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end('{"accepted":true}');
    return;
  }

  // Browser status fan-out for transitions the Next.js app persists
  // itself (opened / failed / cancelled / completed via the v1 ack
  // endpoint). The sidecar re-reads the row and broadcasts only the
  // persisted status — a status event is never emitted for a
  // transition the database did not confirm.
  const ALLOWED_BROADCAST = new Set([
    'pending',
    'delivered',
    'opened',
    'completed',
    'expired',
    'cancelled',
    'failed',
  ]);
  if (req.method === 'POST' && url.pathname === '/internal/status-event') {
    if (!secretMatches(req.headers['x-dial-internal-secret'])) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end('{"error":"unauthorized"}');
      return;
    }
    let body;
    try {
      body = await readJson(req);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end('{"error":"bad json"}');
      return;
    }
    const requestId = String(body?.request_id || '');
    const accountId = String(body?.account_id || '');
    const userId = String(body?.user_id || '');
    const status = String(body?.status || '');
    if (
      !UUID_RE.test(requestId) ||
      !UUID_RE.test(accountId) ||
      !UUID_RE.test(userId) ||
      !ALLOWED_BROADCAST.has(status)
    ) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end('{"error":"bad payload"}');
      return;
    }
    const { data: row, error } = await admin
      .from('dial_requests')
      .select('id, status')
      .eq('id', requestId)
      .eq('account_id', accountId)
      .eq('requested_by', userId)
      .maybeSingle();
    if (error) {
      warn(`internal status read failed: ${error.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('{"error":"read failed"}');
      return;
    }
    if (row && row.status) {
      const n = sendStatusToBrowsers(userId, accountId, requestId, String(row.status));
      log(`status ${short(requestId)} -> ${String(row.status)} to ${n} browser(s)`);
    }
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end('{"accepted":true}');
    return;
  }

  // Targeted remote-logout push for one exact device. The Next.js
  // revoke routes call this AFTER committing the DB revocation
  // (persisted-first): an offline phone (no live socket here)
  // still enforces on reconnect via the handshake gate + status
  // polling. Duplicate deliveries are idempotent — the phone
  // dedupes by wipe idempotency, so resending is harmless.
  //
  // The socket is NOT closed here: the phone acks over this same
  // socket ({type:'logout_ack',...}), and unenrolment happens when
  // that ack is recorded (or on disconnect).
  if (req.method === 'POST' && url.pathname === '/internal/logout-device') {
    if (!secretMatches(req.headers['x-dial-internal-secret'])) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end('{"error":"unauthorized"}');
      return;
    }
    let body;
    try {
      body = await readJson(req);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end('{"error":"bad json"}');
      return;
    }
    const accountId = String(body?.account_id || '');
    const userId = String(body?.user_id || '');
    const deviceId = String(body?.device_id || '')
      .replace(/[^A-Za-z0-9._-]/g, '')
      .slice(0, 64);
    const rawSession = body?.session_id;
    const sessionId =
      rawSession === null || rawSession === undefined || rawSession === ''
        ? null
        : String(rawSession);
    if (
      !UUID_RE.test(accountId) ||
      !UUID_RE.test(userId) ||
      !deviceId ||
      (sessionId !== null && !UUID_RE.test(sessionId))
    ) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end('{"error":"bad ids"}');
      return;
    }
    // Exact-identity lookup only — never match on user alone, or
    // one device's logout would wipe a sibling device.
    const connection = connections.get(`${accountId}:${userId}:${deviceId}`);
    // When the revoked session is known, the live socket must hold
    // it; a socket on a different (healed) session is left alone.
    const sessionMatches =
      sessionId === null ||
      !connection?.sessionId ||
      connection.sessionId === sessionId;
    let delivered = false;
    if (connection && connection.ws.readyState === 1 && sessionMatches) {
      try {
        connection.ws.send(
          JSON.stringify({ type: 'logout_device', device_id: deviceId, session_id: sessionId })
        );
        delivered = true;
        log(`logout sent to device ${short(deviceId)}`);
      } catch {
        delivered = false;
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ delivered }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/healthz') {
    let browserSockets = 0;
    for (const set of browsers.values()) browserSockets += set.size;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        connections: connections.size,
        browsers: browserSockets,
      })
    );
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end('{"error":"not found"}');
});

function readJson(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > limit) {
        reject(new Error('too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (url.pathname !== '/ws/dial') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', async (ws, req) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const token = bearer(req.headers.authorization) || queryToken(url);
  const auth = await authenticate(token);
  if (!auth) {
    warn('rejected socket: missing/invalid session');
    ws.close(4401, 'unauthorized');
    return;
  }

  // Browser tabs identify with ?client=browser. They are display-only:
  // no takeover, no dial signals, and their messages are never acked.
  const isBrowser = String(url.searchParams.get('client') || '') === 'browser';
  if (isBrowser) {
    const browser = { ws, userId: auth.userId, accountId: auth.accountId };
    let set = browsers.get(auth.userId);
    if (!set) {
      set = new Set();
      browsers.set(auth.userId, set);
    }
    set.add(browser);
    log(`browser connected user ${short(auth.userId)} tabs=${set.size}`);

    ws.on('message', () => {
      // Display-only channel: browser frames carry no meaning.
    });
    ws.on('close', (code) => {
      const current = browsers.get(auth.userId);
      if (current) {
        current.delete(browser);
        if (current.size === 0) browsers.delete(auth.userId);
      }
      log(`browser closed user ${short(auth.userId)} code ${code}`);
    });
    ws.on('error', (err) => {
      warn(`browser socket error user ${short(auth.userId)}: ${err.name}`);
    });

    ws.send(JSON.stringify({ type: 'ready', server_time: new Date().toISOString() }));

    const recent = await loadRecent(auth.userId, auth.accountId);
    const nowMs = Date.now();
    ws.send(
      JSON.stringify({
        type: 'status_snapshot',
        requests: recent.map((row) => ({
          id: row.id,
          status: displayStatus(row, nowMs),
          expires_at: row.expires_at,
          created_at: row.created_at,
        })),
        sent_at: new Date(nowMs).toISOString(),
      })
    );
    log(`snapshot user ${short(auth.userId)} rows=${recent.length}`);
    return;
  }

  const rawDevice = String(url.searchParams.get('device_id') || 'unknown');
  const deviceId = rawDevice.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64) || 'unknown';

  // CallVault remote logout (migration 151): a revoked
  // (user, device, session) pair never registers. The HTTP API
  // gate denies the same session even without a device header.
  if (await isDeviceRevoked(auth.accountId, auth.userId, deviceId, auth.sessionId)) {
    warn(`rejected socket: revoked device user ${short(auth.userId)}`);
    notifyPhoneLogout(ws, deviceId, auth.sessionId);
    return;
  }

  // Per-device replacement: only the SAME (account, user, device)
  // is taken over (4002). A different device_id coexists — the old
  // user-level 4001 replacement is gone, so two phones of one user
  // stay connected at once.
  const key = `${auth.accountId}:${auth.userId}:${deviceId}`;
  const previous = connections.get(key);
  if (previous && previous.ws !== ws) {
    try {
      previous.ws.close(4002, 'replaced by a newer connection');
    } catch {
      // ignore
    }
  }

  const connection = {
    ws,
    userId: auth.userId,
    accountId: auth.accountId,
    deviceId,
    // GoTrue session this socket authenticated with (verified
    // token only). The logout push + logout_ack handlers verify
    // against it; null for opaque/legacy tokens.
    sessionId: auth.sessionId,
    sent: new Set(),
  };
  connections.set(key, connection);
  log(`connected user ${short(auth.userId)} device ${short(deviceId)}`);

  ws.on('message', async (raw) => {
    if (typeof raw !== 'string' && !Buffer.isBuffer(raw)) return;
    const text = raw.toString('utf8');
    if (text.length > 2048) return;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (message?.type === 'received') {
      const requestId = String(message.request_id || '');
      if (!UUID_RE.test(requestId)) return;
      const consumed = await ackReceived(connection, requestId);
      if (consumed) {
        // One-time consume: the row is now delivered. Answer on the
        // same socket with the validated number (fast path) and fan
        // the persisted status out to browser tabs.
        ws.send(
          JSON.stringify({
            type: 'consume',
            request_id: consumed.id,
            phone_number: consumed.phone_number,
            expires_at: consumed.expires_at,
            created_at: consumed.created_at,
            sent_at: new Date().toISOString(),
          })
        );
        sendStatusToBrowsers(
          connection.userId,
          connection.accountId,
          consumed.id,
          'delivered'
        );
      } else {
        ws.send(JSON.stringify({ type: 'consume_rejected', request_id: requestId }));
      }
      return;
    }
    if (message?.type === 'failed') {
      const requestId = String(message.request_id || '');
      if (!UUID_RE.test(requestId)) return;
      const failed = await ackFailed(connection, requestId);
      if (failed) {
        sendStatusToBrowsers(connection.userId, connection.accountId, requestId, 'failed');
      }
      return;
    }
    if (message?.type === 'logout_ack') {
      // Phone confirms it honoured the remote logout:
      // {type:'logout_ack', device_id, session_id}. Validated
      // against the SENDING connection's identity (device must be
      // this socket's device; session must match when known), then
      // stamped on that exact row. Best-effort: failures are
      // logged, never fatal — the phone may also ack over HTTP.
      const ackDevice = String(message.device_id || '')
        .replace(/[^A-Za-z0-9._-]/g, '')
        .slice(0, 64);
      const ackSession =
        typeof message.session_id === 'string' ? message.session_id : '';
      if (!ackDevice || ackDevice !== connection.deviceId) return;
      if (!UUID_RE.test(ackSession)) return;
      if (connection.sessionId && connection.sessionId !== ackSession) return;
      try {
        const { error } = await admin
          .from('callvault_devices')
          .update({ logout_ack_at: new Date().toISOString() })
          .eq('account_id', connection.accountId)
          .eq('user_id', connection.userId)
          .eq('device_id', connection.deviceId);
        if (error) {
          warn(`logout ack store failed: ${error.message}`);
        } else {
          log(`logout ack device ${short(connection.deviceId)}`);
        }
      } catch (err) {
        warn(`logout ack store failed: ${err?.message || err?.name || 'unknown'}`);
      }
      // Confirmed out: unenroll so the revoked session's socket
      // can never receive another signal.
      try {
        ws.close(4403, 'device logged out');
      } catch {
        // ignore
      }
    }
  });

  ws.on('close', (code) => {
    if (connections.get(key)?.ws === ws) {
      connections.delete(key);
    }
    log(`closed user ${short(auth.userId)} code ${code}`);
  });

  ws.on('error', (err) => {
    warn(`socket error user ${short(auth.userId)}: ${err.name}`);
  });

  ws.send(
    JSON.stringify({
      type: 'ready',
      device_id: deviceId,
      server_time: new Date().toISOString(),
    })
  );

  const pending = await loadPending(auth.userId, auth.accountId);
  for (const row of pending) sendRow(connection, row);
  log(
    `ready user ${short(auth.userId)} device ${short(deviceId)} pending=${pending.length}`
  );
});

const heartbeat = setInterval(() => {
  for (const connection of connections.values()) {
    if (connection.ws.readyState === 1) connection.ws.ping();
  }
  for (const set of browsers.values()) {
    for (const b of [...set]) {
      if (b.ws.readyState === 1) {
        b.ws.ping();
      } else {
        set.delete(b);
      }
    }
  }
}, 25_000);

server.listen(PORT, HOST, () => {
  log(`listening on ${HOST}:${PORT} (path /ws/dial)`);
});

function shutdown(signal) {
  log(`shutting down (${signal})`);
  clearInterval(heartbeat);
  for (const connection of connections.values()) {
    try {
      connection.ws.close(1001, 'server shutdown');
    } catch {
      // ignore
    }
  }
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
