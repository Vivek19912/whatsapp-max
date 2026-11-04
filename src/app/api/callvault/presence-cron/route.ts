// ============================================================
// GET /api/callvault/presence-cron — sweep stale CallVault
// devices into callvault_device_events.
//
// Runs every minute from vercel.json. Auth: Bearer
// CALLVAULT_CRON_SECRET with CRON_SECRET fallback (same
// constant-time discipline as /api/flows/cron). Returns counts
// only ({checked, disconnected, expired}) — device ids stay
// server-side.
//
// Fail-closed on infra failure: a dead/unreadable registry
// returns 503 with ZERO writes (the sweep throws before its
// first insert). The live sidecar snapshot is REQUIRED: a
// stale last_seen_at with a fresh heartbeat suppresses the
// event, and an unavailable snapshot fails the cycle with
// zero writes — inability to inspect live connections is
// never proof of disconnection. The monitor never revokes
// and never touches tokens — it only appends event rows.
// ============================================================

import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';

import { supabaseAdmin } from '@/lib/flows/admin-client';
import {
  parseSnapshotEntry,
  runPresenceSweep,
  type SnapshotFetchResult,
} from '@/lib/callvault/presence-sweep';

const SIDECAR_TIMEOUT_MS = 1_500;

function sidecarBaseUrl(): string {
  return (process.env.DIAL_WS_INTERNAL_URL || 'http://127.0.0.1:3001').replace(/\/+$/, '');
}

/**
 * Live-presence snapshot fetch for sweep reconciliation. Uses the
 * existing internal-secret convention (same env + header as the
 * dial-event nudge). Any failure shape — unconfigured, network,
 * non-200, malformed — reports !ok, and the sweep then fails the
 * whole cycle with zero writes rather than risk false alerts.
 */
async function fetchLiveSnapshot(): Promise<SnapshotFetchResult> {
  const secret = process.env.DIAL_WS_INTERNAL_SECRET;
  if (!secret) {
    return { ok: false, reason: 'sidecar secret unconfigured' };
  }
  try {
    const res = await fetch(`${sidecarBaseUrl()}/internal/presence-snapshot`, {
      method: 'GET',
      headers: { 'x-dial-internal-secret': secret },
      signal: AbortSignal.timeout(SIDECAR_TIMEOUT_MS),
    });
    if (!res.ok) {
      return { ok: false, reason: `sidecar HTTP ${res.status}` };
    }
    const payload = (await res.json().catch(() => null)) as {
      connections?: unknown;
    } | null;
    if (!payload || !Array.isArray(payload.connections)) {
      return { ok: false, reason: 'malformed snapshot' };
    }
    const connections = payload.connections
      .map(parseSnapshotEntry)
      .filter((e): e is NonNullable<typeof e> => e !== null);
    return { ok: true, connections };
  } catch (err) {
    const name = err instanceof Error ? err.name : 'Error';
    return { ok: false, reason: `sidecar unreachable (${name})` };
  }
}

export async function GET(request: Request) {
  const expectedSecrets = [
    process.env.CALLVAULT_CRON_SECRET,
    process.env.CRON_SECRET,
  ].filter((secret): secret is string => Boolean(secret));
  if (expectedSecrets.length === 0) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 });
  }
  // Constant-time compare (mirrors /api/flows/cron): the length
  // pre-check leaks only the length, never the secret.
  const authorization = request.headers.get('authorization');
  const supplied =
    request.headers.get('x-cron-secret') ??
    (authorization?.startsWith('Bearer ') ? authorization.slice(7) : '');
  const suppliedBuf = Buffer.from(supplied);
  const authorized = expectedSecrets.some((expected) => {
    const expectedBuf = Buffer.from(expected);
    return (
      suppliedBuf.length === expectedBuf.length &&
      timingSafeEqual(suppliedBuf, expectedBuf)
    );
  });
  if (!authorized) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await runPresenceSweep(supabaseAdmin(), new Date(), fetchLiveSnapshot);
    return NextResponse.json(result);
  } catch (error) {
    // Select/snapshot failed before any write: 503, zero marks.
    // Never mark presence on an infra failure.
    const message = error instanceof Error ? error.message : String(error);
    console.error('[presence-cron] sweep failed:', message);
    return NextResponse.json({ error: 'Presence registry temporarily unavailable' }, { status: 503 });
  }
}
