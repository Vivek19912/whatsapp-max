#!/usr/bin/env node
// ============================================================
// CallVault click-to-dial WebSocket sidecar.
//
// Runs beside the Next.js app on the same host (loopback only).
// nginx proxies wss://<host>/ws/dial here.
//
// Why a sidecar: Next.js route handlers cannot accept a WebSocket
// upgrade. This process owns the upgrade, authenticates the
// Supabase user token, and keeps one live connection per user.
//
// Guarantees:
//   * Auth: the Supabase access token must resolve to a user whose
//     profile is agent-or-above. No token, no socket.
//   * Isolation: rows are filtered by account_id AND requested_by.
//     A user can never receive another user's request.
//   * Signal-only: the wire event carries request ids, never a
//     phone number. The phone fetches the authoritative row via
//     GET /api/v1/dial-requests/{id}.
//   * Pending on connect: a reconnect immediately receives every
//     pending, unexpired row for that user. No HTTP polling.
//   * Replay protection: only `pending` rows are sent on connect;
//     `delivered` rows are not replayed, so one request cannot
//     reopen the dialer on every reconnect. Each socket also
//     suppresses duplicate ids.
//   * One device per user: a newer connection replaces the older
//     one (close 4001 for another device, 4002 for the same device).
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

/** userId -> { ws, deviceId, accountId, sent:Set<string> } */
const connections = new Map();

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
  return { userId, accountId: String(profile.account_id) };
}

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

async function ackReceived(connection, requestId) {
  const now = new Date().toISOString();
  const { error } = await admin
    .from('dial_requests')
    .update({ status: 'delivered', delivered_at: now })
    .eq('id', requestId)
    .eq('account_id', connection.accountId)
    .eq('requested_by', connection.userId)
    .eq('status', 'pending');
  if (error) {
    warn(`delivered ack ${short(requestId)} failed: ${error.message}`);
  } else {
    log(`delivered ack ${short(requestId)} user ${short(connection.userId)}`);
  }
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
    const connection = connections.get(userId);
    if (row && isLive(row) && connection?.accountId === accountId) {
      sendRow(connection, row);
    } else {
      log(`no live socket for ${short(requestId)} (queued for connect)`);
    }
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end('{"accepted":true}');
    return;
  }

  if (req.method === 'GET' && url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, connections: connections.size }));
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
  const token = bearer(req.headers.authorization);
  const auth = await authenticate(token);
  if (!auth) {
    warn('rejected socket: missing/invalid session');
    ws.close(4401, 'unauthorized');
    return;
  }

  const rawDevice = String(url.searchParams.get('device_id') || 'unknown');
  const deviceId = rawDevice.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64) || 'unknown';

  const previous = connections.get(auth.userId);
  if (previous && previous.ws !== ws) {
    previous.ws.close(
      previous.deviceId === deviceId ? 4002 : 4001,
      'replaced by a newer connection'
    );
  }

  const connection = {
    ws,
    userId: auth.userId,
    accountId: auth.accountId,
    deviceId,
    sent: new Set(),
  };
  connections.set(auth.userId, connection);
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
      if (UUID_RE.test(requestId)) await ackReceived(connection, requestId);
    }
  });

  ws.on('close', (code) => {
    if (connections.get(auth.userId)?.ws === ws) {
      connections.delete(auth.userId);
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
